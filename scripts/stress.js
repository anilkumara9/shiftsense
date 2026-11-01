'use strict';
/* Heavy-load stress pass (npm run stress). Simulates a power user's real
   accumulated state and asserts the core stays fast and exact. Not shipped
   in the packaged app (scripts/ is outside the builder whitelist). */
const fs = require('fs'); const os = require('os'); const path = require('path');
const assert = require('node:assert');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dshift-stress-'));
const time = async (label, fn, budget = 5000) => { const t0 = process.hrtime.bigint(); const r = await fn(); const ms = Number(process.hrtime.bigint() - t0) / 1e6; console.log(`${label.padEnd(46)} ${ms.toFixed(1).padStart(9)} ms`); assert.ok(ms < budget, `${label} too slow: ${ms}ms (budget ${budget}ms)`); return r; };

(async () => {
  const { ChatStore } = require('../src/chatStore');
  const { MemoryStore } = require('../src/memory');
  const { SpendLedger, costOf } = require('../src/spend');
  const { ApprovalQueue } = require('../src/approvalQueue');
  const { serializeTree } = require('../src/contextEngine');
  const { trimTranscript } = require('../src/agent');

  // 50 tabs x 40 messages, save + reload
  const dir = tmp(); const store = new ChatStore(dir);
  // Batch-import throughput is O(history) per save by design (single-file
  // store, sync save per message is a tested crash-safety contract) — the
  // budget here only guards against pathological blowups. The invariant
  // that matters for real use is per-save latency at full size, below.
  await time('create 50 tabs x 40 display msgs (batch)', () => {
    for (let i = 0; i < 49; i++) store.newTab();
    for (const t of store.tabs) for (let j = 0; j < 40; j++) { store.addDisplay(t, { role: j % 2 ? 'assistant' : 'user', text: 'message '.repeat(20) + j }); t.messages.push({ role: 'user', content: 'x'.repeat(500) }); }
    store.save();
  }, 20000);
  store.tabs[0].display.push({ role: 'user', text: 'latency probe' });
  await time('ONE save at full 50-tab size (per-turn cost)', () => { store._lastSaved = null; store.save(); }, 500);
  const size = fs.statSync(store.file).size; console.log(`${'chats.json size'.padEnd(46)} ${(size / 1024).toFixed(0).padStart(9)} KB`);
  await time('reload 50 tabs + repair pass', () => { const s2 = new ChatStore(dir); assert.equal(s2.tabs.length, 50); });
  await time('200 no-op saves (dirty-check)', () => { for (let i = 0; i < 200; i++) store.save(); });

  // 1,000 memory files: search + audit chain
  const mdir = tmp(); const mem = new MemoryStore(mdir).seed();
  await time('seed 1,000 memory files', () => { for (let i = 0; i < 1000; i++) mem.write(`people/person-${i}.md`, `# Person ${i}\nWorks on project ${i % 37}. Likes topic ${i % 11}.`, 'replace', 'stress'); });
  await time('ranked search over 1,000 files x20 queries', () => { for (let i = 0; i < 20; i++) { const hits = mem.search('project 12'); assert.ok(hits.length > 0); } });
  await time('verifyAudit over 1,000 chained writes', () => { const v = mem.verifyAudit(); assert.ok(v === true || v.ok === true || v.valid === true, JSON.stringify(v)); });

  // UIA serializer at the node cap
  const mk = (d, breadth) => ({ type: 'Pane', name: 'n'.repeat(30), children: d ? Array.from({ length: breadth }, () => mk(d - 1, breadth)) : [] });
  const tree = mk(5, 6); // 9,330 nodes pre-cap
  const snap = await time('serialize 9,330-node tree (cap 3,000)', () => serializeTree(tree));
  assert.ok(snap.text.length <= 60000 + 64, `serialized ${snap.text.length} chars exceeds cap`);

  // ledger: 10k adds exactness
  const ldir = tmp(); const led = new SpendLedger(ldir);
  await time('10,000 ledger adds', () => { for (let i = 0; i < 10000; i++) led.add(0.0001); });
  assert.ok(Math.abs(led.spentToday() - 1.0) < 1e-6, `ledger drift: ${led.spentToday()}`);
  await time('1,000 reserve/settle/release cycles', () => { for (let i = 0; i < 1000; i++) { const r = led.reserve(0.01); if (i % 2) led.settle(r, 0.005); else led.release(r); } });

  // approvals: 100 serialized asks
  let presented = 0; const q = new ApprovalQueue({ timeoutMs: 50, present: (p, finish) => { presented++; setTimeout(() => finish(presented % 3 !== 0), 1); } });
  const results = await time('100 serialized approvals', async () => Promise.all(Array.from({ length: 100 }, (_, i) => q.ask({ task: 't' + i }))));
  assert.equal(results.length, 100); assert.equal(q.size, 0);

  // transcript trimming on a huge tab
  const bigTab = { messages: [{ role: 'user', content: 'first' }] };
  for (let i = 0; i < 500; i++) { bigTab.messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'x' + i, name: 'read_screen', input: {} }] }); bigTab.messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x' + i, content: 'y'.repeat(2000) }] }); }
  await time('trim 1,001-message transcript', () => { trimTranscript(bigTab); assert.ok(bigTab.messages.length <= 24); });

  console.log('\nSTRESS PASS — all within budget, totals exact');
})().catch(e => { console.error('STRESS FAIL:', e.message); process.exit(1); });
