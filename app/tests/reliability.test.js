'use strict';
/* Reliability lane: crash-safety & data integrity for persisted state.
   Kill-mid-write simulation, .bak fallback, atomic rename behavior,
   ledger rollover with an injected clock, reserve/settle cap race,
   and exact UsageStats round-trips. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dshift-rel-'));
const noTmpLitter = dir => fs.readdirSync(dir).filter(f => f.includes('.tmp-'));

const { ChatStore } = require('../src/chatStore');
const { SpendLedger } = require('../src/spend');
const { UsageStats } = require('../src/usage');
const { MemoryStore } = require('../src/memory');

/* ---------------- ChatStore: atomic writes + .bak + recovery ---------------- */

test('chats: save is atomic (bak holds previous payload, no temp litter)', () => {
  const dir = tmp(); const s = new ChatStore(dir);
  const t = s.get();
  s.addDisplay(t, { role: 'user', text: 'payload one' });
  const bak1 = JSON.parse(fs.readFileSync(path.join(dir, 'chats.json.bak'), 'utf8'));
  assert.equal(bak1.tabs.length, 1); assert.equal(bak1.tabs[0].display.length, 0); // constructor's save
  s.addDisplay(t, { role: 'assistant', text: 'payload two' });
  const bak2 = JSON.parse(fs.readFileSync(path.join(dir, 'chats.json.bak'), 'utf8'));
  assert.equal(bak2.tabs[0].display.length, 1); // previous good payload
  const main = JSON.parse(fs.readFileSync(path.join(dir, 'chats.json'), 'utf8'));
  assert.equal(main.tabs[0].display.length, 2);
  assert.deepEqual(noTmpLitter(dir), []);
});

test('chats: kill-mid-write (truncated chats.json) recovers from .bak, flags it, heals main', () => {
  const dir = tmp(); const s = new ChatStore(dir);
  const t = s.get();
  s.addDisplay(t, { role: 'user', text: 'alpha question' });   // payload P1
  s.addDisplay(t, { role: 'assistant', text: 'beta answer' }); // payload P2 (P1 now in .bak)
  // simulate power loss mid-write: main file is a torn prefix of P2
  const full = fs.readFileSync(path.join(dir, 'chats.json'), 'utf8');
  fs.writeFileSync(path.join(dir, 'chats.json'), full.slice(0, Math.floor(full.length / 2)));
  const s2 = new ChatStore(dir);
  assert.equal(s2.recoveryInfo.chatsFromBackup, true);
  assert.equal(s2.tabs.length, 1);
  assert.equal(s2.tabs[0].display.length, 1);                    // P1 state, not empty, not P2
  assert.equal(s2.tabs[0].display[0].text, 'alpha question');
  assert.equal(s2.tabs[0].title, 'alpha question');
  const healed = JSON.parse(fs.readFileSync(path.join(dir, 'chats.json'), 'utf8')); // main healed by recovery save
  assert.equal(healed.tabs[0].display.length, 1);
  const s3 = new ChatStore(dir);                                  // next launch: no recovery needed
  assert.equal(s3.recoveryInfo.chatsFromBackup, false);
  assert.equal(s3.tabs[0].display.length, 1);
});

test('chats: missing main file with a .bak present also recovers', () => {
  const dir = tmp(); const s = new ChatStore(dir);
  const t = s.get();
  s.addDisplay(t, { role: 'user', text: 'keep me' });
  s.addDisplay(t, { role: 'assistant', text: 'kept' });
  fs.unlinkSync(path.join(dir, 'chats.json'));
  const s2 = new ChatStore(dir);
  assert.equal(s2.recoveryInfo.chatsFromBackup, true);
  assert.equal(s2.tabs[0].display.length, 1);
});

test('chats: save() dirty-check skips the write when the payload is unchanged', () => {
  const dir = tmp(); const s = new ChatStore(dir);
  const f = path.join(dir, 'chats.json');
  const mtime = fs.statSync(f).mtimeMs;
  s.save(); s.save();
  assert.equal(fs.statSync(f).mtimeMs, mtime); // untouched: no rewrite happened
  s.tabs[0].title = 'changed title'; s.save();
  assert.ok(fs.readFileSync(f, 'utf8').includes('changed title'));
});

