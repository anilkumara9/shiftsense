'use strict';
/**
 * LLM clients + agent loop.
 * Anthropic Messages API (streaming SSE, tool-use loop) and an
 * OpenAI-compatible client (covers OpenAI + Ollama at localhost:11434).
 * Beats the original (recon §7.3/§7.5): model is a per-tab setting, not a
 * compile-time constant; transient HTTP failures get ONE retry with backoff
 * instead of rolling back the whole turn; independent tool calls in one
 * block run in PARALLEL; thinking/effort is user-selectable.
 */
/** Provider/model guard (audit M1): a tab keeps its chosen model name when
 *  the user switches provider in the tray — remap to a sane per-provider
 *  default instead of sending claude-* to OpenAI (404) or gpt-* to Anthropic (400). */
function resolveModel(provider, model) {
  const m = String(model || '');
  if (provider === 'anthropic') return m.startsWith('claude') ? m : 'claude-sonnet-5-5';
  if (provider === 'openai') return m.startsWith('gpt') || m.startsWith('o') ? m : 'gpt-5';
  if (provider === 'ollama') { const bare = m.replace(/^ollama[:/]/, ''); return (bare.startsWith('claude') || bare.startsWith('gpt')) ? 'llama3.1' : (bare || 'llama3.1'); }
  return m;
}
function parseSSE(text, onEvent) {
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try { onEvent(JSON.parse(data)); } catch { /* partial line */ }
  }
}
/** Anthropic streaming call. Returns {text, toolUses, usage, stopReason, rawContent}. */
async function anthropicStream({ apiKey, model, system, messages, tools, effort = 'low', maxTokens = 64000, onText, fetchImpl = fetch, signal }) {
  const body = {
    model, max_tokens: maxTokens, stream: true, system,
    messages, tools: tools && tools.length ? tools : undefined,
    cache_control: { type: 'ephemeral' },
    ...(effort && effort !== 'low' ? { output_config: { effort } } : {}),
  };
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
      });
      if (!res.ok) { const t = await res.text().catch(() => ''); throw Object.assign(new Error(`Anthropic ${res.status}: ${t.slice(0, 300)}`), { status: res.status }); }
      const reader = res.body.getReader(); const dec = new TextDecoder();
      let buf = '', text = ''; const toolUses = [];
      const blocks = new Map(); // index -> builder; thinking blocks are kept WITH signatures (audit M7: dropping them can 400 tool-loop follow-ups at medium/high effort)
      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }; let stopReason = null;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split(/\r?\n/); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (ev.type === 'message_start' && ev.message?.usage) { const u = ev.message.usage; usage.input = u.input_tokens || 0; usage.cacheRead = u.cache_read_input_tokens || 0; usage.cacheWrite = u.cache_creation_input_tokens || 0; }
          if (ev.type === 'message_delta') { if (ev.usage) usage.output = ev.usage.output_tokens || usage.output; if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason; }
          if (ev.type === 'content_block_start' && ev.content_block) {
            const cb = ev.content_block;
            blocks.set(ev.index, { type: cb.type, id: cb.id, name: cb.name, text: '', thinking: '', signature: '', json: '' });
          }
          if (ev.type === 'content_block_delta') {
            const b = blocks.get(ev.index); const d = ev.delta || {};
            if (d.type === 'text_delta') { text += d.text; if (b) b.text += d.text; if (onText) onText(d.text); }
            if (d.type === 'thinking_delta' && b) b.thinking += d.thinking || '';
            if (d.type === 'signature_delta' && b) b.signature += d.signature || '';
            if (d.type === 'input_json_delta' && b) b.json += d.partial_json || '';
          }
          if (ev.type === 'content_block_stop') {
            const b = blocks.get(ev.index); if (!b) continue;
            if (b.type === 'tool_use') { let input = {}; try { input = JSON.parse(b.json || '{}'); } catch { /* validated by registry */ } b.input = input; toolUses.push({ id: b.id, name: b.name, input }); }
          }
        }
      }
      const content = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => {
        if (b.type === 'text') return { type: 'text', text: b.text };
        if (b.type === 'thinking') return { type: 'thinking', thinking: b.thinking, signature: b.signature };
        if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} };
        return null;
      }).filter(Boolean);
      return { text, toolUses, usage, stopReason, content };
    } catch (e) {
      lastErr = e;
      if (e.name === 'AbortError' || (e.status && e.status < 500 && e.status !== 429)) throw e;
      if (attempt === 0) await new Promise(r => setTimeout(r, 800));
    }
  }
  throw lastErr;
}
/**
 * Anthropic-style transcript -> OpenAI chat format (and back for tool calls).
 * v1 silently dropped tools on OpenAI/Ollama — the agent loop ran, but the
 * model could never call read_screen/memory there. This translation layer is
 * what makes tools provider-portable. Image blocks become a text note:
 * OpenAI vision input is a different shape and Ollama varies; the tool
 * result text still tells the model a screenshot was taken.
 */
function toOpenAIMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  const textOf = blocks => (Array.isArray(blocks) ? blocks.filter(b => b.type === 'text').map(b => b.text).join('\n') : String(blocks ?? ''));
  for (const m of messages || []) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    if (!Array.isArray(m.content)) continue;
    if (m.role === 'assistant') {
      const tool_calls = m.content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
      out.push({ role: 'assistant', content: textOf(m.content) || null, ...(tool_calls.length ? { tool_calls } : {}) });
    } else {
      const results = m.content.filter(b => b.type === 'tool_result');
      const plain = textOf(m.content);
      if (plain) out.push({ role: 'user', content: plain });
      for (const r of results) {
        const blocks = Array.isArray(r.content) ? r.content : [{ type: 'text', text: String(r.content ?? '') }];
        const txt = blocks.map(b => b.type === 'image' ? '[screenshot image omitted for this provider]' : (b.text || '')).join('\n');
        out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: (r.is_error ? 'ERROR: ' : '') + txt });
      }
      if (!results.length && !plain) out.push({ role: 'user', content: '' });
    }
  }
  return out;
}
const toOpenAITools = tools => (tools || []).map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
/** OpenAI-compatible streaming call (OpenAI API or Ollama /v1) WITH tool calling. */
async function openaiStream({ apiKey, baseURL = 'https://api.openai.com/v1', model, system, messages, tools, onText, fetchImpl = fetch, signal }) {
  const res = await fetchImpl(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model, messages: toOpenAIMessages(system, messages), tools: tools && tools.length ? toOpenAITools(tools) : undefined, stream: true, stream_options: { include_usage: true } }),
  });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw Object.assign(new Error(`OpenAI-compatible ${res.status}: ${t.slice(0, 300)}`), { status: res.status }); }
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = '', text = ''; const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const calls = new Map(); // index -> {id, name, args}
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split(/\r?\n/); buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue; const d = line.slice(5).trim(); if (!d || d === '[DONE]') continue;
      let ev; try { ev = JSON.parse(d); } catch { continue; }
      const delta = ev.choices?.[0]?.delta;
      if (delta?.content) { text += delta.content; if (onText) onText(delta.content); }
      for (const tc of delta?.tool_calls || []) {
        const cur = calls.get(tc.index) || { id: tc.id || `call_${tc.index}`, name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(tc.index, cur);
      }
      if (ev.usage) { usage.input = ev.usage.prompt_tokens || 0; usage.output = ev.usage.completion_tokens || 0; usage.cacheRead = ev.usage.prompt_tokens_details?.cached_tokens || 0; }
    }
  }
  const toolUses = [...calls.values()].filter(c => c.name).map(c => { let input = {}; try { input = JSON.parse(c.args || '{}'); } catch { /* registry validates */ } return { id: c.id, name: c.name, input }; });
  return { text, toolUses, usage, stopReason: toolUses.length ? 'tool_use' : 'end_turn' };
}
module.exports = { parseSSE, anthropicStream, openaiStream, toOpenAIMessages, toOpenAITools, resolveModel };
