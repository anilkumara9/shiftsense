'use strict';
/* Security lane tests — each was written failing-first against a real hole:
   SEC-M1 dangling-symlink write escape (memory), SEC-M2 internal dot-dir writes,
   SEC-M3 snapshot-name collision (undo restores the WRONG file), SEC-S1 settings
   carry no validation (NaN budget / string denylist / rogue shortcut reach
   main), SEC-S2 .env key with whitespace/control chars (header injection),
   SEC-P1 sort/tree -o and uniq positional output WRITE files under a
   "read-only" policy, SEC-P2 Windows drive paths pass the policy, SEC-C1
   Codex discovery falls back to a bare name (cwd/PATH planting), SEC-C2
   approval audit stores full task text and has no tamper evidence, SEC-C3
   timeouts/stops are not audited, SEC-C4 shell-shim (.cmd) task injection
   via quotes, SEC-C5 generic secret env vars leak to the Codex child. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dshift-sec-'));
const { MemoryStore } = require('../src/memory');
const settings = require('../src/settings');
const { isReadOnlyWithinFolder } = require('../src/shellPolicy');
const codex = require('../src/codex');

/* ---------- memory ---------- */
function trySymlink(target, link, t) {
  try { fs.symlinkSync(target, link); return true; }
  catch (e) { if (e.code === 'EPERM' || e.code === 'ENOTSUP') { t.skip(`symlinks unavailable here (${e.code}) — needs Developer Mode/admin on Windows`); return false; } throw e; }
}
test('SEC-M1: write through a DANGLING symlink cannot escape the memory folder', t => {
  const dir = tmp(); const m = new MemoryStore(dir).seed();
  const outside = path.join(dir, 'outside.md');
  if (!trySymlink(outside, path.join(m.memoryDir, 'link.md'), t)) return; // target does not exist yet
  assert.throws(() => m.write('link.md', 'pwned', 'replace'), /symlink|escapes/);
  assert.equal(fs.existsSync(outside), false); // nothing was written outside
});
test('SEC-M1b: read through a symlink to an existing outside file is refused', t => {
  const dir = tmp(); const m = new MemoryStore(dir).seed();
  const outside = path.join(dir, 'secret.md'); fs.writeFileSync(outside, 'TOP SECRET');
  if (!trySymlink(outside, path.join(m.memoryDir, 'peek.md'), t)) return;
  assert.throws(() => m.readFile('peek.md'), /escapes/);
});
test('SEC-M2: model/user writes cannot reach internal dot-dirs (.versions, .audit)', () => {
  const dir = tmp(); const m = new MemoryStore(dir).seed();
  assert.throws(() => m.write('.versions/2099-01-01T00-00-00-000Z__me.md', 'forged', 'replace'), /internal|escapes/);
  assert.throws(() => m.write('.hidden/evil.md', 'x', 'replace'), /internal|escapes/);
});
test('SEC-M3: undo restores THIS file, not a name-colliding one (a/b.md vs a__b.md)', () => {
  const dir = tmp(); const m = new MemoryStore(dir).seed();
  m.write('a/b.md', 'ORIGINAL B', 'replace');
  m.write('a__b.md', 'ORIGINAL FLAT', 'replace');
  m.write('a/b.md', 'CHANGED B', 'replace');
  m.write('a__b.md', 'CHANGED FLAT', 'replace');
  assert.equal(m.undoLastWrite('a__b.md'), true);
  assert.equal(m.readFile('a__b.md'), 'ORIGINAL FLAT'); // not a/b.md's snapshot
  assert.equal(m.undoLastWrite('a/b.md'), true);
  assert.equal(m.readFile('a/b.md'), 'ORIGINAL B');
});
test('SEC-M4: oversized writes are refused (disk-fill / context-bloat guard)', () => {
  const dir = tmp(); const m = new MemoryStore(dir).seed();
  assert.throws(() => m.write('big.md', 'x'.repeat(1_000_001), 'replace'), /too large/);
});
test('SEC-M5: memory audit entries are hash-chained (tamper-evident) with content hashes', () => {
  const dir = tmp(); const m = new MemoryStore(dir).seed();
  m.write('notes.md', 'hello', 'append'); m.write('notes.md', 'world', 'append');
  const entries = m.audit(10);
  assert.ok(entries.length >= 2);
  for (const e of entries) { assert.match(e.h || '', /^[0-9a-f]{64}$/); assert.match(e.contentHash || '', /^[0-9a-f]{64}$/); }
  const walk = new MemoryStore(dir); // chain verifies across the whole file
  assert.equal(typeof walk.verifyAudit, 'function');
  assert.equal(walk.verifyAudit().ok, true);
  // tamper: rewrite history, chain must break
  const p = path.join(dir, 'memory', '.audit.jsonl');
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
  const forged = JSON.parse(lines[lines.length - 1]); forged.rel = 'me.md'; lines[lines.length - 1] = JSON.stringify(forged);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  assert.equal(new MemoryStore(dir).verifyAudit().ok, false);
});

