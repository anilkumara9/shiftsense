'use strict';
/**
 * E2E / hostile-user suite — QA lane. Wires the REAL modules together
 * (ChatStore, MemoryStore, SpendLedger, ApprovalQueue, CodexHandoff,
 * agent.runTurn, llm streams with injected fetch) exactly the way main.js
 * wires them in the chat:send IPC handler, then stresses the seams:
 * multi-tab days, crashes mid-turn, walked-away approvals, Stop during a
 * parallel approval queue, provider switches, corrupt persistence, and
 * hand-computed cost truth.
 *
 * Defect protocol: scenarios that exposed real defects were kept as
 * failing DEFECT: tests at first reproduction. Both persistence defects
 * found by this suite (silent chats.json loss; spend-ledger fail-open)
 * were fixed by the owning lane DURING the QA run — those tests were then
 * converted into passing recovery regressions, with the timeline recorded
 * in each test's comment. Any future DEFECT: test in this file is a live,
 * unfixed reproduction.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { ChatStore } = require('../src/chatStore');
const { MemoryStore } = require('../src/memory');
const { SpendLedger, costOf } = require('../src/spend');
const { ApprovalQueue } = require('../src/approvalQueue');
const { CodexHandoff } = require('../src/codex');
const { runTurn, SYSTEM_PROMPT } = require('../src/agent');
const { anthropicStream, openaiStream, resolveModel } = require('../src/llm');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dshift-e2e-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, what = 'condition', timeout = 5000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > timeout) throw new Error(`waitFor timed out: ${what}`); await sleep(15); }
}
/** Every assistant tool_use must be covered by the next user message, and no
 *  tool_result may be orphaned — the two shapes that make a provider 400 a tab. */
function assertValidTranscript(messages, label = 'transcript') {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const ids = m.content.filter(b => b.type === 'tool_use').map(b => b.id);
      if (!ids.length) continue;
      const next = messages[i + 1];
      assert.ok(next && next.role === 'user' && Array.isArray(next.content), `${label}: tool_use at index ${i} not followed by a tool_result message`);
      const covered = new Set(next.content.filter(b => b.type === 'tool_result').map(b => b.tool_use_id));
      for (const id of ids) assert.ok(covered.has(id), `${label}: tool_use ${id} at index ${i} has no result`);
    }
    if (m.role === 'user' && Array.isArray(m.content)) {
      const prevIds = messages[i - 1] && messages[i - 1].role === 'assistant' && Array.isArray(messages[i - 1].content)
        ? messages[i - 1].content.filter(b => b.type === 'tool_use').map(b => b.id) : [];
      for (const b of m.content.filter(x => x.type === 'tool_result')) assert.ok(prevIds.includes(b.tool_use_id), `${label}: orphan tool_result ${b.tool_use_id} at index ${i}`);
    }
  }
}
function findToolResults(tab, id) {
  for (const m of tab.messages) if (m.role === 'user' && Array.isArray(m.content)) {
    const r = m.content.find(b => b.type === 'tool_result' && b.tool_use_id === id);
    if (r) return r;
  }
  return null;
}
const resultText = r => (Array.isArray(r.content) ? r.content.map(b => b.text || '').join('\n') : String(r.content ?? ''));

/* ---------- fake transports ---------- */
function streamResponse(bodyText, status = 200) {
  return {
    ok: status >= 200 && status < 300, status,
    text: async () => bodyText,
    body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(bodyText)); c.close(); } }),
  };
}
function anthropicTurn({ text = '', toolUses = [], usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason } = {}) {
  const L = [];
  const push = o => L.push(`data: ${JSON.stringify(o)}`);
  push({ type: 'message_start', message: { usage: { input_tokens: usage.input, cache_read_input_tokens: usage.cacheRead, cache_creation_input_tokens: usage.cacheWrite } } });
  let idx = 0;
  if (text) {
    push({ type: 'content_block_start', index: idx, content_block: { type: 'text' } });
    push({ type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text } });
    push({ type: 'content_block_stop', index: idx }); idx++;
  }
  for (const tu of toolUses) {
    push({ type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: tu.id, name: tu.name } });
    push({ type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tu.input || {}) } });
    push({ type: 'content_block_stop', index: idx }); idx++;
  }
  push({ type: 'message_delta', delta: { stop_reason: stopReason || (toolUses.length ? 'tool_use' : 'end_turn') }, usage: { output_tokens: usage.output } });
  return L.join('\n') + '\n';
}
function openaiTurn({ text = '', toolCalls = [], usage } = {}) {
  const chunks = [];
  if (text) chunks.push({ choices: [{ delta: { content: text } }] });
  toolCalls.forEach((tc, i) => chunks.push({ choices: [{ delta: { tool_calls: [{ index: i, id: tc.id, function: { name: tc.name, arguments: JSON.stringify(tc.input || {}) } }] } }] }));
  const last = { choices: [{ delta: {}, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }] };
  if (usage) last.usage = { prompt_tokens: usage.input, completion_tokens: usage.output, prompt_tokens_details: { cached_tokens: usage.cacheRead || 0 } };
  chunks.push(last);
  return chunks.map(c => `data: ${JSON.stringify(c)}`).join('\n') + '\ndata: [DONE]\n';
}
/** Fake Codex child process: emits one agent_message + turn.completed, exits 0. */
function fakeCodexSpawn() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 4242;
  child.kill = () => {};
  setImmediate(() => {
    child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'codex completed the task' } }) + '\n'));
    child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } }) + '\n'));
    child.emit('close', 0);
  });
  return child;
}

