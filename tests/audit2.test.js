'use strict';
/* Regression tests for the independent AUDIT_V1 (2 blockers, 11 majors). */
const test = require('node:test');
const assert = require('node:assert');
const { ApprovalQueue } = require('../src/approvalQueue');
const { repairTranscript } = require('../src/chatStore');
const { resolveModel, anthropicStream } = require('../src/llm');
const { trimTranscript } = require('../src/agent');
const { spawnOptionsFor } = require('../src/codex');

test('B2: approvals serialize — one card at a time, FIFO, all resolve', async () => {
  const presented = [];
  const q = new ApprovalQueue({ present: (p, finish) => presented.push({ p, finish }), timeoutMs: 1000 });
  const a = q.ask({ task: 'first' }); const b = q.ask({ task: 'second' });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(presented.length, 1); assert.equal(presented[0].p.task, 'first'); // second NOT shown yet
  presented[0].finish(true);
  assert.equal(await a, true);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(presented.length, 2); assert.equal(presented[1].p.task, 'second');
  presented[1].finish(false);
  assert.equal(await b, false);
});
test('B2: approval timeout and Stop (cancelAll) resolve as deny — never hang', async () => {
  const q = new ApprovalQueue({ present: () => {}, timeoutMs: 30 });
  assert.equal(await q.ask({ task: 'walked away' }), false);
  const q2 = new ApprovalQueue({ present: () => {}, timeoutMs: 60000 });
  const p = q2.ask({ task: 'stopped' }); q2.cancelAll();
  assert.equal(await p, false);
});
test('M2: dangling tool_use is truncated on repair; healthy transcripts untouched', () => {
  const healthy = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'read_screen', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'x' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ];
  assert.equal(repairTranscript(healthy).length, 4);
  const broken = [...healthy.slice(0, 2), { role: 'assistant', content: [{ type: 'text', text: 'ghost' }] }];
  const fixed = repairTranscript(broken);
  assert.equal(fixed.length, 1); // dangling assistant + everything after it dropped
});
test('M1: provider/model remap prevents cross-provider 400/404s', () => {
  assert.equal(resolveModel('openai', 'claude-sonnet-5-5'), 'gpt-5');
  assert.equal(resolveModel('anthropic', 'gpt-5'), 'claude-sonnet-5-5');
  assert.equal(resolveModel('anthropic', 'claude-opus-5-5'), 'claude-opus-5-5');
  assert.equal(resolveModel('ollama', 'claude-sonnet-5-5'), 'llama3.1');
  assert.equal(resolveModel('ollama', 'ollama:qwen2.5'), 'qwen2.5');
  assert.equal(resolveModel('openai', 'gpt-5-mini'), 'gpt-5-mini');
});
test('M7: thinking blocks survive the stream with signatures', async () => {
  const sse = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"SIG123"}}',
    'data: {"type":"content_block_stop","index":0}',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"text"}}',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"answer"}}',
    'data: {"type":"content_block_stop","index":1}',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
  ].join('\n') + '\n';
  const fakeFetch = async () => ({ ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }) });
  const r = await anthropicStream({ apiKey: 'k', model: 'm', system: 's', messages: [], fetchImpl: fakeFetch });
  assert.deepEqual(r.content[0], { type: 'thinking', thinking: 'hmm', signature: 'SIG123' });
  assert.equal(r.content[1].text, 'answer');
});
test('M9: transcript windowing keeps head + recent and never orphans a tool_result', () => {
  const tab = { messages: [{ role: 'user', content: 'first' }] };
  for (let i = 0; i < 20; i++) {
    tab.messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'read_screen', input: {} }] });
    tab.messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'x' }] });
  }
  trimTranscript(tab);
  assert.ok(tab.messages.length <= 24);
  assert.equal(tab.messages[0].content, 'first');
  const ids = new Set(); for (const m of tab.messages) if (Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool_use') ids.add(b.id);
  for (const m of tab.messages) if (Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool_result') assert.ok(ids.has(b.tool_use_id), 'no orphaned tool_result');
});
test('M10: Windows .cmd shims get shell spawn; real exes do not', () => {
  assert.deepEqual(spawnOptionsFor('C:\\Users\\x\\AppData\\Roaming\\npm\\codex.cmd', 'win32'), { shell: true });
  assert.deepEqual(spawnOptionsFor('C:\\Program Files\\Codex\\codex.exe', 'win32'), {});
  assert.deepEqual(spawnOptionsFor('/usr/local/bin/codex', 'darwin'), {});
});
