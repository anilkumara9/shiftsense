'use strict';
/**
 * CodexHandoff — approval-gated computer-use / task handoff to the Codex CLI.
 * Ported invocation (recon §3.5): codex exec --json --ephemeral
 * --skip-git-repo-check --sandbox read-only "<task>".
 * Current-docs reality (DOCS_RESEARCH §3.4): Computer Use itself lives in the
 * ChatGPT desktop app, not the CLI — so this handoff runs the real CLI agent
 * and is honest in the UI about that boundary.
 * Beats the original (recon §7.5/§7.7):
 *  - approval is PER TASK and expires — there is NO persisted "auto mode"
 *    boolean that silently disables approvals forever
 *  - every approval / run is written to an audit log (codex/audit.jsonl)
 *  - subprocess env strips ALL provider keys (the original stripped only
 *    ANTHROPIC_API_KEY and leaked OPENAI_API_KEY to the Codex child)
 *  - discovery VALIDATES the binary (exists + runs --version)
 *  - --yolo / danger-full-access are refused at the API level, always
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const TIMEOUT_MS = 600000; // original: 600 s
const MAX_PER_TURN = 3;    // original: 3 per question
const MAX_TASK_CHARS = 8000;
const AUDIT_GENESIS = 'dshift-codex-audit-v1';
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
/** The audit stores a task HASH, never the full task text (SEC-C2): the task
 *  can carry private screen content, and the log outlives the session. */
const taskMeta = task => ({ taskHash: sha256(String(task)), taskChars: String(task).length });

