'use strict';
/**
 * Agent turn orchestration — the Windows D Shift agent loop.
 * Mirrors the original ChatModel loop (recon §2.4): user turn carries
 * <screen> (only when changed) + <memory> (me.md + file list); tool_use
 * blocks are validated, capped per turn, approval-gated where required,
 * results returned in one user message; loop ≤12 iterations; on failure the
 * tab transcript rolls back to before the turn.
 * Upgrades: independent tools run in parallel; screenshot=1/turn and
 * read_screen=3/turn caps kept; use_computer NEVER runs without a user
 * approval round-trip through the host (requestApproval callback).
 */
const MAX_ITER = 12;
const CAPS = { take_screenshot: 1, read_screen: 3, use_computer: 3 };
const SYSTEM_PROMPT = `You are D Shift, a screen-aware sidebar assistant on Windows.
You answer questions about what is on the user's screen and remember them over time.
Rules:
- Prefer read_screen (accessibility text — exact and cheap). Call take_screenshot ONLY when the accessibility text is thin or the question is about images, charts, layout or design. At most one screenshot per question.
- Before answering anything personal, use search_memory. Use write_memory to quietly save durable facts (people -> people/<name>.md, projects -> projects/<name>.md, profile -> me.md, small facts -> notes.md). Never save secrets or transient details. Do not announce memory reads/writes unless asked.
- use_computer hands a self-contained task to Codex. It always needs the user's approval, so write the task as one complete instruction Codex can follow without this conversation.
- Be concise; the user is mid-task in another app.`;

function toolSchemas() {
  const obj = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
  return [
    { name: 'read_screen', description: 'Re-read the focused window accessibility tree (exact text of the screen). Use before answering about the screen.', input_schema: obj({}) },
    { name: 'take_screenshot', description: 'Capture the focused window as an image. LAST RESORT only — when accessibility text is insufficient (images, charts, canvas apps). Max 1 per question.', input_schema: obj({ scope: { type: 'string', enum: ['window', 'screen'] } }) },
    { name: 'search_memory', description: 'Search the local markdown memory folder (ranked). Use before answering anything personal.', input_schema: obj({ query: { type: 'string' } }, ['query']) },
    { name: 'write_memory', description: 'Save a durable fact to a markdown file in the memory folder (append or replace). Paths are confined to the folder.', input_schema: obj({ path: { type: 'string' }, content: { type: 'string' }, mode: { type: 'string', enum: ['append', 'replace'] } }, ['path', 'content']) },
    { name: 'use_computer', description: 'Hand a complete, self-contained task to Codex to operate apps. Always requires user approval. Max 3 per question.', input_schema: obj({ task: { type: 'string' } }, ['task']) },
  ];
}
function validateToolInput(name, input) {
  if (!input || typeof input !== 'object') return 'input must be an object';
  if (name === 'search_memory' && !String(input.query || '').trim()) return 'query is required';
  if (name === 'write_memory' && (!input.path || !input.content)) return 'path and content are required';
  if (name === 'use_computer' && !String(input.task || '').trim()) return 'task is required';
  return null;
}
/**
 * Transcript windowing (audit M9): every turn used to append up to 60k chars
 * of screen text FOREVER, guaranteeing an eventual "prompt too long" 400 and
 * an ever-heavier chats.json. Keep the first turn (identity/context anchor)
 * plus the most recent messages, and never orphan a tool_result whose
 * tool_use was trimmed (an orphan is another 400).
 */