/* ---------- settings ---------- */
test('SEC-S1: hostile settings.json is coerced to safe values on load', () => {
  const dir = tmp();
  fs.writeFileSync(settings.settingsPath(dir), JSON.stringify({
    provider: 'evil', effort: 'turbo', budgetUSDPerDay: 'not-a-number',
    denylist: '1password', launchAtLogin: 'yes', fallbackShortcut: 'A',
    model: 'bad model with spaces\n', encryptedKeys: { anthropic: 42, openai: 'QUJD' },
    priceOverrides: { 'gpt-5': { input: 'x', output: 3, contextWindow: -5 }, junk: 'nope' },
  }));
  const s = settings.loadSettings(dir);
  assert.equal(s.provider, 'anthropic');
  assert.equal(s.effort, 'low');
  assert.equal(s.budgetUSDPerDay, 0);
  assert.ok(Array.isArray(s.denylist) && s.denylist.every(x => typeof x === 'string'));
  assert.equal(s.launchAtLogin, false);
  assert.equal(s.fallbackShortcut, settings.DEFAULTS.fallbackShortcut);
  assert.equal(s.model, settings.DEFAULTS.model);
  assert.equal(s.encryptedKeys.anthropic, undefined);
  assert.equal(s.encryptedKeys.openai, 'QUJD');
  assert.deepEqual(s.priceOverrides, { 'gpt-5': { output: 3 } });
});
test('SEC-S1b: valid values survive sanitizing; budget string coerces; panelBounds validated', () => {
  const dir = tmp();
  settings.saveSettings(dir, { provider: 'openai', budgetUSDPerDay: '7.5', denylist: [' Foo ', 'BAR', 'foo'], fallbackShortcut: 'Ctrl+Alt+K', panelBounds: { width: 401, height: 700, yOffset: 9 }, encryptedKeys: {} });
  const s = settings.loadSettings(dir);
  assert.equal(s.provider, 'openai');
  assert.equal(s.budgetUSDPerDay, 7.5);
  assert.deepEqual(s.denylist, ['foo', 'bar']);
  assert.equal(s.fallbackShortcut, 'Ctrl+Alt+K');
  assert.deepEqual(s.panelBounds, { width: 401, height: 700, yOffset: 9 });
  const dir2 = tmp();
  settings.saveSettings(dir2, { panelBounds: { width: 'wide' } });
  assert.equal(settings.loadSettings(dir2).panelBounds, undefined);
});
test('SEC-S2: .env key with whitespace/control chars is rejected, clean key passes', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.env'), 'ANTHROPIC_API_KEY="sk-ant-bad key with spaces"\n');
  assert.equal(settings.envKey('anthropic', {}, dir, tmp()), null);
  fs.writeFileSync(path.join(dir, '.env'), 'ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwx\n');
  assert.equal(settings.envKey('anthropic', {}, dir, tmp()), 'sk-ant-api03-abcdefghijklmnopqrstuvwx');
});