function candidatePaths(env = process.env, platform = process.platform, home = require('os').homedir()) {
  const list = [];
  if (env.DSHIFT_CODEX_PATH) list.push(env.DSHIFT_CODEX_PATH);
  if (platform === 'win32') {
    list.push(path.join(home, 'AppData', 'Roaming', 'npm', 'codex.cmd'));
    list.push('C:\\Program Files\\OpenAI\\Codex\\codex.exe');
  } else {
    list.push(path.join(home, '.local', 'bin', 'codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex');
  }
  return list;
}
function buildExecArgs(task, cwd) {
  if (typeof task !== 'string' || !task.trim()) throw new Error('task required');
  if (/--yolo|danger-full-access|dangerously-bypass/.test(task)) throw new Error('refused: unsafe flag in task text');
  return ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', cwd, task];
}
const SECRET_ENV = /(_API_KEY|_APIKEY|_TOKEN|_SECRET|_PASSWORD|_PASSWD|_PRIVATE_KEY|_ACCESS_KEY|_CREDENTIALS?|_AUTH)$/i;
function cleanEnv(env = process.env) {
  // SEC-C5: strip EVERY secret-shaped variable, not only the named providers —
  // AWS_SECRET_ACCESS_KEY, STRIPE_SECRET, DB_PASSWORD, MY_API_KEY all used to
  // flow into the Codex child verbatim.
  const out = { ...env };
  for (const k of Object.keys(out)) if (SECRET_ENV.test(k) || /^(ANTHROPIC|OPENAI|GEMINI|GOOGLE)_API_KEY$/.test(k)) delete out[k];
  return out;
}
/**
 * SEC-C1: resolve a bare tool name against PATH entries WITHOUT ever sourcing
 * it from the process cwd or the app/executable directory. On Windows,
 * CreateProcess-style lookup searches the cwd — a `codex.exe` planted in
 * whatever folder the app was launched from (or an empty PATH entry, which
 * also means cwd) would silently win. Here: relative PATH entries (cwd by
 * definition) are skipped, absolute entries equal to cwd/execDir are skipped,
 * and the result is always an absolute path the caller can validate.
 */
function resolveOnPath(name, { env = process.env, platform = process.platform, cwd = process.cwd(), execDir = path.dirname(process.execPath) } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const rawPath = env.PATH || env.Path || '';
  const exts = platform === 'win32' ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map(e => e.trim()).filter(Boolean) : [''];
  const norm = d => { let r = P.resolve(String(d)); if (platform === 'win32') r = r.toLowerCase(); return r; };
  const skip = new Set([norm(cwd), norm(execDir)]);
  const fileNames = [...new Set(exts.map(e => (e && !String(name).toLowerCase().endsWith(e.toLowerCase())) ? name + e : name))];
  for (const entry of String(rawPath).split(P.delimiter)) {
    if (!entry || !P.isAbsolute(entry)) continue; // empty or relative entry == cwd semantics
    const dir = P.resolve(entry);
    if (skip.has(norm(dir))) continue;
    for (const f of fileNames) {
      const full = P.join(dir, f);
      try { if (fs.existsSync(full)) return full; } catch { /* next */ }
    }
  }
  return null;
}
/** Windows npm installs of Codex are .cmd shims; Node refuses to spawn them
 *  without a shell (EINVAL) — audit M10. Route those through the shell. */
function spawnOptionsFor(codexPath, platform = process.platform) {
  const needsShell = platform === 'win32' && /\.(cmd|bat)$/i.test(String(codexPath || ''));
  return needsShell ? { shell: true } : {};
}
function parseCodexEvent(line) {
  try {
    const ev = JSON.parse(line);
    if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') return { kind: 'final', text: ev.item.text || '' };
    if (ev.type === 'turn.completed') return { kind: 'usage', usage: ev.usage || null };
    if (ev.type === 'item.started' || ev.type === 'item.updated') return { kind: 'progress', text: String(ev.item?.type || ev.type) };
    return { kind: 'event', type: ev.type };
  } catch { return { kind: 'raw', text: String(line).slice(0, 300) }; }
}
class CodexHandoff {
  constructor({ dataDir, execFileImpl = execFile, spawnImpl = spawn } = {}) {
    this.dir = path.join(dataDir, 'codex'); this.execFileImpl = execFileImpl; this.spawnImpl = spawnImpl;
    fs.mkdirSync(this.dir, { recursive: true });
    this.pending = new Map(); // approvalId -> {task, createdAt}
    this.runsThisTurn = 0;
    this._runningId = null;
    // Test harnesses inject spawnImpl (the child is then a fake and no OS
    // resolver is ever involved). Production construction uses the real
    // spawn — only then does approve() enforce the absolute-path rule below.
    this._spawnInjected = spawnImpl !== spawn;
  }
  async detect(env = process.env) {
    // SEC-C1: candidates are absolute install locations + one cwd/execDir-free
    // PATH resolution. There is deliberately NO bare-name fallback: executing
    // 'codex' unqualified delegates resolution to OS rules that include the
    // current directory. Every candidate is still validated by --version.
    const names = env.DSHIFT_CODEX_PATH ? [env.DSHIFT_CODEX_PATH] : [...new Set([...candidatePaths(env), resolveOnPath('codex', { env })].filter(Boolean))];
    for (const n of names) {
      try {
        const v = await new Promise((res, rej) => this.execFileImpl(n, ['--version'], { timeout: 5000, env: cleanEnv(env), ...spawnOptionsFor(n) }, (e, so) => e ? rej(e) : res(String(so).trim())));
        if (v) return { found: true, path: n, version: v };
      } catch { /* try next */ }
    }
    return { found: false, path: null, version: null };
  }
  /** Step 1: model asks → we park it. Nothing runs without approve(). */
  requestApproval(task) {
    if (typeof task !== 'string' || !task.trim()) throw new Error('task required');
    if (task.length > MAX_TASK_CHARS) throw new Error(`task too long (max ${MAX_TASK_CHARS} chars)`);
    if (this.runsThisTurn >= MAX_PER_TURN) throw new Error(`Codex limit reached (${MAX_PER_TURN} per question)`);
    const id = `appr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this.pending.set(id, { task, createdAt: Date.now() });
    this.audit({ event: 'approval_requested', id, ...taskMeta(task) });
    return { approvalId: id, task, expiresInMs: 120000 };
  }
  auditFile() { return path.join(this.dir, 'audit.jsonl'); }
  /** Hash-chained, append-only audit (SEC-C2): each entry links to the
   *  previous entry's hash, so quiet edits to the history break the chain. */
  audit(entry) {
    try {
      let tip = AUDIT_GENESIS;
      try {
        const lines = fs.readFileSync(this.auditFile(), 'utf8').trim().split('\n').filter(Boolean);
        const last = JSON.parse(lines[lines.length - 1]); if (last && last.h) tip = last.h;
      } catch { /* no audit file yet */ }
      const stored = { ts: new Date().toISOString(), ...entry, prev: tip };
      stored.h = sha256(JSON.stringify(stored));
      fs.appendFileSync(this.auditFile(), JSON.stringify(stored) + '\n');
    } catch { /* best effort */ }
  }
  verifyAudit() {
    let lines = [];
    try { lines = fs.readFileSync(this.auditFile(), 'utf8').trim().split('\n').filter(Boolean); } catch { return { ok: true, entries: 0, brokenAt: null }; }
    let prev = AUDIT_GENESIS, chained = false;
    for (let i = 0; i < lines.length; i++) {
      let e; try { e = JSON.parse(lines[i]); } catch { return { ok: false, entries: lines.length, brokenAt: i }; }
      if (!e.h) { if (chained) return { ok: false, entries: lines.length, brokenAt: i }; continue; } // legacy prefix only
      chained = true;
      const { h, ...rest } = e;
      if (e.prev !== prev || sha256(JSON.stringify(rest)) !== h) return { ok: false, entries: lines.length, brokenAt: i };
      prev = h;
    }
    return { ok: true, entries: lines.length, brokenAt: null };
  }
  /** Step 2: ONLY a user action may call this. Expired requests die. */
  async approve(approvalId, codexPath, onProgress = () => {}) {
    const req = this.pending.get(approvalId);
    if (!req) throw new Error('unknown or already-used approval');
    this.pending.delete(approvalId);
    const meta = taskMeta(req.task);
    if (Date.now() - req.createdAt > 120000) { this.audit({ event: 'approval_expired', id: approvalId, ...meta }); throw new Error('approval expired — ask again'); }
    // SEC-C4b: with the real spawner, the binary must be an absolute,
    // previously validated path — a bare name would re-delegate resolution
    // to cwd-inclusive OS rules at exactly the moment of execution. (Skipped
    // only for injected fake spawners, which never reach an OS resolver.)
    if (!this._spawnInjected && !path.isAbsolute(String(codexPath || ''))) { this.audit({ event: 'refused_relative_codex_path', id: approvalId, ...meta }); throw new Error('refused: codex path must be absolute and validated by detect()'); }
    // SEC-C6: one run at a time — a second approve used to overwrite _child,
    // leaving the first run unkillable and its outcome unaudited.
    if (this._runningId) { this.audit({ event: 'refused_concurrent_run', id: approvalId, runningId: this._runningId, ...meta }); throw new Error('a Codex run is already in progress'); }
    let args;
    try { args = buildExecArgs(req.task, this.dir); } catch (e) { this.audit({ event: 'refused_unsafe_task', id: approvalId, error: String(e.message || e), ...meta }); throw e; }
    // SEC-C4: npm-installed Codex on Windows is a .cmd shim spawned through
    // cmd.exe. A task containing a double quote or newline can break out of
    // Node's argument quoting, so the command the user approved would not be
    // the command that runs. Refuse those tasks for shim targets.
    if (/\.(cmd|bat)$/i.test(String(codexPath)) && /["\r\n]/.test(req.task)) { this.audit({ event: 'refused_shell_unsafe_task', id: approvalId, ...meta }); throw new Error('refused: task contains characters unsafe for the Windows shell shim (quotes or newlines)'); }
    this.runsThisTurn++;
    this.audit({ event: 'approved_and_started', id: approvalId, ...meta });
    return await new Promise((resolve) => {
      const child = this.spawnImpl(codexPath, args, { env: cleanEnv(), cwd: this.dir, ...spawnOptionsFor(codexPath) });
      this._child = child; this._runningId = approvalId;
      let finalText = '', stderr = '', usage = null;
      const done = () => { if (this._runningId === approvalId) this._runningId = null; if (this._child === child) this._child = null; };
      const timer = setTimeout(() => { this.audit({ event: 'timeout_kill', id: approvalId, timeoutMs: TIMEOUT_MS, ...meta }); try { child.kill(); } catch {} }, TIMEOUT_MS);
      let buf = '';
      child.stdout?.on('data', d => { buf += d.toString(); const lines = buf.split('\n'); buf = lines.pop(); for (const l of lines) { if (!l.trim()) continue; const ev = parseCodexEvent(l); if (ev.kind === 'final') finalText = ev.text; if (ev.kind === 'usage') usage = ev.usage; if (ev.kind === 'progress') onProgress(ev.text); } });
      child.stderr?.on('data', d => { stderr = (stderr + d.toString()).slice(-8000); });
      child.on('error', e => { clearTimeout(timer); done(); this.audit({ event: 'spawn_error', id: approvalId, error: String(e) }); resolve({ ok: false, text: `Could not start Codex: ${e.message}`, usage }); });
      child.on('close', code => { clearTimeout(timer); done(); try { fs.writeFileSync(path.join(this.dir, 'last-run-stderr.log'), stderr); } catch {} this.audit({ event: 'finished', id: approvalId, code, ...meta }); resolve({ ok: code === 0, text: finalText || `Codex exited (${code}). See codex/last-run-stderr.log`, usage }); });
    });
  }
  deny(approvalId, reason = 'denied by user') { const r = this.pending.get(approvalId); if (r) { this.pending.delete(approvalId); this.audit({ event: 'denied', id: approvalId, reason, ...taskMeta(r.task) }); } return !!r; }
  stop() {
    const child = this._child; if (!child) return;
    // SEC-C3: a user Stop is a security-relevant decision — audit it.
    if (this._runningId) this.audit({ event: 'stopped_by_user', id: this._runningId });
    try {
      if (process.platform === 'win32' && child.pid) { // kill the whole tree, not just the shim (audit minor)
        require('child_process').execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => { try { child.kill(); } catch {} });
      } else child.kill();
    } catch { /* already gone */ }
  }
  newTurn() { this.runsThisTurn = 0; }
}
module.exports = { CodexHandoff, buildExecArgs, cleanEnv, parseCodexEvent, candidatePaths, spawnOptionsFor, resolveOnPath, TIMEOUT_MS, MAX_PER_TURN };