test('archive: corrupt archive.json falls back to archive.json.bak', () => {
  const dir = tmp(); const s = new ChatStore(dir);
  const a = s.get(); s.addDisplay(a, { role: 'user', text: 'first archived chat' });
  const b = s.newTab(); s.addDisplay(b, { role: 'user', text: 'second archived chat' });
  s.closeTab(a.id); // archive.json = [a]
  s.closeTab(b.id); // archive.json = [b, a], .bak = [a]
  fs.writeFileSync(path.join(dir, 'archive.json'), '{"torn');
  const list = s.listArchive();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, a.id);
  assert.equal(s.recoveryInfo.archiveFromBackup, true);
});

/* ---------------- SpendLedger: rollover, recovery, reserve ---------------- */

const DAY1 = () => new Date(2026, 10, 1, 23, 59, 30); // local time

test('spend: day rollover with injected clock resets at LOCAL midnight', () => {
  const dir = tmp(); let clock = DAY1();
  const led = new SpendLedger(dir, { now: () => clock });
  assert.equal(led.add(1.25), 1.25);
  assert.equal(led.spentToday(), 1.25);
  clock = new Date(2026, 10, 2, 0, 0, 30);
  assert.equal(led.spentToday(), 0);            // rolled over before any add
  assert.equal(led.add(0.5), 0.5);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'spend.json'), 'utf8'));
  assert.deepEqual(onDisk, { day: '2026-11-02', usd: 0.5 });
  const fresh = new SpendLedger(dir, { now: () => clock });
  assert.equal(fresh.spentToday(), 0.5);        // day-2 file read on day 2
  const stale = new SpendLedger(dir, { now: DAY1 });
  assert.equal(stale.spentToday(), 0);          // day-2 file is stale on day 1
  assert.equal(stale.recoveredFromBackup, false); // stale is not corruption
});

test('spend: corrupt spend.json recovers the .bak total and flags it', () => {
  const dir = tmp(); const now = () => new Date(2026, 10, 1, 12, 0, 0);
  const led = new SpendLedger(dir, { now });
  led.add(0.25); led.add(0.25);
  assert.equal(led.spentToday(), 0.5);
  fs.writeFileSync(path.join(dir, 'spend.json'), '{"day":"2026-11-01","usd":'); // torn write
  const led2 = new SpendLedger(dir, { now });
  assert.equal(led2.recoveredFromBackup, true);
  assert.equal(led2.spentToday(), 0.25); // .bak = total after the first add
  assert.deepEqual(noTmpLitter(dir), []);
});

test('spend: corruption after a SINGLE write still recovers (mirror covers the first write)', () => {
  const dir = tmp(); const now = () => new Date(2026, 10, 1, 8, 0, 0);
  const led = new SpendLedger(dir, { now });
  led.add(4.25);
  assert.equal(fs.existsSync(led.file + '.bak'), false); // rotation has nothing to rotate yet
  fs.writeFileSync(led.file, '{"day":');                 // torn mid-write
  const led2 = new SpendLedger(dir, { now });
  assert.equal(led2.spentToday(), 4.25);                 // NOT zeroed: the cap must not fail open
  assert.equal(led2.recoveredFromBackup, true);
});

test('spend: a parseable stale-day main file is authoritative — backups are not consulted', () => {
  const dir = tmp(); const now = () => new Date(2026, 10, 1, 8, 0, 0);
  const led = new SpendLedger(dir, { now });
  led.add(1.5); // main + mirror both hold today's 1.5
  fs.writeFileSync(led.file, JSON.stringify({ day: '2000-01-01', usd: 9.99 })); // yesterday's file
  const led2 = new SpendLedger(dir, { now });
  assert.equal(led2.spentToday(), 0); // stale day reads as a fresh day, mirror ignored
  assert.equal(led2.recoveredFromBackup, false);
});