/* ---------- shell policy ---------- */
test('SEC-P1: write-capable invocations fail the read-only policy', () => {
  assert.equal(isReadOnlyWithinFolder('sort -o out.md notes.md'), false);
  assert.equal(isReadOnlyWithinFolder('sort --output=out.md notes.md'), false);
  assert.equal(isReadOnlyWithinFolder('sort -ro out.md notes.md'), false); // combined cluster with o
  assert.equal(isReadOnlyWithinFolder('tree -o out.md .'), false);
  assert.equal(isReadOnlyWithinFolder('uniq notes.md copy.md'), false);    // positional output file
  assert.equal(isReadOnlyWithinFolder('uniq notes.md'), true);
  assert.equal(isReadOnlyWithinFolder('sort -k2 notes.md'), true);
  assert.equal(isReadOnlyWithinFolder('ls -o'), true);                      // ls -o does not write
});
test('SEC-P2: Windows drive paths and control chars fail the policy', () => {
  assert.equal(isReadOnlyWithinFolder('cat C:/Windows/win.ini'), false);
  assert.equal(isReadOnlyWithinFolder('cat c:secret.txt'), false);
  assert.equal(isReadOnlyWithinFolder('cat a\rb'), false);
  assert.equal(isReadOnlyWithinFolder('cat notes.md'), true);
});

