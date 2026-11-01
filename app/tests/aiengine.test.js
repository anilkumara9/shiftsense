'use strict';
/* AI-engine lane tests: prompt caching, resilient streaming (retry only
   pre-first-byte), stream watchdog, turn wall-clock budget. All providers
   are fakes injected via fetchImpl — no network, no real keys. */
const test = require('node:test');
const assert = require('node:assert');
const { anthropicStream, openaiStream, retryDelayMs } = require('../src/llm');
const { runTurn, TURN_BUDGET_MS } = require('../src/agent');

const enc = new TextEncoder();
const sseStream = s => new ReadableStream({ start(c) { c.enqueue(enc.encode(s)); c.close(); } });
const okRes = body => ({ ok: true, status: 200, headers: { get: () => null }, body });
const errRes = (status, retryAfter) => ({
  ok: false, status,
  headers: { get: h => (String(h).toLowerCase() === 'retry-after' ? retryAfter ?? null : null) },
  text: async () => `error ${status}`,
});
const anthropicText = t => [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
  `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(t)}}}`,
  'data: {"type":"content_block_stop","index":0}',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
].join('\n') + '\n';
const noSleep = delays => async ms => { delays.push(ms); };

test('caching: system block + last tool carry cache_control ephemeral; caller tools unmutated', async () => {
  let sent = null;
  const tools = [
    { name: 'read_screen', description: 'd', input_schema: { type: 'object', properties: {} } },
    { name: 'search_memory', description: 'd', input_schema: { type: 'object', properties: {} } },
  ];
  const fakeFetch = async (url, opts) => { sent = JSON.parse(opts.body); return okRes(sseStream(anthropicText('hi'))); };
  const r = await anthropicStream({ apiKey: 'k', model: 'm', system: 'BIG SYSTEM', messages: [{ role: 'user', content: 'q' }], tools, fetchImpl: fakeFetch, sleepImpl: noSleep([]) });
  assert.equal(r.text, 'hi');
  assert.ok(Array.isArray(sent.system), 'system is sent as content blocks');
  assert.equal(sent.system[0].text, 'BIG SYSTEM');
  assert.deepEqual(sent.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(sent.tools.length, 2);
  assert.equal(sent.tools[0].cache_control, undefined, 'only the LAST tool gets the breakpoint');
  assert.deepEqual(sent.tools[1].cache_control, { type: 'ephemeral' });
  assert.equal(sent.cache_control, undefined, 'no stray top-level cache_control');
  assert.equal(tools[1].cache_control, undefined, 'caller tool schemas must not be mutated');
  assert.deepEqual(sent.messages, [{ role: 'user', content: 'q' }], 'messages pass through untouched');
});

test('retry: 429 then success — text emitted exactly once, Retry-After honored', async () => {
  let calls = 0; const delays = []; let seen = '';
  const fakeFetch = async () => { calls++; return calls === 1 ? errRes(429, '0') : okRes(sseStream(anthropicText('hello'))); };
  const r = await anthropicStream({ apiKey: 'k', model: 'm', system: 's', messages: [], fetchImpl: fakeFetch, onText: d => { seen += d; }, retryBaseMs: 5, sleepImpl: noSleep(delays) });
  assert.equal(calls, 2);
  assert.equal(r.text, 'hello'); assert.equal(seen, 'hello', 'the answer reaches the user once, not once per attempt');
  assert.equal(delays[0], 0, 'Retry-After: 0 was honored instead of the exponential default');
});

test('retry: delay policy — Retry-After capped at 30s, exponential backoff otherwise', () => {
  assert.equal(retryDelayMs({ retryAfterMs: 120000 }, 0, 800, () => 0), 30000);
  assert.equal(retryDelayMs({ retryAfterMs: 2000 }, 0, 800, () => 0), 2000);
  assert.equal(retryDelayMs({}, 0, 800, () => 0), 800);
  assert.equal(retryDelayMs({}, 1, 800, () => 0), 1600);
  assert.equal(retryDelayMs({ status: 500 }, 5, 800, () => 0), 25600);
});

test('retry: non-retryable 400 fails immediately, exactly one attempt', async () => {
  let calls = 0;
  const fakeFetch = async () => { calls++; return errRes(400); };
  await assert.rejects(() => anthropicStream({ apiKey: 'k', model: 'm', system: 's', messages: [], fetchImpl: fakeFetch, retryBaseMs: 1, sleepImpl: noSleep([]) }), /Anthropic 400/);
  assert.equal(calls, 1);
});

test('no retry after first byte: mid-stream failure fails the turn, text shown once', async () => {
  let calls = 0; let seen = '';
  // pull-based: the first read delivers a chunk (with a text delta), the
  // NEXT read fails — how a real connection dies mid-stream. (error() in
  // start() would discard the queued chunk before any read, which is not
  // what a network reset looks like.)
  let step = 0;
  const dying = new ReadableStream({ pull(c) { step++; if (step === 1) c.enqueue(enc.encode(anthropicText('partial').split('\n').slice(0, 3).join('\n') + '\n')); else c.error(new Error('socket reset')); } });
  const fakeFetch = async () => { calls++; return okRes(dying); };
  await assert.rejects(() => anthropicStream({ apiKey: 'k', model: 'm', system: 's', messages: [], fetchImpl: fakeFetch, onText: d => { seen += d; }, retryBaseMs: 1, sleepImpl: noSleep([]) }), /socket reset/);
  assert.equal(calls, 1, 'a retry would have duplicated the streamed text — forbidden');
  assert.equal(seen, 'partial');
});

test('watchdog: a stream that stalls before the first byte is aborted and retried', async () => {
  let calls = 0;
  const silent = new ReadableStream({ start() { /* never emits, never closes */ } });
  const fakeFetch = async () => { calls++; return calls === 1 ? okRes(silent) : okRes(sseStream(anthropicText('recovered'))); };
  const r = await anthropicStream({ apiKey: 'k', model: 'm', system: 's', messages: [], fetchImpl: fakeFetch, stallMs: 40, retryBaseMs: 1, sleepImpl: noSleep([]) });
  assert.equal(r.text, 'recovered'); assert.equal(calls, 2);
});

test('watchdog: a permanently silent provider errors clearly after max attempts (no hang)', async () => {
  let calls = 0;
  const fakeFetch = async () => { calls++; return okRes(new ReadableStream({ start() {} })); };
  await assert.rejects(
    () => anthropicStream({ apiKey: 'k', model: 'm', system: 's', messages: [], fetchImpl: fakeFetch, stallMs: 20, retryBaseMs: 1, sleepImpl: noSleep([]) }),
    /Stream stalled/);
  assert.equal(calls, 3, 'bounded at MAX_ATTEMPTS — never an infinite retry loop');
});

test('openai: 500 then success retries pre-byte; text emitted once', async () => {
  let calls = 0; let seen = '';
  const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\ndata: [DONE]\n';
  const fakeFetch = async () => { calls++; return calls === 1 ? errRes(500) : okRes(sseStream(sse)); };
  const r = await openaiStream({ apiKey: 'k', model: 'gpt-5', system: 's', messages: [{ role: 'user', content: 'q' }], fetchImpl: fakeFetch, onText: d => { seen += d; }, retryBaseMs: 1, sleepImpl: noSleep([]) });
  assert.equal(calls, 2); assert.equal(r.text, 'hi'); assert.equal(seen, 'hi');
});

test('openai: watchdog aborts a silent stream too', async () => {
  const fakeFetch = async () => okRes(new ReadableStream({ start() {} }));
  await assert.rejects(
    () => openaiStream({ apiKey: 'k', model: 'gpt-5', system: 's', messages: [], fetchImpl: fakeFetch, stallMs: 20, retryBaseMs: 1, sleepImpl: noSleep([]), maxAttempts: 2 }),
    /Stream stalled/);
});

test('budget: turn stops starting new model calls past the wall-clock budget and returns the partial answer', async () => {
  let clock = 1000; let calls = 0;
  const host = {
    memory: { overview: () => ({ me: '', files: [] }), search: () => [] },
    getContext: async () => ({ app: 'a', title: 't', text: 'screen' }),
    takeScreenshot: async () => ({ text: 's' }),
    requestCodexApproval: async () => ({ text: 'ok' }),
    onUsage: () => {},
    callLLM: async () => { calls++; clock += 100; return { text: 'partial answer', toolUses: [{ id: `t${calls}`, name: 'search_memory', input: { query: 'x' } }], stopReason: 'tool_use', usage: { input: 1, output: 1 } }; },
  };
  const tab = { id: 'x', title: 'New chat', model: 'm', messages: [], display: [], queue: [] };
  const r = await runTurn({ tab, question: 'q', host, turnBudgetMs: 150, nowImpl: () => clock });
  assert.equal(r.ok, true); assert.equal(r.budgetExceeded, true);
  assert.equal(calls, 2, 'calls at t=0 and t=100 fit the 150ms budget; the t=200 call is never started');
  assert.match(r.text, /partial answer/);
  assert.match(r.text, /budget/);
  assert.ok(tab.messages.length > 0, 'transcript is kept (no rollback) — the partial answer is a valid turn end');
});

test('budget: default is 240s and a fast turn is unaffected', async () => {
  assert.equal(TURN_BUDGET_MS, 240000);
  const host = {
    memory: { overview: () => ({ me: '', files: [] }) },
    getContext: async () => ({ app: 'a', title: 't', text: 's' }),
    takeScreenshot: async () => ({ text: 's' }), requestCodexApproval: async () => ({ text: 'ok' }), onUsage: () => {},
    callLLM: async () => ({ text: 'done', toolUses: [], stopReason: 'end_turn', usage: { input: 1, output: 1 } }),
  };
  const tab = { id: 'x', title: 'New chat', model: 'm', messages: [], display: [], queue: [] };
  const r = await runTurn({ tab, question: 'q', host });
  assert.equal(r.text, 'done'); assert.equal(r.budgetExceeded, undefined);
});