test('spend: reserve/settle closes the check-then-add cap race', () => {
  const dir = tmp(); const now = () => new Date(2026, 10, 1, 9, 0, 0);
  const led = new SpendLedger(dir, { now });
  led.add(0.25);
  const r = led.reserve(0.5);                       // an in-flight call's estimate
  assert.equal(led.exceeded(0.5), false);           // old spent-only check passes…
  assert.equal(led.wouldExceed(0.5), true);         // …but spent+reserved is over the cap
  led.settle(r, 0.125);                             // actual cost lands
  assert.equal(led.reservedTotal(), 0);
  assert.equal(led.spentToday(), 0.375);
  const r2 = led.reserve(0.25); led.release(r2);    // failed call: no charge
  assert.equal(led.reservedTotal(), 0);
  assert.equal(led.spentToday(), 0.375);
});

test('spend: add() merges a larger same-day total written by another process', () => {
  const dir = tmp(); const now = () => new Date(2026, 10, 1, 9, 0, 0);
  const led = new SpendLedger(dir, { now });
  led.add(0.25);
  fs.writeFileSync(path.join(dir, 'spend.json'), JSON.stringify({ day: '2026-11-01', usd: 0.75 }));
  assert.equal(led.add(0.25), 1); // adopted 0.75 instead of clobbering with 0.25+0.25
});

/* ---------------- UsageStats: exact round-trip ---------------- */

test('usage: JSON round-trip is exact, including counts past 2^31', () => {
  const u = new UsageStats('gpt-5');
  u.record({ input: 3_000_000_000, output: 123, cacheRead: 456, cacheWrite: 789 });
  u.record({ input: 10, output: 20, cacheRead: 0, cacheWrite: 0 });
  u.screenshots = 2; u.screenReads = 7;
  const v = UsageStats.fromJSON(JSON.parse(JSON.stringify(u.toJSON())));
  assert.equal(v.input, 3_000_000_010); // the old |0 coercion wrapped this negative
  assert.equal(v.output, 143); assert.equal(v.cacheRead, 456); assert.equal(v.cacheWrite, 789);
  assert.equal(v.requests, 2); assert.equal(v.lastRequestTotal, 30);
  assert.equal(v.screenshots, 2); assert.equal(v.screenReads, 7);
  assert.deepEqual(v.snapshot(), u.snapshot());
  const empty = UsageStats.fromJSON(null);
  assert.equal(empty.input, 0); assert.equal(empty.model, 'claude-sonnet-5-5');
  const bogus = UsageStats.fromJSON({ input: 'x', output: -5, requests: NaN });
  assert.equal(bogus.input, 0); assert.equal(bogus.output, 0); assert.equal(bogus.requests, 0);
});

/* ---------------- MemoryStore: audit trail + atomic file writes ---------------- */

test('memory: one torn audit line does not blank the whole trail', () => {
  const dir = tmp(); const m = new MemoryStore(dir).seed();
  m.write('people/reliability.md', '# Rel\n\nfirst version', 'replace', 'test');
  m.write('people/reliability.md', '# Rel\n\nsecond version', 'replace', 'test');
  assert.ok(m.audit().length >= 2);
  fs.appendFileSync(m.auditFile, '{"ts":"2026-11-01T00:00:00.000Z","rel":"people/reliab'); // crash mid-append
  const entries = m.audit();
  assert.ok(entries.length >= 2); // previously: any bad line made audit() return []
  assert.equal(entries[entries.length - 1].rel, 'people/reliability.md');
});

test('memory: writes and undo are atomic (content correct, no temp litter)', () => {
  const dir = tmp(); const m = new MemoryStore(dir).seed();
  m.write('people/atomic.md', '# A\n\nv1', 'replace', 'test');
  m.write('people/atomic.md', '# A\n\nv2', 'replace', 'test');
  assert.match(m.readFile('people/atomic.md'), /v2/);
  assert.equal(m.undoLastWrite('people/atomic.md'), true);
  assert.match(m.readFile('people/atomic.md'), /v1/);
  const litter = [m.memoryDir, m.versionsDir, path.join(m.memoryDir, 'people')].flatMap(d => noTmpLitter(d));
  assert.deepEqual(litter, []);
});
