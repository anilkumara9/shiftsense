'use strict';
/**
 * LLM clients + agent loop.
 * Anthropic Messages API (streaming SSE, tool-use loop) and an
 * OpenAI-compatible client (covers OpenAI + Ollama at localhost:11434).
 * Beats the original (recon §7.3/§7.5): model is a per-tab setting, not a
 * compile-time constant; independent tool calls in one block run in
 * PARALLEL; thinking/effort is user-selectable.
 *
 * AI-engine hardening (v4):
 *  - Prompt caching: the system prompt and the tool list are re-sent on
 *    EVERY loop iteration of EVERY turn, so both are marked
 *    cache_control: ephemeral (system block + last tool — the two stable
 *    breakpoints). Screen/memory content rides in messages and changes
 *    per turn, so caching it would only thrash the cache. Usage already
 *    tracks cacheRead/cacheWrite and the price table already prices them.
 *  - Resilient streaming: up to 3 attempts with backoff + jitter on
 *    transient failures (429 / 529 / 5xx / network errors), honoring
 *    Retry-After (capped at 30s). A retry happens ONLY before the first
 *    text byte reaches onText — once the user has seen streamed text, a
 *    retry would print it twice, so post-first-byte failures fail the
 *    turn instead (agent rollback keeps the transcript clean).
 *  - Stream watchdog: a stream that goes silent for 30s is aborted and
 *    surfaced as a clear error instead of hanging the turn forever.
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

// ---------- resilience: retry policy + stream watchdog ----------
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 800;
const MAX_RETRY_DELAY_MS = 30000;
const STALL_MS = 30000;

function parseRetryAfterMs(headers) {
  try {
    const v = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
    if (!v) return null;
    const secs = Number(v);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const when = Date.parse(v); // HTTP-date form
    return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
  } catch { return null; }
}
function isRetryableError(e) {
  if (!e) return false;
  if (e.code === 'ESTREAMSTALL') return true; // silent stream, nothing shown yet (caller checks emitted)
  if (typeof e.status === 'number') return e.status === 429 || e.status === 529 || e.status >= 500;
  return true; // no status = transport-level failure (DNS, reset, refused) — transient by nature
}
function retryDelayMs(err, attempt, base = RETRY_BASE_MS, rand = Math.random) {
  if (err && typeof err.retryAfterMs === 'number') return Math.min(err.retryAfterMs, MAX_RETRY_DELAY_MS);
  return Math.min(base * 2 ** attempt + rand() * base * 0.25, MAX_RETRY_DELAY_MS);
}
function stallError(stallMs) {
  const e = new Error(`Stream stalled: no data from the provider for ${Math.round(stallMs / 1000)}s, so the turn was stopped instead of hanging. Your message was not lost — send it again.`);
  e.code = 'ESTREAMSTALL';
  return e;
}
/** Per-attempt abort controller linked to the caller's signal, so the
 *  watchdog can kill a single attempt without touching the user's Stop. */
function linkSignal(signal) {
  const ctrl = new AbortController();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl;
}
/** One reader.read() with a silence deadline. On stall: abort the attempt,
 *  cancel the reader, and throw a stall error (retryable only pre-byte). */