/* ---------- the world: main.js chat:send wiring, minus Electron ---------- */
function makeWorld({ provider = 'anthropic', approvalTimeoutMs = 120000, present } = {}) {
  const dir = tmp();
  const memory = new MemoryStore(dir).seed();
  const store = new ChatStore(dir);
  const ledger = new SpendLedger(dir);
  const codex = new CodexHandoff({ dataDir: dir, spawnImpl: fakeCodexSpawn });
  const approvals = new ApprovalQueue({ timeoutMs: approvalTimeoutMs, present: present || ((_payload, finish) => finish(true)) });
  const world = {
    dir, memory, store, ledger, codex, approvals,
    settings: { provider, model: 'claude-sonnet-5-5' },
    requests: [], responses: [],
    screenText: 'Window "notes.txt"\n  Text "hello screen"',
  };
  const fetchImpl = async (url, opts) => {
    world.requests.push({ url, body: JSON.parse(opts.body) });
    const next = world.responses.shift();
    if (!next) throw new Error('e2e: scripted LLM responses exhausted');
    return next;
  };
  world.queueAnthropic = spec => world.responses.push(streamResponse(anthropicTurn(spec)));
  world.queueOpenAI = spec => world.responses.push(streamResponse(openaiTurn(spec)));
  world.callLLM = (tab, args) => { // mirrors main.js callLLM()
    const p = world.settings.provider;
    const model = resolveModel(p, tab.model || world.settings.model);
    if (p === 'openai' || p === 'ollama') return openaiStream({ apiKey: 'test-key', model, system: SYSTEM_PROMPT, messages: args.messages, tools: args.tools, onText: args.onText, fetchImpl });
    return anthropicStream({ apiKey: 'test-key', model, system: SYSTEM_PROMPT, messages: args.messages, tools: args.tools, onText: args.onText, fetchImpl });
  };
  world.hostFor = tab => ({ // mirrors main.js host in chat:send
    memory,
    getContext: async force => { if (force) tab.usage.screenReads++; return { app: 'notepad', title: 'notes.txt', text: world.screenText }; },
    takeScreenshot: async () => { tab.usage.screenshots++; return { text: 'Screenshot of "notes.txt".', jpegBase64: 'QUJD' }; },
    onUsage: u => { tab.usage.record(u); ledger.add(costOf(u, resolveModel(world.settings.provider, tab.model || world.settings.model), {})); store.saveSoon(); },
    callLLM: args => world.callLLM(tab, args),
    requestCodexApproval: async task => { // mirrors main.js: queue -> deny text / approved run
      let req;
      try { req = codex.requestApproval(task); } catch (e) { return { text: String(e.message || e) }; }
      const approved = await approvals.ask(req);
      if (!approved) { codex.deny(req.approvalId); return { text: 'The user did not approve this computer task (denied, timed out, or stopped). Do not retry it.' }; }
      const r = await codex.approve(req.approvalId, 'codex-fake', () => {});
      return { text: r.text };
    },
  });
  world.send = async (tab, question) => { // mirrors main.js chat:send bookkeeping
    store.addDisplay(tab, { role: 'user', text: question, at: new Date().toISOString() });
    codex.newTurn();
    try {
      const res = await runTurn({ tab, question, host: world.hostFor(tab) });
      store.addDisplay(tab, { role: 'assistant', text: res.text || '', at: new Date().toISOString() });
      store.save();
      return res;
    } catch (e) { store.save(); throw e; }
  };
  return world;
}

