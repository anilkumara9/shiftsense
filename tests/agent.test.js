'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { runTurn } = require('../src/agent');
const { MemoryStore } = require('../src/memory');
const { parseSSE, anthropicStream } = require('../src/llm');

function fakeHost(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshift-agent-'));
  const memory = new MemoryStore(dir).seed();
  let call = 0;
  return {
    memory, usages: [],
    getContext: async () => ({ app: 'notepad', title: 'notes.txt', text: 'Window "notes.txt"\n  Text "hello screen"' }),
    takeScreenshot: async () => ({ text: 'shot', jpegBase64: 'AAAA' }),
    requestCodexApproval: async task => ({ text: `codex did: ${task}` }),
    onUsage: u => {}, 
    callLLM: async () => script[Math.min(call++, script.length - 1)],
  };
}
const tab = () => ({ id: 't1', title: 'New chat', model: 'claude-sonnet-5-5', messages: [], queue: [] });

test('agent: plain answer completes in one iteration and carries screen+memory blocks', async () => {
  const host = fakeHost([{ text: 'The screen says hello.', toolUses: [], usage: { input: 5, output: 5 }, stopReason: 'end_turn' }]);
  const t = tab(); const r = await runTurn({ tab: t, question: 'what is on screen?', host });
  assert.equal(r.ok, true); assert.match(t.messages[0].content, /<screen/); assert.match(t.messages[0].content, /<memory>/);
});
test('agent: tool loop runs read_screen then answers; screenshot capped at 1', async () => {
  const shot = { text: '', toolUses: [{ id: '1', name: 'take_screenshot', input: {} }, { id: '2', name: 'take_screenshot', input: {} }], stopReason: 'tool_use' };
  const fin = { text: 'done', toolUses: [], stopReason: 'end_turn' };
  const host = fakeHost([shot, fin]); const t = tab();
  const r = await runTurn({ tab: t, question: 'describe the chart', host });
  assert.equal(r.ok, true);
  const toolMsg = t.messages.find(m => Array.isArray(m.content) && m.content[0]?.type === 'tool_result');
  assert.equal(toolMsg.content[0].is_error, undefined);
  assert.equal(toolMsg.content[1].is_error, true); // second screenshot refused by cap
  assert.match(toolMsg.content[1].content, /Limit reached/);
});
test('agent: memory write then search round-trips inside a turn', async () => {
  const w = { text: '', toolUses: [{ id: '1', name: 'write_memory', input: { path: 'people/sam.md', content: '# Sam\nSam likes tea.' } }], stopReason: 'tool_use' };
  const s = { text: '', toolUses: [{ id: '2', name: 'search_memory', input: { query: 'Sam tea' } }], stopReason: 'tool_use' };
  const fin = { text: 'Sam likes tea.', toolUses: [], stopReason: 'end_turn' };
  const host = fakeHost([w, s, fin]); const t = tab();
  await runTurn({ tab: t, question: 'remember Sam likes tea, who likes tea?', host });
  const results = t.messages.filter(m => Array.isArray(m.content) && m.content[0]?.type === 'tool_result');
  assert.match(JSON.stringify(results[1].content), /Sam likes tea/);
});
test('agent: LLM failure rolls the transcript back', async () => {
  const host = fakeHost([]); host.callLLM = async () => { throw new Error('network down'); };
  const t = tab(); t.messages.push({ role: 'user', content: 'earlier' });
  await assert.rejects(() => runTurn({ tab: t, question: 'q', host }), /network down/);
  assert.equal(t.messages.length, 1);
});
test('llm: SSE parser and anthropic stream accumulate text, tools, usage', async () => {
  const events = []; parseSSE('data: {"a":1}\n\ndata: [DONE]\n', e => events.push(e)); assert.equal(events.length, 1);
  const sse = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":4}}}',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu1","name":"read_screen"}}',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}',
    'data: {"type":"content_block_stop","index":1}',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}',
  ].join('\n') + '\n';
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } });
  const fakeFetch = async () => ({ ok: true, body: stream });
  let seen = ''; const r = await anthropicStream({ apiKey: 'k', model: 'm', system: 's', messages: [], onText: d => seen += d, fetchImpl: fakeFetch });
  assert.equal(r.text, 'Hello world'); assert.equal(seen, 'Hello world');
  assert.equal(r.toolUses[0].name, 'read_screen'); assert.equal(r.usage.input, 10); assert.equal(r.usage.output, 7); assert.equal(r.stopReason, 'tool_use');
});
