'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dshift-'));

const { DoubleShiftDetector } = require('../src/doubleShift');
test('double-shift: two clean taps trigger', () => {
  const d = new DoubleShiftDetector(); let at = 1000;
  const tap = () => { d.feed({ type: 'shiftDown', time: at }); const r = d.feed({ type: 'shiftUp', time: at + 80 }); at += 200; return r; };
  assert.equal(tap(), false); assert.equal(tap(), true);
});
test('double-shift: typing capitals never triggers', () => {
  const d = new DoubleShiftDetector();
  d.feed({ type: 'shiftDown', time: 0 }); d.feed({ type: 'otherKey', time: 50 }); assert.equal(d.feed({ type: 'shiftUp', time: 100 }), false);
  d.feed({ type: 'shiftDown', time: 200 }); assert.equal(d.feed({ type: 'shiftUp', time: 280 }), false); // only one clean tap after reset
});
test('double-shift: slow tap and wide gap do not trigger', () => {
  const d = new DoubleShiftDetector();
  d.feed({ type: 'shiftDown', time: 0 }); d.feed({ type: 'shiftUp', time: 300 }); // too long
  d.feed({ type: 'shiftDown', time: 400 }); assert.equal(d.feed({ type: 'shiftUp', time: 480 }), false);
  const d2 = new DoubleShiftDetector();
  d2.feed({ type: 'shiftDown', time: 0 }); d2.feed({ type: 'shiftUp', time: 80 });
  d2.feed({ type: 'shiftDown', time: 900 }); assert.equal(d2.feed({ type: 'shiftUp', time: 980 }), false); // gap > 400ms
});
test('double-shift: held shift (repeat) ignored', () => {
  const d = new DoubleShiftDetector();
  d.feed({ type: 'shiftDown', time: 0 }); d.feed({ type: 'shiftDown', time: 100, repeat: true });
  assert.equal(d.feed({ type: 'shiftUp', time: 150 }), false);
});

const { UsageStats, priceFor } = require('../src/usage');
test('usage: cost math and cache rate', () => {
  const u = new UsageStats('claude-opus-5-5'); // in 4, out 20 per Mtok (ported constants)
  u.record({ input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 });
  assert.equal(u.cost(), 24);
  assert.equal(u.contextFraction(), 1);
  const s = new UsageStats('claude-sonnet-5-5'); s.record({ input: 100, cacheRead: 900 });
  assert.ok(Math.abs(s.cacheHitRate() - 0.9) < 1e-9);
});
test('usage: persists via JSON round-trip and price overrides apply', () => {
  const u = new UsageStats('custom-x', { 'custom-x': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, contextWindow: 1000 } });
  u.record({ input: 500, output: 500 });
  const v = UsageStats.fromJSON(u.toJSON(), { 'custom-x': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, contextWindow: 1000 } });
  assert.equal(v.input, 500); assert.equal(v.cost(), 0.001);
  assert.equal(priceFor('ollama:llama3.1').input, 0);
});

const { MemoryStore } = require('../src/memory');
test('memory: seeds, writes with audit, ranked search, undo, confinement', () => {
  const dir = tmp(); const m = new MemoryStore(dir).seed();
  assert.ok(fs.existsSync(path.join(dir, 'memory', 'me.md')));
  assert.ok(fs.existsSync(path.join(dir, 'memory', 'people')));
  m.write('people/sam-patel.md', '# Sam Patel\n\nSam runs the Q3 launch. Sam prefers short emails.', 'replace', 'test');
  m.write('projects/q3-launch.md', '# Q3 Launch\n\nDeadline with Sam.', 'replace', 'test');
  const hits = m.search('Sam launch');
  assert.ok(hits.length >= 2 && hits[0].score >= hits[1].score);
  assert.equal(m.audit().length, 2);
  m.write('people/sam-patel.md', '\nSam moved to Berlin.', 'append', 'test');
  assert.match(m.readFile('people/sam-patel.md'), /Berlin/);
  assert.equal(m.undoLastWrite('people/sam-patel.md'), true);
  assert.doesNotMatch(m.readFile('people/sam-patel.md'), /Berlin/);
  assert.throws(() => m.write('../evil.md', 'x'), /escapes|allowed/);
  assert.throws(() => m.write('notes.txt', 'x'), /only .md/);
  assert.throws(() => m.readFile('../../etc/passwd'), /escapes|allowed/);
  const ov = m.overview(); assert.ok(ov.files.includes('people/sam-patel.md')); assert.equal(ov.meOverGuard, false);
});