/* ================= 1. Day in the life ================= */
test('e2e day-in-the-life: 3 tabs, screen+screenshot+memory+codex, usage, ledger, archive/reopen', async () => {
  const w = makeWorld();
  const tabA = w.store.get();
  const usages = [];
  const U = (input, output, cacheRead, cacheWrite) => ({ input, output, cacheRead, cacheWrite });

  // Tab A, Q1: read_screen then answer
  let u = U(1000, 40, 100, 200); usages.push(u);
  w.queueAnthropic({ toolUses: [{ id: 'a1', name: 'read_screen', input: {} }], usage: u });
  u = U(1500, 60, 900, 0); usages.push(u);
  w.queueAnthropic({ text: 'The screen shows hello screen.', usage: u });
  let res = await w.send(tabA, 'what is on my screen?');
  assert.equal(res.text, 'The screen shows hello screen.');
  assert.equal(tabA.usage.screenReads, 1);
  assert.ok(resultText(findToolResults(tabA, 'a1')).includes('hello screen'));

  // Tab A, Q2: screenshot then answer; image rides the tool_result in memory
  u = U(1100, 30, 0, 100); usages.push(u);
  w.queueAnthropic({ toolUses: [{ id: 'a2', name: 'take_screenshot', input: {} }], usage: u });
  u = U(2000, 70, 500, 0); usages.push(u);
  w.queueAnthropic({ text: 'It is a notes window.', usage: u });
  res = await w.send(tabA, 'what does this window look like?');
  assert.equal(tabA.usage.screenshots, 1);
  const shotResult = findToolResults(tabA, 'a2');
  assert.ok(shotResult.content.some(b => b.type === 'image' && b.source.data === 'QUJD'), 'screenshot image block must reach the transcript');

  // Tab A, Q3: write memory
  u = U(900, 25, 200, 50); usages.push(u);
  w.queueAnthropic({ toolUses: [{ id: 'a3', name: 'write_memory', input: { path: 'people/sam.md', content: '# Sam\nSam likes tea.\n' } }], usage: u });
  u = U(800, 20, 300, 0); usages.push(u);
  w.queueAnthropic({ text: 'Saved.', usage: u });
  await w.send(tabA, 'remember that Sam likes tea');
  assert.ok(fs.readFileSync(path.join(w.dir, 'memory', 'people', 'sam.md'), 'utf8').includes('Sam likes tea'));
  assert.ok(w.memory.audit().some(a => a.rel === 'people/sam.md' && a.source === 'model'), 'model memory write must be in the audit log');

  // Tab B: search memory in a LATER turn/tab and find what tab A wrote
  const tabB = w.store.newTab();
  const reqMark = w.requests.length;
  u = U(700, 15, 0, 0); usages.push(u);
  w.queueAnthropic({ toolUses: [{ id: 'b1', name: 'search_memory', input: { query: 'Sam tea' } }], usage: u });
  u = U(950, 35, 100, 0); usages.push(u);
  w.queueAnthropic({ text: 'Sam likes tea.', usage: u });
  res = await w.send(tabB, 'who likes tea?');
  assert.equal(res.text, 'Sam likes tea.');
  const bSecond = w.requests[reqMark + 1];
  assert.ok(JSON.stringify(bSecond.body.messages).includes('Sam likes tea'), 'search result from the earlier write must be in the next request');
  assert.ok(JSON.stringify(bSecond.body.messages).includes('people/sam.md'));

  // Tab C: approved computer task runs through the real CodexHandoff gate
  const tabC = w.store.newTab();
  u = U(600, 10, 0, 0); usages.push(u);
  w.queueAnthropic({ toolUses: [{ id: 'c1', name: 'use_computer', input: { task: 'Open the calendar app' } }], usage: u });
  u = U(650, 45, 0, 0); usages.push(u);
  w.queueAnthropic({ text: 'Codex opened the calendar.', usage: u });
  res = await w.send(tabC, 'open my calendar');
  assert.equal(res.text, 'Codex opened the calendar.');
  assert.ok(resultText(findToolResults(tabC, 'c1')).includes('codex completed the task'));
  const audit = fs.readFileSync(path.join(w.dir, 'codex', 'audit.jsonl'), 'utf8');
  assert.ok(audit.includes('"approved_and_started"') && audit.includes('"finished"'), 'codex run must be audit-logged');

  // Usage + ledger accumulated across all three tabs
  for (const t of [tabA, tabB, tabC]) assertValidTranscript(t.messages, `tab ${t.id}`);
  assert.equal(tabA.usage.requests, 6, 'tab A: 3 questions x 2 requests');
  assert.equal(tabB.usage.requests, 2); assert.equal(tabC.usage.requests, 2);
  const expectedSpend = usages.reduce((s, x) => s + costOf(x, 'claude-sonnet-5-5'), 0);
  assert.ok(Math.abs(w.ledger.spentToday() - expectedSpend) < 1e-6, `ledger ${w.ledger.spentToday()} != expected ${expectedSpend}`);

  // Restart: everything persists
  const store2 = new ChatStore(w.dir);
  assert.equal(store2.tabs.length, 3);
  assert.equal(store2.get(tabB.id).usage.requests, 2);

  // Close tab A -> archive -> history -> reopen with transcript intact
  const q1 = 'what is on my screen?';
  assert.equal(tabA.title, q1.slice(0, 28), 'tab title comes from the first question, 28 chars');
  w.store.closeTab(tabA.id);
  assert.ok(!w.store.tabs.some(t => t.id === tabA.id));
  const arch = w.store.listArchive();
  assert.equal(arch.length, 1); assert.equal(arch[0].id, tabA.id); assert.equal(arch[0].preview, q1);
  const reopened = w.store.openArchived(tabA.id);
  assert.ok(reopened);
  assert.deepEqual(reopened.display.map(m => m.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  assert.equal(reopened.display[0].text, q1);
  assert.equal(reopened.usage.requests, 6);
  assertValidTranscript(reopened.messages, 'reopened tab');
  assert.ok(JSON.stringify(reopened.messages).includes('[screenshot image — not persisted]'), 'persisted screenshots degrade to a text note');
  assert.equal(w.store.listArchive().length, 0, 'reopening consumes the archive entry');

  // The reopened tab still answers
  w.queueAnthropic({ text: 'Still here.', usage: U(100, 10, 0, 0) });
  res = await w.send(reopened, 'are you still there?');
  assert.equal(res.text, 'Still here.');
  assertValidTranscript(reopened.messages, 'reopened tab after new turn');
});

/* ================= 2. Hostile interruptions ================= */
test('e2e hostile: crash mid-turn leaves a dangling tool_use on disk; reload repairs it and the tab still answers', async () => {
  const w = makeWorld();
  const tab = w.store.get();
  // A screenshot that never returns — the process "dies" while the tool runs.
  let releaseShot;
  const gate = new Promise(r => { releaseShot = r; });
  const host = w.hostFor(tab);
  host.takeScreenshot = async () => { tab.usage.screenshots++; return gate; };
  w.queueAnthropic({ toolUses: [{ id: 's1', name: 'take_screenshot', input: {} }], usage: { input: 500, output: 20, cacheRead: 0, cacheWrite: 0 } });
  w.queueAnthropic({ text: 'too late', usage: { input: 500, output: 20, cacheRead: 0, cacheWrite: 0 } });
  w.store.addDisplay(tab, { role: 'user', text: 'describe this chart', at: new Date().toISOString() });
  w.codex.newTurn();
  const crashedTurn = runTurn({ tab, question: 'describe this chart', host });
  crashedTurn.catch(() => {}); // the "dead" process never reports

  // saveSoon (from onUsage) persists the transcript mid-turn: assistant tool_use, no result yet.
  const dangling = await waitFor(() => {
    try {
      const j = JSON.parse(fs.readFileSync(w.store.file, 'utf8'));
      const t = j.tabs.find(x => x.id === tab.id);
      if (!t) return null;
      const i = t.messages.findIndex(m => m.role === 'assistant' && Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use' && b.id === 's1'));
      if (i === -1) return null;
      const next = t.messages[i + 1];
      const covered = next && Array.isArray(next.content) && next.content.some(b => b.type === 'tool_result' && b.tool_use_id === 's1');
      return covered ? null : t.messages; // present AND uncovered = the real crash artifact
    } catch { return null; }
  }, 'dangling tool_use persisted to chats.json');
  assert.ok(dangling.length >= 2, 'crash artifact must be a real dangling transcript, not an empty file');

  // Relaunch: load() must repair — no dangling tool_use survives.
  const store2 = new ChatStore(w.dir);
  const tab2 = store2.get(tab.id);
  assertValidTranscript(tab2.messages, 'repaired tab');
  assert.ok(!JSON.stringify(tab2.messages).includes('s1'), 'the dangling tool_use must be truncated by repair');

  // The repaired tab still answers a new question.
  const host2 = {
    memory: w.memory,
    getContext: async () => ({ app: 'notepad', title: 'notes.txt', text: w.screenText }),
    takeScreenshot: async () => ({ text: 'shot', jpegBase64: 'QUJD' }),
    onUsage: u => tab2.usage.record(u),
    requestCodexApproval: async () => ({ text: 'n/a' }),
    callLLM: async () => ({ text: 'Back again.', toolUses: [], usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 }, stopReason: 'end_turn' }),
  };
  const res = await runTurn({ tab: tab2, question: 'are you alive?', host: host2 });
  assert.equal(res.text, 'Back again.');
  assertValidTranscript(tab2.messages, 'repaired tab after new turn');

  releaseShot({ text: 'shot', jpegBase64: 'QUJD' }); // let the zombie turn finish so nothing dangles in the test process
  await crashedTurn.catch(() => {});
});

test('e2e hostile: approval walked away from — timeout denies, turn completes, no hang', async () => {
  const presented = [];
  const w = makeWorld({ approvalTimeoutMs: 60, present: (payload, _finish) => { presented.push(payload); /* user walks away */ } });
  const tab = w.store.get();
  w.queueAnthropic({ toolUses: [{ id: 'u1', name: 'use_computer', input: { task: 'Open settings and toggle Wi-Fi' } }], usage: { input: 400, output: 15, cacheRead: 0, cacheWrite: 0 } });
  w.queueAnthropic({ text: 'I could not run that without approval.', usage: { input: 450, output: 25, cacheRead: 0, cacheWrite: 0 } });
  const t0 = Date.now();
  const res = await Promise.race([w.send(tab, 'toggle my Wi-Fi'), sleep(5000).then(() => { throw new Error('turn HUNG on a walked-away approval'); })]);
  const elapsed = Date.now() - t0;
  assert.equal(res.text, 'I could not run that without approval.');
  assert.ok(elapsed < 4000, `walked-away approval must resolve by timeout, took ${elapsed}ms`);
  assert.equal(presented.length, 1);
  assert.ok(resultText(findToolResults(tab, 'u1')).includes('did not approve'), 'model must be told the task was not approved');
  assert.equal(w.approvals.size, 0, 'approval queue must be empty after the timeout');
  const audit = fs.readFileSync(path.join(w.dir, 'codex', 'audit.jsonl'), 'utf8');
  assert.ok(audit.includes('"denied"'), 'timeout denial must be audit-logged');
  assert.equal(w.codex.runsThisTurn, 0, 'nothing may run without approval');
});

test('e2e hostile: Stop during 3 parallel computer tasks — all denied, one card shown, queue empty', async () => {
  const presented = [];
  const w = makeWorld({ approvalTimeoutMs: 60000, present: (payload, _finish) => { presented.push(payload); /* user reaches for Stop instead */ } });
  const tab = w.store.get();
  w.queueAnthropic({
    toolUses: [
      { id: 'u1', name: 'use_computer', input: { task: 'Task one' } },
      { id: 'u2', name: 'use_computer', input: { task: 'Task two' } },
      { id: 'u3', name: 'use_computer', input: { task: 'Task three' } },
    ],
    usage: { input: 500, output: 30, cacheRead: 0, cacheWrite: 0 },
  });
  w.queueAnthropic({ text: 'All three were stopped.', usage: { input: 500, output: 20, cacheRead: 0, cacheWrite: 0 } });
  const turn = w.send(tab, 'do three things on my computer');
  turn.catch(() => {});
  await waitFor(() => presented.length >= 1, 'first approval card presented');
  assert.equal(presented.length, 1, 'approvals serialize: exactly one card at a time despite 3 parallel asks');
  w.approvals.cancelAll(); // chat:stop in main.js
  const res = await Promise.race([turn, sleep(5000).then(() => { throw new Error('turn HUNG after Stop'); })]);
  assert.equal(res.text, 'All three were stopped.');
  for (const id of ['u1', 'u2', 'u3']) {
    assert.ok(resultText(findToolResults(tab, id)).includes('did not approve'), `${id} must resolve as denied after Stop`);
  }
  assert.equal(presented.length, 1, 'queued asks poisoned by Stop must never be presented');
  assert.equal(w.approvals.size, 0);
  assert.equal(w.codex.runsThisTurn, 0);
  const denied = fs.readFileSync(path.join(w.dir, 'codex', 'audit.jsonl'), 'utf8').split('\n').filter(l => l.includes('"denied"'));
  assert.equal(denied.length, 3, 'all three denials audit-logged');
});

/* ================= 3. Provider chaos ================= */
test('e2e provider chaos: provider switch remaps a Claude-named model; OpenAI tool calls round-trip in OpenAI format', async () => {
  // resolveModel guard table (audit M1)
  assert.equal(resolveModel('openai', 'claude-sonnet-5-5'), 'gpt-5');
  assert.equal(resolveModel('anthropic', 'gpt-5'), 'claude-sonnet-5-5');
  assert.equal(resolveModel('anthropic', 'claude-opus-5-5'), 'claude-opus-5-5');
  assert.equal(resolveModel('openai', 'gpt-5-mini'), 'gpt-5-mini');
  assert.equal(resolveModel('ollama', 'claude-sonnet-5-5'), 'llama3.1');
  assert.equal(resolveModel('ollama', 'ollama:qwen2.5'), 'qwen2.5');

  const w = makeWorld({ provider: 'anthropic' });
  const tab = w.store.get(); // model: claude-sonnet-5-5
  w.queueAnthropic({ text: 'Anthropic here.', usage: { input: 300, output: 20, cacheRead: 0, cacheWrite: 0 } });
  let res = await w.send(tab, 'who are you?');
  assert.equal(res.text, 'Anthropic here.');
  assert.equal(w.requests[0].body.model, 'claude-sonnet-5-5');

  // User flips provider in the tray; the tab still carries the Claude name.
  w.settings.provider = 'openai';
  const mark = w.requests.length;
  w.queueOpenAI({ toolCalls: [{ id: 'call_1', name: 'read_screen', input: {} }], usage: { input: 500, output: 20, cacheRead: 100 } });
  w.queueOpenAI({ text: 'The screen says hello screen.', usage: { input: 700, output: 30, cacheRead: 0 } });
  res = await w.send(tab, 'read my screen');
  assert.equal(res.text, 'The screen says hello screen.');

  const req1 = w.requests[mark], req2 = w.requests[mark + 1];
  assert.equal(req1.body.model, 'gpt-5', 'Claude-named model must be remapped for OpenAI, not sent verbatim');
  assert.equal(req1.body.messages[0].role, 'system');
  assert.ok(JSON.stringify(req1.body.tools).includes('read_screen'), 'tools must be offered to OpenAI in function format');
  const asst = req2.body.messages.find(m => m.role === 'assistant' && m.tool_calls);
  assert.ok(asst, 'second OpenAI request must carry the assistant tool_calls turn');
  assert.equal(asst.tool_calls[0].id, 'call_1');
  assert.equal(asst.tool_calls[0].function.name, 'read_screen');
  assert.deepEqual(JSON.parse(asst.tool_calls[0].function.arguments), {});
  const toolMsg = req2.body.messages.find(m => m.role === 'tool');
  assert.ok(toolMsg, 'tool result must return as a role:"tool" message');
  assert.equal(toolMsg.tool_call_id, 'call_1');
  assert.ok(toolMsg.content.includes('hello screen'), 'tool message must carry the real screen text');
  assert.equal(tab.usage.requests, 3);
  assertValidTranscript(tab.messages, 'mixed-provider tab');
});

test('e2e provider chaos: Anthropic 429 is retried once and succeeds; a 400 is not retried', async () => {
  let calls429 = 0;
  const fetch429 = async () => {
    calls429++;
    if (calls429 === 1) return streamResponse('rate limited', 429);
    return streamResponse(anthropicTurn({ text: 'after the wait', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } }));
  };
  const t0 = Date.now();
  const r = await anthropicStream({ apiKey: 'k', model: 'claude-sonnet-5-5', system: 's', messages: [], fetchImpl: fetch429 });
  const elapsed = Date.now() - t0;
  assert.equal(r.text, 'after the wait');
  assert.equal(calls429, 2, '429 must be retried exactly once');
  assert.ok(elapsed >= 700, `retry must back off (~800ms), took only ${elapsed}ms`);

  let calls400 = 0;
  const fetch400 = async () => { calls400++; return streamResponse('bad request', 400); };
  await assert.rejects(
    () => anthropicStream({ apiKey: 'k', model: 'claude-sonnet-5-5', system: 's', messages: [], fetchImpl: fetch400 }),
    e => e.status === 400,
  );
  assert.equal(calls400, 1, 'a 400 is a client error: no retry');
});

/* ================= 4. Persistence chaos ================= */
test('e2e persistence: truncated chats.json recovers from the .bak rotation — flagged, at most one save behind', () => {
  // NOTE (QA log): as first written, this scenario was a DEFECT — load()
  // swallowed the parse error and every chat vanished silently. The
  // reliability lane's fix (atomicWriteJson .bak rotation in chatStore.js)
  // landed mid-run; this test now verifies the fixed behavior precisely:
  // both chats come back, the recovery is FLAGGED (never silent), the main
  // file self-heals, and the only loss is the final save (the backup holds
  // the previous payload by design).
  const dir = tmp();
  const s1 = new ChatStore(dir);
  const t1 = s1.get();
  s1.addDisplay(t1, { role: 'user', text: 'irreplaceable research thread', at: new Date().toISOString() });
  const t2 = s1.newTab();
  s1.addDisplay(t2, { role: 'user', text: 'second thread', at: new Date().toISOString() });
  s1.save();
  const raw = fs.readFileSync(s1.file, 'utf8');
  fs.writeFileSync(s1.file, raw.slice(0, Math.floor(raw.length / 2))); // truncated mid-JSON
  const s2 = new ChatStore(dir);
  assert.equal(s2.recoveryInfo.chatsFromBackup, true, 'recovery from backup must be flagged, not silent');
  const r1 = s2.tabs.find(t => t.id === t1.id);
  const r2 = s2.tabs.find(t => t.id === t2.id);
  assert.ok(r1 && r2, 'both saved chats must survive a truncated chats.json');
  assert.ok(r1.display.some(m => m.text === 'irreplaceable research thread'), 'content from before the last save must be intact');
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(s1.file, 'utf8')), 'load must self-heal the main file');
});

