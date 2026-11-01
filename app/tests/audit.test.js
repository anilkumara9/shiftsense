'use strict';
/* Regression tests for the v1 production audit (user: "not a demo"). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dshift-audit-'));
const { ChatStore, stripImages } = require('../src/chatStore');
const { runTurn } = require('../src/agent');
const { MemoryStore } = require('../src/memory');
const { toOpenAIMessages, toOpenAITools, openaiStream } = require('../src/llm');
const { SpendLedger, costOf } = require('../src/spend');

test('REGRESSION: main send flow never posts a display entry to the API', async () => {
  const dir = tmp(); const store = new ChatStore(dir); const tab = store.get();
  store.addDisplay(tab, { role: 'user', text: 'what is on screen?', at: new Date().toISOString() }); // exactly what main.js does
  let posted = null;
  const host = { memory: new MemoryStore(dir).seed(), getContext: async () => ({ app: 'notepad', title: 'a', text: 'hi' }), takeScreenshot: async () => ({ text: 's' }), requestCodexApproval: async () => ({ text: 'ok' }), onUsage: () => {}, callLLM: async ({ messages }) => { posted = messages; return { text: 'ans', toolUses: [], usage: { input: 1, output: 1 }, stopReason: 'end_turn' }; } };
  await runTurn({ tab, question: 'what is on screen?', host });
  store.addDisplay(tab, { role: 'assistant', text: 'ans', at: new Date().toISOString() });
  assert.ok(posted.every(m => typeof m.content === 'string' || Array.isArray(m.content)), 'every API message must carry content');
  assert.equal(tab.display.length, 2); assert.equal(tab.messages.length, 2);
  const store2 = new ChatStore(dir); const t2 = store2.get();
  assert.equal(t2.display.length, 2); assert.equal(t2.messages.length, 2); // both survive restart, separate
});

test('REGRESSION: screenshots are stripped from the persisted transcript', () => {
  const msgs = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: [{ type: 'text', text: 'shot' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BIGDATA' } }] }] }];
  const out = stripImages(msgs);
  assert.doesNotMatch(JSON.stringify(out), /BIGDATA/); assert.match(JSON.stringify(out), /not persisted/);
  assert.match(JSON.stringify(msgs), /BIGDATA/); // in-memory copy untouched
});

test('openai translation: tool_use/tool_result survive the round trip', () => {
  const anthropic = [
    { role: 'user', content: '<screen>hi</screen>\nquestion' },
    { role: 'assistant', content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'tu1', name: 'read_screen', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'Window "x"' }] }] },
  ];
  const oa = toOpenAIMessages('sys', anthropic);
  assert.equal(oa[1].role, 'user');
  assert.equal(oa[2].tool_calls[0].function.name, 'read_screen');
  assert.equal(oa[3].role, 'tool'); assert.equal(oa[3].tool_call_id, 'tu1'); assert.match(oa[3].content, /Window "x"/);
  const tools = toOpenAITools([{ name: 'read_screen', description: 'd', input_schema: { type: 'object', properties: {} } }]);
  assert.equal(tools[0].type, 'function'); assert.equal(tools[0].function.parameters.type, 'object');
});

test('openai stream: streamed tool_calls are parsed back into toolUses', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"search_memory","arguments":"{\\"query\\":"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"sam\\"}"}}]}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":9,"completion_tokens":4}}',
    'data: [DONE]',
  ].join('\n') + '\n';
  let sentBody = null;
  const fakeFetch = async (url, opts) => { sentBody = JSON.parse(opts.body); return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }) }; };
  const r = await openaiStream({ apiKey: 'k', model: 'gpt-5', system: 's', messages: [{ role: 'user', content: 'q' }], tools: [{ name: 'search_memory', description: 'd', input_schema: { type: 'object', properties: { query: { type: 'string' } } } }], fetchImpl: fakeFetch });
  assert.equal(r.stopReason, 'tool_use'); assert.equal(r.toolUses[0].name, 'search_memory'); assert.deepEqual(r.toolUses[0].input, { query: 'sam' });
  assert.equal(r.usage.input, 9); assert.ok(sentBody.tools?.length === 1, 'tools must actually be sent to the provider');
});

test('spend ledger: accumulates, persists, enforces the cap, prices match usage table', () => {
  const dir = tmp(); const l = new SpendLedger(dir);
  assert.equal(costOf({ input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }, 'claude-opus-5-5'), 4);
  l.add(1.25); l.add(0.75);
  assert.equal(l.spentToday(), 2); assert.equal(l.exceeded(2), true); assert.equal(l.exceeded(3), false); assert.equal(l.exceeded(0), false);
  const l2 = new SpendLedger(dir); assert.equal(l2.spentToday(), 2); // survives restart
});
