'use strict';
/* Error-quality lane tests: provider/network failures must reach the user
   as one clear, actionable sentence — not "fetch failed" or a bare status
   body. All providers are fakes injected via fetchImpl. The original error
   must survive on .cause with .status preserved (the crash log and the
   e2e 400 test depend on both). */
const test = require('node:test');
const assert = require('node:assert');
const { anthropicStream, openaiStream, friendlyError, missingKeyError } = require('../src/llm');
const { runTurn } = require('../src/agent');

const enc = new TextEncoder();
const sseStream = s => new ReadableStream({ start(c) { c.enqueue(enc.encode(s)); c.close(); } });
const okRes = body => ({ ok: true, status: 200, headers: { get: () => null }, body });
const errRes = status => ({
  ok: false, status,
  headers: { get: () => null },
  text: async () => `{"error":{"message":"provider body for ${status}"}}`,
});
const noSleep = async () => {};
const transportErr = (code, msg) => {
  const cause = new Error(msg); cause.code = code;
  const e = new TypeError('fetch failed'); e.cause = cause;
  return e;
};
const FAST = { retryBaseMs: 1, sleepImpl: noSleep };

/* ---------- missing key: fail BEFORE a doomed request ---------- */
test('errors: missing Anthropic key fails before any request, with Settings guidance', async () => {
  let calls = 0;
  const fakeFetch = async () => { calls++; return okRes(sseStream('')); };
  for (const apiKey of ['', '   ', undefined, null]) {
    await assert.rejects(
      () => anthropicStream({ apiKey, model: 'm', system: 's', messages: [], fetchImpl: fakeFetch, ...FAST }),
      e => /No Anthropic API key is configured yet/.test(e.message) && /Settings/.test(e.message) && e.code === 'EMISSINGKEY');
  }
  assert.equal(calls, 0, 'no request is ever sent with an empty key');
});

test('errors: missing OpenAI key fails before any request; Ollama needs no key and still works', async () => {
  let calls = 0;
  const fakeFetch = async () => { calls++; return okRes(sseStream('')); };
  await assert.rejects(
    () => openaiStream({ apiKey: '', model: 'gpt-5', system: 's', messages: [], fetchImpl: fakeFetch, ...FAST }),
    /No OpenAI API key is configured yet/);
  assert.equal(calls, 0);
  // Ollama: empty key is normal — the request goes out with no auth header.
  let sentHeaders = null;
  const sse = 'data: {"choices":[{"delta":{"content":"local hi"}}]}\ndata: [DONE]\n';
  const r = await openaiStream({
    apiKey: '', baseURL: 'http://localhost:11434/v1', model: 'llama3.1', system: 's', messages: [],
    fetchImpl: async (url, opts) => { sentHeaders = opts.headers; return okRes(sseStream(sse)); }, ...FAST,
  });
  assert.equal(r.text, 'local hi');
  assert.equal(sentHeaders.authorization, undefined);
});

/* ---------- HTTP status translation ---------- */
test('errors: Anthropic 401 says the key was rejected and where to fix it; status + cause preserved', async () => {
  const fakeFetch = async () => errRes(401);
  await assert.rejects(
    () => anthropicStream({ apiKey: 'bad-key', model: 'm', system: 's', messages: [], fetchImpl: fakeFetch, ...FAST }),
    e => {
      assert.match(e.message, /Your Anthropic API key was rejected \(401\)/);
      assert.match(e.message, /Settings/);
      assert.match(e.message, /Anthropic 401/, 'original detail stays in parentheses');
      assert.equal(e.status, 401, 'status preserved for callers');
      assert.ok(e.cause && /Anthropic 401/.test(e.cause.message), 'original error kept on .cause for the crash log');
      return true;
    });
});

test('errors: OpenAI 403 uses OpenAI wording', async () => {
  const fakeFetch = async () => errRes(403);
  await assert.rejects(
    () => openaiStream({ apiKey: 'k', model: 'gpt-5', system: 's', messages: [], fetchImpl: fakeFetch, ...FAST }),
    e => /Your OpenAI API key was rejected \(403\)/.test(e.message) && e.status === 403);
});

test('errors: 404 names the model for cloud providers; Ollama 404 tells the user to pull it', async () => {
  await assert.rejects(
    () => anthropicStream({ apiKey: 'k', model: 'claude-gone-9', system: 's', messages: [], fetchImpl: async () => errRes(404), ...FAST }),
    e => /The model "claude-gone-9" was not found by Anthropic \(404\)/.test(e.message) && e.status === 404);
  await assert.rejects(
    () => openaiStream({ apiKey: 'k', model: 'gpt-99', system: 's', messages: [], fetchImpl: async () => errRes(404), ...FAST }),
    /The model "gpt-99" was not found by OpenAI \(404\)/);
  await assert.rejects(
    () => openaiStream({ apiKey: '', baseURL: 'http://localhost:11434/v1', model: 'llama9', system: 's', messages: [], fetchImpl: async () => errRes(404), ...FAST }),
    e => /not downloaded in Ollama yet/.test(e.message) && /ollama pull llama9/.test(e.message));
});

test('errors: 429 after all retries explains rate limiting; retries still happened first', async () => {
  let calls = 0;
  const fakeFetch = async () => { calls++; return errRes(429); };
  await assert.rejects(
    () => anthropicStream({ apiKey: 'k', model: 'm', system: 's', messages: [], fetchImpl: fakeFetch, maxAttempts: 2, ...FAST }),
    e => /rate limiting your requests right now \(429\), even after retrying/.test(e.message) && e.status === 429);
  assert.equal(calls, 2, 'translation happens only after the retry policy has run');
});