test('e2e persistence: chats.json AND .bak corrupt -> the .mirror still rescues the chats; all three corrupt -> fresh start (documented limit)', () => {
  // Coordinator extension of the reliability fix: ChatStore mirrors every
  // saved payload (chats.json.mirror), closing the same first-write gap the
  // spend ledger's mirror closed. The old "both corrupt = data loss" limit
  // now requires all three copies to be torn.
  const dir = tmp();
  const s1 = new ChatStore(dir);
  s1.addDisplay(s1.get(), { role: 'user', text: 'rescued thread', at: new Date().toISOString() });
  s1.save();
  fs.writeFileSync(s1.file, '{"v":2,"tabs":[{"id":"tab-x"'); // torn
  fs.writeFileSync(s1.file + '.bak', '{"v":2,"tabs":[{"id":"tab-y"'); // torn too
  const s2 = new ChatStore(dir);
  assert.equal(s2.recoveryInfo.chatsFromBackup, true, 'mirror recovery is flagged like backup recovery');
  assert.ok(s2.tabs.some(t => t.display.some(m => m.text === 'rescued thread')), 'mirror restores the latest saved chats');
  // The true limit: every copy torn -> fresh start.
  fs.writeFileSync(s1.file, '{"v":2,');
  fs.writeFileSync(s1.file + '.bak', '{"v":2,');
  fs.writeFileSync(s1.file + '.mirror', '{"v":2,');
  const s3 = new ChatStore(dir);
  assert.equal(s3.tabs.length, 1);
  assert.ok(!s3.tabs.some(t => t.display.some(m => m.text === 'rescued thread')));
});