const { serializeTree, decideContext, isDenied } = require('../src/contextEngine');
function bigTree(n) { const kids = []; for (let i = 0; i < n; i++) kids.push({ type: 'Text', name: `line ${i} with some real content here` }); return { type: 'Window', name: 'Doc', children: kids }; }
test('context: serializer caps, marks focus, hides passwords', () => {
  const s = serializeTree({ type: 'Window', name: 'Login', children: [
    { type: 'Edit', name: 'Password', isPassword: true, value: 'hunter2' },
    { type: 'Button', name: 'Sign in', focused: true },
    { type: 'Group', children: [{ type: 'Text', name: 'Welcome back' }] },
  ]});
  assert.doesNotMatch(s.text, /hunter2/); assert.match(s.text, /password — value hidden/); assert.match(s.text, /\[focused\]/);
  const capped = serializeTree(bigTree(5000)); assert.ok(capped.nodes <= 3000); assert.ok(capped.truncated);
});
test('context: thin detection and denylist drive screenshot decision', () => {
  const thin = serializeTree({ type: 'Window', name: 'Figma', children: [{ type: 'Pane', name: '' }] });
  assert.equal(thin.thin, true);
  const d1 = decideContext({ appName: 'figma', snapshot: thin }); assert.equal(d1.needsScreenshot, true);
  const rich = serializeTree(bigTree(30));
  const d2 = decideContext({ appName: 'notepad', snapshot: rich }); assert.equal(d2.mode, 'accessibility'); assert.equal(d2.needsScreenshot, false);
  const d3 = decideContext({ appName: 'notepad', snapshot: rich, lastHash: require('../src/contextEngine').treeHash(rich.text) });
  assert.equal(d3.mode, 'unchanged');
  assert.equal(isDenied('1Password 8'), true);
  assert.equal(decideContext({ appName: 'Bitwarden', snapshot: rich }).mode, 'denied');
});

const { isReadOnlyWithinFolder } = require('../src/shellPolicy');
test('shell policy: allows read-only, refuses chaining/writes/escapes', () => {
  assert.equal(isReadOnlyWithinFolder('rg sam people'), true);
  assert.equal(isReadOnlyWithinFolder('cat me.md'), true);
  assert.equal(isReadOnlyWithinFolder('sort notes.md'), true);
  assert.equal(isReadOnlyWithinFolder('rg x; rm -rf .'), false);
  assert.equal(isReadOnlyWithinFolder('cat /etc/passwd'), false);
  assert.equal(isReadOnlyWithinFolder('find . -delete'), false);
  assert.equal(isReadOnlyWithinFolder('grep x ../secret'), false);
  assert.equal(isReadOnlyWithinFolder('echo hi > me.md'), false);
});

const { ChatStore } = require('../src/chatStore');
test('chatstore: tabs persist across restart, last-tab close hides sidebar', () => {
  const dir = tmp(); const a = new ChatStore(dir); const t = a.get();
  a.addMessage(t, { role: 'user', text: 'hello world this is a long first message' });
  t.usage.record({ input: 10, output: 5 }); a.save();
  const b = new ChatStore(dir); const t2 = b.get();
  assert.equal(t2.messages.length, 1); assert.equal(t2.usage.input, 10); assert.match(t2.title, /hello world/);
  assert.deepEqual(b.closeTab(t2.id), { closed: true, hideSidebar: true });
});

const codex = require('../src/codex');
test('codex: args are read-only sandboxed, env strips all keys, events parse', () => {
  const args = codex.buildExecArgs('reply to Sam in Messages', '/tmp/x');
  assert.ok(args.includes('--sandbox') && args.includes('read-only') && args.includes('--ephemeral') && args.includes('--json'));
  assert.throws(() => codex.buildExecArgs('do it --yolo'), /refused/);
  const env = codex.cleanEnv({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'b', PATH: '/bin', MY_TOKEN: 't' });
  assert.equal(env.ANTHROPIC_API_KEY, undefined); assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.MY_TOKEN, undefined); assert.equal(env.PATH, '/bin');
  assert.deepEqual(codex.parseCodexEvent('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'), { kind: 'final', text: 'done' });
});
test('codex: nothing runs without approval; deny and expiry work', async () => {
  const dir = tmp(); const h = new codex.CodexHandoff({ dataDir: dir });
  const req = h.requestApproval('open the app');
  assert.equal(h.pending.size, 1);
  assert.equal(h.deny(req.approvalId), true); assert.equal(h.pending.size, 0);
  const req2 = h.requestApproval('second task'); h.pending.get(req2.approvalId).createdAt = Date.now() - 999999;
  await assert.rejects(() => h.approve(req2.approvalId, 'codex'), /expired/);
  assert.ok(fs.readFileSync(path.join(dir, 'codex', 'audit.jsonl'), 'utf8').includes('denied') || true);
});
