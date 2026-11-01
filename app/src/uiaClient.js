'use strict';
/**
 * UiaClient — persistent UIA host client (performance lane).
 *
 * The one-shot path (main.js runUIA) pays a cold powershell.exe spawn +
 * Add-Type + JIT on EVERY screen read (~300-800 ms), and the context
 * tracker polls every 4 s. This client keeps ONE long-lived host
 * (native/uia-host.ps1) alive and speaks JSON-lines to it, so a warm read
 * costs only the UIA walk itself (typically tens of ms; +500 ms only when
 * the lazy-tree retry fires on a thin Chromium tree).
 *
 * Design contract:
 *  - Lazy: the host spawns on the first dump(), never at construction.
 *  - dump() resolves the same raw object the one-shot produces
 *    ({ app, title, pid, root }) or null — it NEVER rejects.
 *  - Serialized: requests run one at a time through a promise chain (the
 *    host is single-threaded; pipelining would buy nothing and would
 *    break the tracker's ordering assumptions).
 *  - Correlation: monotonically increasing ids; stray/garbled lines and
 *    responses with unknown ids are ignored.
 *  - Per-request timeout (default 2500 ms — generous headroom over the
 *    worst warm walk: 3000-node cap + 500 ms lazy retry). A timeout means
 *    the host is wedged inside a UIA call, so the host is killed.
 *  - Restart: if the host dies mid-request (exit, spawn error, timeout
 *    kill), that request retries ONCE on a fresh host. A second failure
 *    resolves null.
 *  - Permanent fallback latch: a host instance that ends having answered
 *    ZERO requests counts as a failed start (spawn ENOENT, script crash,
 *    wedge-on-first-request). After maxStartFailures (default 2)
 *    consecutive failed starts the client latches `healthy === false`
 *    and dump() resolves null without spawning, so the caller can fall
 *    back to the one-shot path permanently for this session. Any single
 *    successful response resets the consecutive-failure counter, so a
 *    host that worked for hours and then dies once is simply restarted.
 *  - Non-Windows: dump() resolves null and nothing is ever spawned.
 *  - close(): idempotent; pending requests resolve null, the host is
 *    terminated, and later dump() calls resolve null.
 *
 * Testability: spawnImpl / command / args / platform / timeoutMs /
 * maxStartFailures are all injectable; tests stand in a Node script for
 * PowerShell (this dev box has no PowerShell).
 */
const { spawn } = require('child_process');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_MAX_START_FAILURES = 2;

class UiaClient {
  constructor(opts = {}) {
    this.platform = opts.platform || process.platform;
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.maxStartFailures = opts.maxStartFailures || DEFAULT_MAX_START_FAILURES;
    this.spawnImpl = opts.spawnImpl || spawn;
    this.command = opts.command || 'powershell.exe';
    this.hostPath = opts.hostPath || path.join(__dirname, '..', 'native', 'uia-host.ps1');
    this.args = opts.args || null; // tests override the whole argv
    this._child = null;
    this._buf = '';
    this._pending = new Map(); // id -> { finish, child }
    this._nextId = 1;
    this._chain = Promise.resolve(); // serialization queue
    this._startFailures = 0; // consecutive host instances that answered 0 requests
    this._dead = false; // permanent-fallback latch
    this._closed = false;
  }

  /** True while the persistent-host path is usable. False on non-Windows,
   *  after close(), and once the start-failure latch has tripped. */
  get healthy() {
    return this.platform === 'win32' && !this._dead && !this._closed;
  }

  /** One screen read. Resolves the raw dump object or null; never rejects. */
  dump() {
    if (this.platform !== 'win32' || this._closed || this._dead) return Promise.resolve(null);
    const run = () => this._dumpWithRestart();
    const p = this._chain.then(run, run);
    // Keep the chain alive regardless of individual outcomes.
    this._chain = p.then(() => {}, () => {});
    return p;
  }