test('e2e persistence: corrupt spend.json recovers the previous write from spend.json.bak, flagged', () => {
  // The reliability lane's fix covers the steady state: every write rotates
  // the previous payload to .bak, so corruption costs at most the last add.
  const dir = tmp();
  const l1 = new SpendLedger(dir);
  l1.add(2.00);
  l1.add(2.25); // this write rotates {usd: 2.00} into spend.json.bak
  assert.equal(l1.spentToday(), 4.25);
  fs.writeFileSync(l1.file, '{"day":'); // main file torn mid-write
  const l2 = new SpendLedger(dir);
  assert.equal(l2.recoveredFromBackup, true, 'backup recovery must be flagged');
  assert.equal(l2.spentToday(), 2.00, 'recovery restores the last-but-one write');
});

test('e2e persistence: spend.json corrupted after a SINGLE write recovers in full from spend.json.mirror, flagged', () => {
  // QA TIMELINE: this scenario began as a live DEFECT in this suite — the
  // .bak rotation backs up the PREVIOUS payload, so a file's first write had
  // no backup and a one-add ledger corrupted before its second write loaded
  // as $0 spent (budget cap fail-open; reproduced and failing at first run).
  // The reliability lane closed it during this QA run by mirroring the
  // LATEST payload to spend.json.mirror on every write (load order: main ->
  // .bak -> .mirror). This test now pins the fixed behavior.
  const dir = tmp();
  const l1 = new SpendLedger(dir);
  l1.add(4.25);
  assert.equal(l1.spentToday(), 4.25);
  assert.equal(fs.existsSync(l1.file + '.bak'), false, 'precondition: rotation has nothing to back up on the first write');
  assert.equal(fs.existsSync(l1.file + '.mirror'), true, 'the mirror must exist from the very first write');
  fs.writeFileSync(l1.file, '{"day":'); // truncated mid-write
  const l2 = new SpendLedger(dir);
  assert.equal(l2.recoveredFromBackup, true, 'mirror recovery must be flagged, not silent');
  assert.equal(l2.spentToday(), 4.25, 'the full amount must be recovered, not one-write-behind');
});

