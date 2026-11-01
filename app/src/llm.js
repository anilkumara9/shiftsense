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
      let buf = '', text = ''; const toolUses = []; let current = null;
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
          if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') current = { id: ev.content_block.id, name: ev.content_block.name, json: '' };
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') { text += ev.delta.text; if (onText) onText(ev.delta.text); }
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta' && current) current.json += ev.delta.partial_json || '';
          if (ev.type === 'content_block_stop' && current) { let input = {}; try { input = JSON.parse(current.json || '{}'); } catch { /* validated by registry */ } toolUses.push({ id: current.id, name: current.name, input }); current = null; }
        }
      }
      return { text, toolUses, usage, stopReason };
    } catch (e) {
      lastErr = e;
      if (e.name === 'AbortError' || (e.status && e.status < 500 && e.status !== 429)) throw e;
      if (attempt === 0) await new Promise(r => setTimeout(r, 800));
    }
  }
  throw lastErr;
}
/** OpenAI-compatible streaming call (OpenAI API or Ollama /v1). Tool support: chat-completions style. */
async function openaiStream({ apiKey, baseURL = 'https://api.openai.com/v1', model, system, messages, onText, fetchImpl = fetch, signal }) {
  const msgs = [{ role: 'system', content: system }, ...messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }))];
  const res = await fetchImpl(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model, messages: msgs, stream: true, stream_options: { include_usage: true } }),
  });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw Object.assign(new Error(`OpenAI-compatible ${res.status}: ${t.slice(0, 300)}`), { status: res.status }); }
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = '', text = ''; const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split(/\r?\n/); buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue; const d = line.slice(5).trim(); if (!d || d === '[DONE]') continue;
      let ev; try { ev = JSON.parse(d); } catch { continue; }
      const delta = ev.choices?.[0]?.delta?.content; if (delta) { text += delta; if (onText) onText(delta); }
      if (ev.usage) { usage.input = ev.usage.prompt_tokens || 0; usage.output = ev.usage.completion_tokens || 0; usage.cacheRead = ev.usage.prompt_tokens_details?.cached_tokens || 0; }
    }
  }
  return { text, toolUses: [], usage, stopReason: 'end_turn' };
}
module.exports = { parseSSE, anthropicStream, openaiStream };