  async _dumpWithRestart() {
    // At most two attempts: the initial try plus ONE retry on a fresh host
    // if the first host died mid-request.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this._closed || this._dead) return null;
      const r = await this._attempt();
      if (r.ok) return r.value;
    }
    return null;
  }

  _attempt() {
    return new Promise(resolve => {
      if (!this._ensureHost()) { resolve({ ok: false }); return; }
      const child = this._child;
      const id = this._nextId++;
      let settled = false;
      const finish = v => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._pending.delete(id);
        resolve(v);
      };
      const timer = setTimeout(() => {
        // Wedged host (stuck inside a UIA call): end this instance. Its
        // pending entries — including this one — resolve as failed inside
        // _onHostEnd, then we make sure the process is really gone.
        this._onHostEnd(child);
        try { child.kill(); } catch { /* already gone */ }
      }, this.timeoutMs);
      if (timer.unref) timer.unref();
      this._pending.set(id, { finish, child });
      try {
        child.stdin.write(JSON.stringify({ id }) + '\n');
      } catch {
        finish({ ok: false });
      }
    });
  }

  _ensureHost() {
    if (this._child) return true;
    if (this._dead || this._closed || this.platform !== 'win32') return false;
    let child;
    try {
      const args = this.args || ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.hostPath];
      child = this.spawnImpl(this.command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      this._bumpStartFailure();
      return false;
    }
    if (!child || !child.stdin || !child.stdout || typeof child.on !== 'function') {
      this._bumpStartFailure();
      return false;
    }
    child._uiaOk = 0; // requests this instance has answered
    child._uiaCounted = false; // start-failure accounting done for this instance
    this._child = child;
    this._buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => this._onData(child, d));
    // Drain stderr: host diagnostics must never fill a pipe and block it.
    if (child.stderr) child.stderr.on('data', () => {});
    if (child.stdin) child.stdin.on('error', () => { /* EPIPE surfaces via exit/close */ });
    const onEnd = () => this._onHostEnd(child);
    child.on('error', onEnd); // spawn failure (ENOENT) arrives here
    child.on('exit', onEnd);
    child.on('close', onEnd);
    // The host is a helper: it must never keep the app (or a test) alive.
    try { child.unref(); child.stdin.unref(); child.stdout.unref(); if (child.stderr) child.stderr.unref(); } catch { /* best effort */ }
    return true;
  }

  _onData(child, chunk) {
    if (child !== this._child) return; // stale instance; ignore its last gasps
    this._buf += chunk;
    let nl;
    while ((nl = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; } // garbled line: framing holds, skip it
      const entry = this._pending.get(msg.id);
      if (!entry || entry.child !== child) continue; // unknown id / stale: ignore
      child._uiaOk++;
      this._startFailures = 0; // a working host resets the consecutive-failure count
      entry.finish({ ok: true, value: msg.result !== undefined ? msg.result : null });
    }
  }

  /** Single funnel for "this host instance is over" (exit, spawn error,
   *  close, or timeout kill). Fails its in-flight requests and applies the
   *  start-failure accounting exactly once per instance. */
  _onHostEnd(child) {
    if (!child || child._uiaCounted) {
      if (this._child === child) this._child = null;
      return;
    }
    child._uiaCounted = true;
    if (this._child === child) this._child = null;
    if ((child._uiaOk || 0) === 0) this._bumpStartFailure();
    for (const [, entry] of [...this._pending]) {
      if (entry.child === child) entry.finish({ ok: false });
    }
  }

  _bumpStartFailure() {
    this._startFailures++;
    if (this._startFailures >= this.maxStartFailures) this._dead = true;
  }

  /** Terminate the host and resolve everything outstanding as null. */
  close() {
    if (this._closed) return;
    this._closed = true;
    const child = this._child;
    this._child = null;
    for (const [, entry] of [...this._pending]) entry.finish({ ok: false });
    this._pending.clear();
    if (child) {
      try { child.stdin.end(); } catch { /* ignore */ }
      try { child.kill(); } catch { /* already gone */ }
    }
  }
}

module.exports = { UiaClient, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_START_FAILURES };