test('e2e persistence: spend ledger across a day boundary — stale day never counts, rollover resets on add', () => {
  const dir = tmp();
  const l1 = new SpendLedger(dir);
  l1.add(1.5);
  assert.equal(l1.spentToday(), 1.5);
  // Yesterday's file on disk: a fresh process must NOT count it.
  const today = l1.today();
  fs.writeFileSync(l1.file, JSON.stringify({ day: '2000-01-01', usd: 9.99 }));
  const l2 = new SpendLedger(dir);
  assert.equal(l2.spentToday(), 0, 'stale-day spend must not leak into today');
  assert.equal(l2.exceeded(0.01), false);
  // In-memory rollover: the clock crosses midnight while the app stays open.
  l1.day = '2000-01-01'; l1.usd = 5;
  assert.equal(l1.spentToday(), 0, 'spentToday() must report 0 once the day has rolled over');
  l1.add(0.25);
  assert.equal(l1.spentToday(), 0.25, 'first add of the new day starts from 0, not from yesterday\'s total');
  const onDisk = JSON.parse(fs.readFileSync(l1.file, 'utf8'));
  assert.equal(onDisk.day, today);
  assert.equal(onDisk.usd, 0.25);
  assert.equal(l1.exceeded(0.25), true, 'cap comparison is >= at the boundary');
});

