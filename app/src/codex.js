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
const { spawn, execFile } = require('child_process');
const TIMEOUT_MS = 600000; // original: 600 s
const MAX_PER_TURN = 3;    // original: 3 per question

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
function cleanEnv(env = process.env) {
  const out = { ...env };
  for (const k of Object.keys(out)) if (/(ANTHROPIC|OPENAI|GEMINI|GOOGLE)_API_KEY/.test(k) || /_TOKEN$/.test(k)) delete out[k];
  return out;
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
  }
  async detect(env = process.env) {
    for (const p of candidatePaths(env)) {
      try { if (!fs.existsSync(p) && !p.includes(path.sep) === false) { /* fallthrough to --version check */ } } catch { /* ignore */ }
    }
    const names = env.DSHIFT_CODEX_PATH ? [env.DSHIFT_CODEX_PATH] : [...candidatePaths(env), 'codex'];
    for (const n of names) {
      try {
        const v = await new Promise((res, rej) => this.execFileImpl(n, ['--version'], { timeout: 5000, env: cleanEnv(env) }, (e, so) => e ? rej(e) : res(String(so).trim())));
        if (v) return { found: true, path: n, version: v };
      } catch { /* try next */ }
    }
    return { found: false, path: null, version: null };
  }
  /** Step 1: model asks → we park it. Nothing runs without approve(). */
  requestApproval(task) {
    if (this.runsThisTurn >= MAX_PER_TURN) throw new Error(`Codex limit reached (${MAX_PER_TURN} per question)`);
    const id = `appr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this.pending.set(id, { task, createdAt: Date.now() });
    this.audit({ event: 'approval_requested', id, task });
    return { approvalId: id, task, expiresInMs: 120000 };
  }
  audit(entry) { try { fs.appendFileSync(path.join(this.dir, 'audit.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); } catch { /* best effort */ } }
  /** Step 2: ONLY a user action may call this. Expired requests die. */
  async approve(approvalId, codexPath, onProgress = () => {}) {
    const req = this.pending.get(approvalId);
    if (!req) throw new Error('unknown or already-used approval');
    this.pending.delete(approvalId);
    if (Date.now() - req.createdAt > 120000) { this.audit({ event: 'approval_expired', id: approvalId }); throw new Error('approval expired — ask again'); }
    this.runsThisTurn++;
    this.audit({ event: 'approved_and_started', id: approvalId, task: req.task });
    const args = buildExecArgs(req.task, this.dir);
    return await new Promise((resolve) => {
      const child = this.spawnImpl(codexPath, args, { env: cleanEnv(), cwd: this.dir });
      let finalText = '', stderr = '', usage = null; const timer = setTimeout(() => { try { child.kill(); } catch {} }, TIMEOUT_MS);
      let buf = '';
      child.stdout?.on('data', d => { buf += d.toString(); const lines = buf.split('\n'); buf = lines.pop(); for (const l of lines) { if (!l.trim()) continue; const ev = parseCodexEvent(l); if (ev.kind === 'final') finalText = ev.text; if (ev.kind === 'usage') usage = ev.usage; if (ev.kind === 'progress') onProgress(ev.text); } });
      child.stderr?.on('data', d => { stderr = (stderr + d.toString()).slice(-8000); });
      child.on('error', e => { clearTimeout(timer); this.audit({ event: 'spawn_error', id: approvalId, error: String(e) }); resolve({ ok: false, text: `Could not start Codex: ${e.message}`, usage }); });
      child.on('close', code => { clearTimeout(timer); try { fs.writeFileSync(path.join(this.dir, 'last-run-stderr.log'), stderr); } catch {} this.audit({ event: 'finished', id: approvalId, code }); resolve({ ok: code === 0, text: finalText || `Codex exited (${code}). See codex/last-run-stderr.log`, usage }); });
      this._child = child;
    });
  }
  deny(approvalId, reason = 'denied by user') { const r = this.pending.get(approvalId); if (r) { this.pending.delete(approvalId); this.audit({ event: 'denied', id: approvalId, reason }); } return !!r; }
  stop() { try { this._child?.kill(); } catch {} }
  newTurn() { this.runsThisTurn = 0; }
}
module.exports = { CodexHandoff, buildExecArgs, cleanEnv, parseCodexEvent, candidatePaths, TIMEOUT_MS, MAX_PER_TURN };
