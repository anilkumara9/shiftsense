'use strict';
/* UiaClient tests. PowerShell does not exist on this dev box, so every test
 * injects a small Node script standing in for native/uia-host.ps1 (the real
 * child_process spawn machinery is exercised end to end — only the host
 * binary is fake). The fake hosts speak the same JSON-lines protocol. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { UiaClient } = require('../src/uiaClient');

/* --- Fake hosts (run via `node -e <script>`; avoid backticks/${} inside) --- */

// Well-behaved host: echoes the request id into result.pid so tests can
// prove responses are correlated to requests, not just "some reply came".
const ECHO_HOST = `
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    const res = { id: req.id, result: { app: 'fake', title: 'Fake Window', pid: req.id, root: { type: 'Window', name: 'Fake', children: [] } } };
    process.stdout.write(JSON.stringify(res) + '\\n');
  }
});
`;

// Echo host that also emits framing noise: a non-JSON line and a response
// with an unknown id before the real reply. The client must ignore both.
const NOISY_HOST = `
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    process.stdout.write('this is not json\\n');
    process.stdout.write(JSON.stringify({ id: 99999, result: { app: 'stray' } }) + '\\n');
    process.stdout.write(JSON.stringify({ id: req.id, result: { app: 'fake', title: 'T', pid: req.id, root: { type: 'Window', children: [] } } }) + '\\n');
  }
});
`;

// Host that logs start/end of each request to $FAKE_LOG and delays replies,
// so serialization (one in flight) is directly observable from the log order.
const ORDER_HOST = `
const fs = require('fs');
const log = process.env.FAKE_LOG;
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    fs.appendFileSync(log, 'start ' + req.id + '\\n');
    setTimeout(() => {
      fs.appendFileSync(log, 'end ' + req.id + '\\n');
      process.stdout.write(JSON.stringify({ id: req.id, result: { app: 'fake', title: 'T', pid: req.id, root: { type: 'Window', children: [] } } }) + '\\n');
    }, 60);
  }
});
`;

// Host that never answers (wedged inside a UIA call).
const SILENT_HOST = `process.stdin.resume(); process.stdin.on('data', () => {});`;

// Host that dies on any input, every time.
const ALWAYS_DIE_HOST = `process.stdin.resume(); process.stdin.on('data', () => process.exit(3));`;

// Host whose FIRST instance dies on input; later instances behave (state
// kept in $FAKE_STATE across spawns).
const DIE_ONCE_HOST = `
const fs = require('fs');
const f = process.env.FAKE_STATE;
let n = 0;
try { n = parseInt(fs.readFileSync(f, 'utf8'), 10) || 0; } catch (e) {}
n++; fs.writeFileSync(f, String(n));
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  if (n === 1) { process.exit(3); }
  buf += d; let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    process.stdout.write(JSON.stringify({ id: req.id, result: { app: 'fake', title: 'Recovered', pid: req.id, root: { type: 'Window', children: [] } } }) + '\\n');
  }
});
`;

function makeClient(t, hostScript, opts = {}) {
  const counter = { spawns: 0 };
  const spawnImpl = (cmd, args, sopts) => {
    counter.spawns++;
    return spawn(cmd, args, { ...sopts, env: { ...process.env, ...(opts.env || {}) } });
  };
  const client = new UiaClient({
    platform: 'win32',
    command: process.execPath,
    args: ['-e', hostScript],
    spawnImpl,
    timeoutMs: opts.timeoutMs || 1000,
    ...(opts.maxStartFailures ? { maxStartFailures: opts.maxStartFailures } : {}),
  });
  t.after(() => client.close());
  return { client, counter };
}

test('protocol: dump() returns the host result, correlated by request id', async t => {
  const { client, counter } = makeClient(t, ECHO_HOST);
  assert.equal(client.healthy, true);
  const r1 = await client.dump();
  assert.equal(r1.app, 'fake');
  assert.equal(r1.pid, 1); // first request id echoed back: correlation works
  assert.equal(r1.root.type, 'Window');
  const r2 = await client.dump();
  assert.equal(r2.pid, 2);
  assert.equal(counter.spawns, 1, 'host is spawned once and reused');
  assert.equal(client.healthy, true);
});

test('protocol: garbled lines and unknown ids do not break framing', async t => {
  const { client } = makeClient(t, NOISY_HOST);
  const r = await client.dump();
  assert.equal(r.app, 'fake');
  assert.equal(r.pid, 1);
});