/* ================= 5. Cost truth ================= */
test('e2e cost truth: per-tab cost and ledger total match hand-computed values to 6 decimals', async () => {
  const w = makeWorld({ provider: 'anthropic' });
  const sonnet = w.store.get(); // claude-sonnet-5-5: in $2, out $10, cacheRead $0.20, cacheWrite $2.50 per 1M
  // u1: 1,000,000*2 + 100,000*10 + 500,000*0.20 + 200,000*2.50 = 2,000,000 + 1,000,000 + 100,000 + 500,000 = $3.600000
  w.queueAnthropic({ text: 'one', usage: { input: 1000000, output: 100000, cacheRead: 500000, cacheWrite: 200000 } });
  await w.send(sonnet, 'first');
  // u2: 123,456*2 + 7,890*10 + 11,111*0.20 + 2,222*2.50 = 246,912 + 78,900 + 2,222.2 + 5,555 = 333,589.2 -> $0.333589 (6dp)
  w.queueAnthropic({ text: 'two', usage: { input: 123456, output: 7890, cacheRead: 11111, cacheWrite: 2222 } });
  await w.send(sonnet, 'second');
  const sonnetExpected = 3.6 + (123456 * 2 + 7890 * 10 + 11111 * 0.20 + 2222 * 2.50) / 1e6; // 3.9335892
  assert.equal(sonnet.usage.snapshot().costUSD, +sonnetExpected.toFixed(6), 'per-tab cost must equal the hand-computed value at 6dp');
  assert.equal(sonnet.usage.snapshot().costUSD, 3.933589);

  // gpt-5 tab on the OpenAI provider: in $1.25, out $10, cacheRead $0.125, cacheWrite $1.25 per 1M
  // u3: 2,000,000*1.25 + 50,000*10 + 400,000*0.125 + 0 = 2,500,000 + 500,000 + 50,000 = $3.050000
  w.settings.provider = 'openai';
  const gpt = w.store.newTab('gpt-5');
  w.queueOpenAI({ text: 'three', usage: { input: 2000000, output: 50000, cacheRead: 400000 } });
  await w.send(gpt, 'third');
  assert.equal(gpt.usage.snapshot().costUSD, 3.05);

  // Ledger: 3.6 + 0.3335892 + 3.05 = 6.9835892 in memory; the persisted copy rounds to 6dp.
  assert.ok(Math.abs(w.ledger.spentToday() - 6.9835892) < 1e-9, `ledger in-memory total ${w.ledger.spentToday()}`);
  assert.equal(w.ledger.spentToday().toFixed(6), '6.983589');
  const reloaded = new SpendLedger(w.dir);
  assert.equal(reloaded.spentToday(), 6.983589, 'persisted ledger must reload at exactly the 6dp total');
  assert.equal(reloaded.exceeded(6.98), true);
  assert.equal(reloaded.exceeded(6.99), false);
});