async function readWithWatchdog(reader, stallMs, abortAttempt) {
  const readP = reader.read();
  readP.catch(() => { /* if the watchdog wins the race, the late rejection is expected */ });
  let timer = null;
  try {
    return await Promise.race([readP, new Promise((_, reject) => {
      // Reject BEFORE aborting: cancel() queues the pending read's
      // resolution as a microtask, and if that microtask is queued first
      // the race adopts {done:true} and the stall is silently swallowed
      // (found by tests/aiengine.test.js — the turn returned empty).
      timer = setTimeout(() => { reject(stallError(stallMs)); try { abortAttempt(); } catch { /* already gone */ } }, stallMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
/**
 * Run attemptOnce(state) up to maxAttempts times. state.emitted flips true
 * the first time the attempt shows text to the user; after that, ANY
 * failure is final (no duplicate streaming). The user's own Stop
 * (signal aborted) is never retried.
 */
async function runWithRetries(attemptOnce, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const base = opts.retryBaseMs ?? RETRY_BASE_MS;
  const sleep = opts.sleepImpl || (ms => new Promise(r => setTimeout(r, ms)));
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const state = { emitted: false };
    try { return await attemptOnce(state); } catch (e) {
      lastErr = e;
      if (opts.signal && opts.signal.aborted) throw e;
      if (state.emitted) throw e;
      if (!isRetryableError(e)) throw e;
      if (attempt === maxAttempts - 1) break;
      await sleep(retryDelayMs(e, attempt, base, opts.randImpl || Math.random));
    }
  }
  throw lastErr;
}
async function httpError(provider, res) {
  const t = await res.text().catch(() => '');
  const e = new Error(`${provider} ${res.status}: ${t.slice(0, 300)}`);
  e.status = res.status;
  const ra = parseRetryAfterMs(res.headers);
  if (ra !== null) e.retryAfterMs = ra;
  return e;
}

/** Anthropic streaming call. Returns {text, toolUses, usage, stopReason, content}. */
async function anthropicStream({ apiKey, model, system, messages, tools, effort = 'low', maxTokens = 64000, onText, fetchImpl = fetch, signal, maxAttempts, retryBaseMs, stallMs = STALL_MS, sleepImpl, randImpl }) {
  // Cache breakpoints (ephemeral, 5-min TTL): system block + last tool.
  // Cloned — the caller's tool schemas are never mutated.
  const cachedTools = tools && tools.length
    ? tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t))
    : undefined;
  const body = {
    model, max_tokens: maxTokens, stream: true,
    system: typeof system === 'string' && system
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : system,
    messages, tools: cachedTools,
    ...(effort && effort !== 'low' ? { output_config: { effort } } : {}),
  };
  return runWithRetries(async state => {
    const emit = d => { state.emitted = true; if (onText) onText(d); };
    const ctrl = linkSignal(signal);
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await httpError('Anthropic', res);
    if (!res.body || typeof res.body.getReader !== 'function') throw new Error('Anthropic: provider returned no stream body');
    const reader = res.body.getReader(); const dec = new TextDecoder();
    const abortAttempt = () => { ctrl.abort(); reader.cancel().catch(() => {}); };
    let buf = '', text = ''; const toolUses = [];
    const blocks = new Map(); // index -> builder; thinking blocks are kept WITH signatures (audit M7: dropping them can 400 tool-loop follow-ups at medium/high effort)
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }; let stopReason = null;
    for (;;) {
      const { done, value } = await readWithWatchdog(reader, stallMs, abortAttempt); if (done) break;
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
          if (d.type === 'text_delta') { text += d.text; if (b) b.text += d.text; emit(d.text); }
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
  }, { signal, maxAttempts, retryBaseMs, sleepImpl, randImpl });
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
/** OpenAI-compatible streaming call (OpenAI API or Ollama /v1) WITH tool calling.
 *  Same resilience contract as anthropicStream (retry pre-first-byte only,
 *  Retry-After honored, 30s stream watchdog). OpenAI prompt caching is
 *  automatic server-side, so there is nothing to mark here. */
async function openaiStream({ apiKey, baseURL = 'https://api.openai.com/v1', model, system, messages, tools, onText, fetchImpl = fetch, signal, maxAttempts, retryBaseMs, stallMs = STALL_MS, sleepImpl, randImpl }) {
  const url = `${baseURL.replace(/\/$/, '')}/chat/completions`;
  const payload = JSON.stringify({ model, messages: toOpenAIMessages(system, messages), tools: tools && tools.length ? toOpenAITools(tools) : undefined, stream: true, stream_options: { include_usage: true } });
  return runWithRetries(async state => {
    const emit = d => { state.emitted = true; if (onText) onText(d); };
    const ctrl = linkSignal(signal);
    const res = await fetchImpl(url, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: payload,
    });
    if (!res.ok) throw await httpError('OpenAI-compatible', res);
    if (!res.body || typeof res.body.getReader !== 'function') throw new Error('OpenAI-compatible: provider returned no stream body');
    const reader = res.body.getReader(); const dec = new TextDecoder();
    const abortAttempt = () => { ctrl.abort(); reader.cancel().catch(() => {}); };
    let buf = '', text = ''; const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const calls = new Map(); // index -> {id, name, args}
    for (;;) {
      const { done, value } = await readWithWatchdog(reader, stallMs, abortAttempt); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split(/\r?\n/); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue; const d = line.slice(5).trim(); if (!d || d === '[DONE]') continue;
        let ev; try { ev = JSON.parse(d); } catch { continue; }
        const delta = ev.choices?.[0]?.delta;
        if (delta?.content) { text += delta.content; emit(delta.content); }
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
  }, { signal, maxAttempts, retryBaseMs, sleepImpl, randImpl });
}
module.exports = { parseSSE, anthropicStream, openaiStream, toOpenAIMessages, toOpenAITools, resolveModel, isRetryableError, retryDelayMs, parseRetryAfterMs, MAX_ATTEMPTS, STALL_MS, MAX_RETRY_DELAY_MS };