test('serialization: concurrent dump() calls run one at a time, in order', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uia-order-'));
  const log = path.join(dir, 'order.log');
  const { client } = makeClient(t, ORDER_HOST, { env: { FAKE_LOG: log } });
  const [a, b] = await Promise.all([client.dump(), client.dump()]);
  assert.equal(a.pid, 1);
  assert.equal(b.pid, 2);
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.deepEqual(lines, ['start 1', 'end 1', 'start 2', 'end 2'],
    'second request is not written until the first response arrived');
});

test('timeout: a wedged host is killed, retried once, then resolves null and latches unhealthy', async t => {
  const { client, counter } = makeClient(t, SILENT_HOST, { timeoutMs: 120 });
  const started = Date.now();
  const r = await client.dump();
  const elapsed = Date.now() - started;
  assert.equal(r, null);
  assert.equal(counter.spawns, 2, 'one initial attempt + exactly one restart');
  assert.ok(elapsed >= 200, `two 120ms timeouts must elapse (got ${elapsed}ms)`);
  assert.ok(elapsed < 5000, `must fail fast, not hang (got ${elapsed}ms)`);
  // Both wedged instances answered zero requests: the fallback latch trips.
  assert.equal(client.healthy, false);
  const r2 = await client.dump();
  assert.equal(r2, null);
  assert.equal(counter.spawns, 2, 'latched client never spawns again');
});

test('restart-on-death: host dying mid-request is restarted once and the retry succeeds', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uia-die-'));
  const state = path.join(dir, 'state.txt');
  const { client, counter } = makeClient(t, DIE_ONCE_HOST, { env: { FAKE_STATE: state } });
  const r = await client.dump();
  assert.equal(r.app, 'fake');
  assert.equal(r.title, 'Recovered');
  assert.equal(counter.spawns, 2);
  assert.equal(client.healthy, true, 'a host that answers resets the failure count');
  const r2 = await client.dump();
  assert.equal(r2.title, 'Recovered');
  assert.equal(counter.spawns, 2, 'recovered host keeps serving; no further respawns');
});

test('death on every attempt: resolves null, at most one restart, then permanent fallback', async t => {
  const { client, counter } = makeClient(t, ALWAYS_DIE_HOST, { timeoutMs: 5000 });
  const r = await client.dump();
  assert.equal(r, null);
  assert.equal(counter.spawns, 2, 'initial + one restart, never more');
  assert.equal(client.healthy, false);
  const r2 = await client.dump();
  assert.equal(r2, null);
  assert.equal(counter.spawns, 2, 'no more spawns once latched');
});

test('spawn failure (nonexistent binary): resolves null and latches after two failed starts', async t => {
  const counter = { spawns: 0 };
  const client = new UiaClient({
    platform: 'win32',
    command: 'dshift-no-such-powershell-binary',
    args: [],
    timeoutMs: 2000,
    spawnImpl: (cmd, args, sopts) => { counter.spawns++; return spawn(cmd, args, sopts); },
  });
  t.after(() => client.close());
  const r = await client.dump();
  assert.equal(r, null);
  assert.equal(counter.spawns, 2);
  assert.equal(client.healthy, false);
});

test('non-Windows: dump() resolves null and never spawns', async t => {
  let spawned = false;
  const client = new UiaClient({
    platform: 'linux',
    spawnImpl: () => { spawned = true; throw new Error('must not spawn'); },
  });
  t.after(() => client.close());
  assert.equal(client.healthy, false);
  assert.equal(await client.dump(), null);
  assert.equal(spawned, false);
});

test('close(): resolves later dumps as null, is idempotent, kills the host', async t => {
  const { client, counter } = makeClient(t, ECHO_HOST);
  const r = await client.dump();
  assert.equal(r.app, 'fake');
  client.close();
  client.close(); // must not throw
  assert.equal(client.healthy, false);
  assert.equal(await client.dump(), null);
  assert.equal(counter.spawns, 1, 'no respawn after close');
});

test('defaults: production wiring targets the persistent host script', () => {
  const client = new UiaClient({ platform: 'win32' });
  assert.equal(client.command, 'powershell.exe');
  assert.match(client.hostPath, /uia-host\.ps1$/);
  assert.equal(client.timeoutMs, 2500);
  assert.equal(client.healthy, true);
});