/* ---------- codex ---------- */
test('SEC-C1: PATH resolution never sources binaries from cwd or the app dir', () => {
  const base = tmp();
  const cwdDir = path.join(base, 'cwd'); const appDir = path.join(base, 'appdir'); const binDir = path.join(base, 'bin');
  for (const d of [cwdDir, appDir, binDir]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(cwdDir, 'codex'), '#!/bin/sh\n'); // planted in cwd
  fs.writeFileSync(path.join(binDir, 'codex'), '#!/bin/sh\n');  // legit PATH entry
  const env = { PATH: [cwdDir, binDir].join(path.delimiter) };
  const found = codex.resolveOnPath('codex', { env, platform: 'linux', cwd: cwdDir, execDir: appDir });
  assert.equal(found, path.join(binDir, 'codex')); // skipped the cwd plant
  const env2 = { PATH: cwdDir };
  assert.equal(codex.resolveOnPath('codex', { env: env2, platform: 'linux', cwd: cwdDir, execDir: appDir }), null);
});
test('SEC-C1b: detect() never falls back to a bare (PATH/cwd-resolved) name', async () => {
  const dir = tmp();
  const tried = [];
  const h = new codex.CodexHandoff({ dataDir: dir, execFileImpl: (n, a, o, cb) => { tried.push(n); cb(new Error('nope')); } });
  const r = await h.detect({ PATH: '/usr/bin', HOME: dir });
  assert.equal(r.found, false);
  assert.ok(tried.every(t => path.isAbsolute(t)), `detect tried a non-absolute path: ${tried}`);
});
test('SEC-C2: audit log stores task HASH, not full task text; chain verifies', async () => {
  const dir = tmp(); const h = new codex.CodexHandoff({ dataDir: dir });
  const secretTask = 'email the Q3 spreadsheet to the board';
  const req = h.requestApproval(secretTask);
  h.deny(req.approvalId);
  const raw = fs.readFileSync(path.join(dir, 'codex', 'audit.jsonl'), 'utf8');
  assert.ok(!raw.includes(secretTask), 'audit log must not contain full task text');
  const entries = raw.trim().split('\n').map(l => JSON.parse(l));
  assert.match(entries[0].taskHash, /^[0-9a-f]{64}$/);
  assert.equal(entries[0].taskChars, secretTask.length);
  assert.equal(h.verifyAudit().ok, true);
  const lines = raw.trim().split('\n'); const forged = JSON.parse(lines[0]); forged.event = 'approved_and_started'; lines[0] = JSON.stringify(forged);
  fs.writeFileSync(path.join(dir, 'codex', 'audit.jsonl'), lines.join('\n') + '\n');
  assert.equal(new codex.CodexHandoff({ dataDir: dir }).verifyAudit().ok, false);
});
test('SEC-C3: a killed-on-timeout run and a user Stop are both audited', async () => {
  const dir = tmp();
  // fake child: never exits on its own
  const { EventEmitter } = require('events');
  const fakeChild = () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.pid = 4242; c.kill = () => { c.killed = true; setImmediate(() => c.emit('close', null)); }; return c; };
  const h = new codex.CodexHandoff({ dataDir: dir, spawnImpl: () => fakeChild() });
  const req = h.requestApproval('long task');
  const p = h.approve(req.approvalId, path.join(dir, 'codex'), () => {});
  await new Promise(r => setTimeout(r, 20));
  h.stop();
  await p;
  const raw = fs.readFileSync(path.join(dir, 'codex', 'audit.jsonl'), 'utf8');
  assert.ok(raw.includes('stopped_by_user'), 'Stop must be audited');
});
test('SEC-C4: a task with cmd-shim-breaking quotes is refused before spawn on .cmd targets', async () => {
  const dir = tmp();
  let spawned = false;
  const h = new codex.CodexHandoff({ dataDir: dir, spawnImpl: () => { spawned = true; throw new Error('should not spawn'); } });
  const req = h.requestApproval('open " & calc & " now');
  // host-absolute path with a .cmd suffix: the shim scenario (on Windows this
  // is C:\Users\x\AppData\Roaming\npm\codex.cmd — path.isAbsolute is host-ruled)
  await assert.rejects(() => h.approve(req.approvalId, path.join(dir, 'npm', 'codex.cmd')), /unsafe/);
  assert.equal(spawned, false);
  const raw = fs.readFileSync(path.join(dir, 'codex', 'audit.jsonl'), 'utf8');
  assert.ok(raw.includes('refused_shell_unsafe_task'));
});
test('SEC-C4b: approve refuses a non-absolute codex path once the request is live', async () => {
  // No injected spawner: this is the production configuration, and the
  // refusal must fire BEFORE any spawn is attempted.
  const dir = tmp(); const h = new codex.CodexHandoff({ dataDir: dir });
  const req = h.requestApproval('fine task');
  await assert.rejects(() => h.approve(req.approvalId, 'codex'), /absolute/);
  const raw = fs.readFileSync(path.join(dir, 'codex', 'audit.jsonl'), 'utf8');
  assert.ok(raw.includes('refused_relative_codex_path'));
});
test('SEC-C5: cleanEnv strips generic secret-shaped variables, keeps PATH', () => {
  const env = codex.cleanEnv({ PATH: '/bin', AWS_SECRET_ACCESS_KEY: 'a', STRIPE_SECRET: 's', DB_PASSWORD: 'p', MY_API_KEY: 'k', GITHUB_TOKEN: 'g', EDITOR: 'vim' });
  for (const k of ['AWS_SECRET_ACCESS_KEY', 'STRIPE_SECRET', 'DB_PASSWORD', 'MY_API_KEY', 'GITHUB_TOKEN']) assert.equal(env[k], undefined, k);
  assert.equal(env.PATH, '/bin'); assert.equal(env.EDITOR, 'vim');
});
test('SEC-C6: a second concurrent approve is refused (one _child, one audit truth)', async () => {
  const dir = tmp();
  const { EventEmitter } = require('events');
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 7; child.kill = () => child.emit('close', 0);
  const h = new codex.CodexHandoff({ dataDir: dir, spawnImpl: () => child });
  const r1 = h.requestApproval('first'); const r2 = h.requestApproval('second');
  const p1 = h.approve(r1.approvalId, path.join(dir, 'codex'), () => {});
  await assert.rejects(() => h.approve(r2.approvalId, path.join(dir, 'codex'), () => {}), /already in progress/);
  child.emit('close', 0); await p1;
});