test('errors: 500 and 529 after retries read as provider-side problems, not user errors', async () => {
  await assert.rejects(
    () => openaiStream({ apiKey: 'k', model: 'gpt-5', system: 's', messages: [], fetchImpl: async () => errRes(500), maxAttempts: 2, ...FAST }),
    /OpenAI is having a problem on its side right now \(500\)/);
  await assert.rejects(
    () => anthropicStream({ apiKey: 'k', model: 'm', system: 's', messages: [], fetchImpl: async () => errRes(529), maxAttempts: 1, ...FAST }),
    /Anthropic is overloaded right now \(529\)/);
});

/* ---------- transport translation ---------- */
test('errors: Ollama not running (ECONNREFUSED) says so and how to start it', async () => {
  let calls = 0;
  const fakeFetch = async () => { calls++; throw transportErr('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:11434'); };
  await assert.rejects(
    () => openaiStream({ apiKey: '', baseURL: 'http://localhost:11434/v1', model: 'llama3.1', system: 's', messages: [], fetchImpl: fakeFetch, maxAttempts: 1, ...FAST }),
    e => {
      assert.match(e.message, /Ollama does not seem to be running on this PC/);
      assert.match(e.message, /ollama serve/);
      assert.match(e.message, /ECONNREFUSED/, 'original detail stays in parentheses');
      assert.equal(e.code, 'ECONNREFUSED', 'system code preserved for the crash log');
      return true;
    });
  assert.equal(calls, 1);
});

test('errors: no network / DNS failure to a cloud provider says check your connection', async () => {
  const fakeFetch = async () => { throw transportErr('ENOTFOUND', 'getaddrinfo ENOTFOUND api.anthropic.com'); };
  await assert.rejects(
    () => anthropicStream({ apiKey: 'k', model: 'm', system: 's', messages: [], fetchImpl: fakeFetch, maxAttempts: 1, ...FAST }),
    e => /Could not reach Anthropic/.test(e.message) && /internet connection/.test(e.message) && /ENOTFOUND/.test(e.message));
  const fakeFetch2 = async () => { throw transportErr('ECONNRESET', 'read ECONNRESET'); };
  await assert.rejects(
    () => openaiStream({ apiKey: 'k', model: 'gpt-5', system: 's', messages: [], fetchImpl: fakeFetch2, maxAttempts: 1, ...FAST }),
    /Could not reach OpenAI/);
});

test('errors: a connection that drops AFTER text was shown says the answer stopped early', async () => {
  let step = 0; let seen = '';
  const dying = new ReadableStream({ pull(c) { step++; if (step === 1) c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"par"}}]}\n')); else c.error(new Error('socket reset')); } });
  await assert.rejects(
    () => openaiStream({ apiKey: 'k', model: 'gpt-5', system: 's', messages: [], fetchImpl: async () => okRes(dying), onText: d => { seen += d; }, maxAttempts: 1, ...FAST }),
    e => /dropped partway through the answer/.test(e.message) && /socket reset/.test(e.message));
  assert.equal(seen, 'par', 'the partial text the user saw is untouched');
});

/* ---------- pass-through guarantees ---------- */
test('errors: AbortError (the user pressed Stop) and unknown errors are never rewritten', async () => {
  const abort = new Error('This operation was aborted'); abort.name = 'AbortError';
  await assert.rejects(
    () => anthropicStream({ apiKey: 'k', model: 'm', system: 's', messages: [], fetchImpl: async () => { throw abort; }, maxAttempts: 1, ...FAST }),
    e => e === abort);
  const weird = new Error('something entirely unexpected');
  await assert.rejects(
    () => anthropicStream({ apiKey: 'k', model: 'm', system: 's', messages: [], fetchImpl: async () => { throw weird; }, maxAttempts: 1, ...FAST }),
    e => e === weird);
  const stall = new Error('Stream stalled: no data'); stall.code = 'ESTREAMSTALL';
  assert.equal(friendlyError(stall, { provider: 'anthropic' }), stall, 'the already-clear stall message is untouched');
  assert.equal(missingKeyError('openai').code, 'EMISSINGKEY');
});

/* ---------- agent boundary: the friendly message is what leaves runTurn ---------- */
test('errors: runTurn surfaces the translated message and still rolls the transcript back', async () => {
  const host = {
    memory: { overview: () => ({ me: '', files: [] }), search: () => [] },
    getContext: async () => ({ app: 'a', title: 't', text: 'screen' }),
    takeScreenshot: async () => ({ text: 's' }),
    requestCodexApproval: async () => ({ text: 'ok' }),
    onUsage: () => {},
    // The real stream function with a fake 401 — exactly the first-run path.
    callLLM: args => anthropicStream({ apiKey: 'bad-key', model: 'm', system: 's', messages: args.messages, tools: args.tools, onText: args.onText, fetchImpl: async () => errRes(401), retryBaseMs: 1, sleepImpl: noSleep }),
  };
  const tab = { id: 'x', title: 'New chat', model: 'm', messages: [], display: [], queue: [] };
  await assert.rejects(() => runTurn({ tab, question: 'hello', host }), /Your Anthropic API key was rejected \(401\)/);
  assert.equal(tab.messages.length, 0, 'transcript rolled back — no half-written turn survives');
});