const MAX_TRANSCRIPT_MSGS = 24;
function trimTranscript(tab) {
  const msgs = tab.messages;
  if (!Array.isArray(msgs) || msgs.length <= MAX_TRANSCRIPT_MSGS) return;
  const head = msgs.slice(0, 1);
  let tail = msgs.slice(-(MAX_TRANSCRIPT_MSGS - 1));
  const survivingToolIds = new Set();
  for (const m of tail) if (m.role === 'assistant' && Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool_use') survivingToolIds.add(b.id);
  tail = tail.filter(m => {
    if (m.role === 'user' && Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result')) {
      return m.content.every(b => b.type !== 'tool_result' || survivingToolIds.has(b.tool_use_id));
    }
    return true;
  });
  // a leading assistant message in tail whose user prompt was trimmed is fine;
  // a leading tool_result user message was filtered above.
  tab.messages = [...head, ...tail];
}
/**
 * host: { memory, getScreen(force)->{text,...}, takeScreenshot(scope)->{text,jpegBase64},
 *         requestCodexApproval(task)->Promise<{approved, run()}>, usage(tab, usageObj),
 *         callLLM(args)->Promise<anthropicStream result> }
 */
async function runTurn({ tab, question, images = [], host, onText = () => {}, onTool = () => {} }) {
  const snapshotLen = tab.messages.length;
  const counts = {};
  try {
    const overview = host.memory.overview();
    const memoryBlock = `<memory>\n${overview.me}\n\nMemory files:\n${overview.files.join('\n') || '(none yet)'}\n</memory>`;
    const ctx = await host.getContext(false);
    const screenBlock = ctx && ctx.text ? `<screen app="${ctx.app || ''}" window="${ctx.title || ''}">\n${ctx.text}\n</screen>` : `<screen app="${ctx?.app || ''}" window="${ctx?.title || ''}">(screen text not included — call read_screen if you need it)</screen>`;
    if (images && images.length) {
      // Attachments ride the first user turn as image blocks (his appshot / paste / drop parity)
      tab.messages.push({ role: 'user', content: [
        { type: 'text', text: `${screenBlock}\n${memoryBlock}` },
        ...images.map(data => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })),
        { type: 'text', text: question },
      ] });
    } else {
      tab.messages.push({ role: 'user', content: `${screenBlock}\n${memoryBlock}\n\n${question}` });
    }
    for (let iter = 0; iter < MAX_ITER; iter++) {
      trimTranscript(tab);
      const res = await host.callLLM({ messages: tab.messages, tools: toolSchemas(), onText });
      if (res.usage) host.onUsage?.(res.usage);
      // Prefer the provider's verbatim content blocks (keeps thinking blocks
      // + signatures intact for the next request); fall back to rebuilding.
      let content = Array.isArray(res.content) && res.content.length ? res.content : [];
      if (!content.length) {
        if (res.text) content.push({ type: 'text', text: res.text });
        for (const tu of res.toolUses || []) content.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
      }
      tab.messages.push({ role: 'assistant', content });
      if (!res.toolUses || !res.toolUses.length || res.stopReason === 'end_turn') return { ok: true, text: res.text || '' };
      // execute tools — independent calls in parallel (original runs sequentially)
      const results = await Promise.all(res.toolUses.map(async tu => {
        counts[tu.name] = (counts[tu.name] || 0) + 1;
        const cap = CAPS[tu.name];
        if (cap && counts[tu.name] > cap) return { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: `Limit reached for ${tu.name} this question. Answer with what you have.` };
        const invalid = validateToolInput(tu.name, tu.input);
        if (invalid) return { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: invalid };
        onTool({ id: tu.id, name: tu.name, input: tu.input, status: 'running' });
        try {
          let out;
          if (tu.name === 'read_screen') { const s = await host.getContext(true); out = { text: s?.text || '(no accessibility text — the app may need a screenshot)' }; }
          else if (tu.name === 'take_screenshot') { const s = await host.takeScreenshot(tu.input.scope || 'window'); out = { text: s.text || 'Screenshot captured.', image: s.jpegBase64 }; }
          else if (tu.name === 'search_memory') { const hits = host.memory.search(tu.input.query); out = { text: hits.length ? hits.map(h => `## ${h.file} (score ${h.score})\n${h.snippet}`).join('\n\n') : 'No matches in memory.' }; }
          else if (tu.name === 'write_memory') { const w = host.memory.write(tu.input.path, tu.input.content, tu.input.mode || 'append'); out = { text: `Saved to ${w.rel}.` }; }
          else if (tu.name === 'use_computer') { const r = await host.requestCodexApproval(tu.input.task); out = { text: r.text }; }
          else out = { text: 'unknown tool' };
          onTool({ id: tu.id, name: tu.name, input: tu.input, status: 'done', output: String(out.text || '').slice(0, 2000), image: out.image || null });
          const blocks = [{ type: 'text', text: out.text }];
          if (out.image) blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: out.image } });
          return { type: 'tool_result', tool_use_id: tu.id, content: blocks };
        } catch (e) {
          onTool({ id: tu.id, name: tu.name, input: tu.input, status: 'error', output: String(e.message || e) });
          return { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: String(e.message || e) };
        }
      }));
      tab.messages.push({ role: 'user', content: results });
    }
    return { ok: true, text: '(stopped after 12 steps)' };
  } catch (e) {
    tab.messages.length = snapshotLen; // rollback — never leave a tool_use without its result (original's rule)
    throw e;
  }
}
module.exports = { runTurn, toolSchemas, validateToolInput, SYSTEM_PROMPT, MAX_ITER, CAPS, trimTranscript, MAX_TRANSCRIPT_MSGS };
