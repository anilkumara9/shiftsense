'use strict';
/**
 * MemoryStore — plain-markdown local memory, ported from Memory.swift and
 * upgraded where the original is weak (recon §7.4):
 *  - every write is appended to memory/.audit.jsonl AND the previous content
 *    is snapshotted to memory/.versions/ so any model write can be UNDONE
 *    (the original has no write log, no diff, no undo — a prompt-injection sink)
 *  - search is an in-process RANKED search (term frequency + title boost),
 *    not literal grep only; grep-style substring search is also available
 *  - me.md size guard: overview warns past 8,000 chars (original sends it
 *    unbounded on every request)
 *  - path confinement resolves symlinks on BOTH read and write paths
 * Layout (default data dir = ~/DShift, override DSHIFT_DATA_DIR):
 *   <data>/memory/{me.md, notes.md, people/, projects/}
 *   <data>/history/YYYY-MM-DD.jsonl     append-only chat log
 *   <data>/memory/.audit.jsonl          write audit trail
 *   <data>/memory/.versions/            pre-write snapshots for undo
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const MAX_WRITE_CHARS = 1_000_000; // SEC-M4: a single write can never bloat disk/context without bound
const AUDIT_GENESIS = 'dshift-memory-audit-v1';
let snapCounter = 0;
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');

function defaultDataDir(env = process.env) {
  if (env.DSHIFT_DATA_DIR) return path.resolve(env.DSHIFT_DATA_DIR.replace(/^~(?=$|\/|\\)/, os.homedir()));
  return path.join(os.homedir(), 'DShift');
}
const ME_GUARD_CHARS = 8000;

/**
 * Crash-safe replacement of a file's content: sibling temp file + fsync +
 * rename, so a power loss mid-write leaves the complete old or new content,
 * never a torn file. Used for memory files and .versions snapshots alike
 * (a torn snapshot would make undo restore garbage).
 */
function atomicWriteText(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

class MemoryStore {
  constructor(dataDir = defaultDataDir()) {
    this.dataDir = dataDir;
    this.memoryDir = path.join(dataDir, 'memory');
    this.historyDir = path.join(dataDir, 'history');
    this.auditFile = path.join(this.memoryDir, '.audit.jsonl');
    this.versionsDir = path.join(this.memoryDir, '.versions');
  }
  seed() {
    for (const d of [this.memoryDir, path.join(this.memoryDir, 'people'), path.join(this.memoryDir, 'projects'), this.historyDir, this.versionsDir]) {
      fs.mkdirSync(d, { recursive: true });
    }
    const me = path.join(this.memoryDir, 'me.md');
    if (!fs.existsSync(me)) fs.writeFileSync(me, '# About me\n\n<!-- D Shift sends this file with every question. Keep it short and factual.\n     Add your name, role, how you like answers written, anything always relevant. -->\n');
    const notes = path.join(this.memoryDir, 'notes.md');
    if (!fs.existsSync(notes)) fs.writeFileSync(notes, '# Notes\n\n<!-- Small durable facts D Shift learns about you land here. Edit or delete anything. -->\n');
    return this;
  }
  /** Resolve a user/model-supplied relative path safely inside memoryDir. Throws on escape.
   *  SEC-M1/M2 hardening: walks EVERY component with lstat, so a symlink is
   *  caught even when it dangles (target not yet created — the old probe used
   *  existsSync, which follows links and reports a dangling link as "missing",
   *  letting writeFileSync create the file OUTSIDE through the link). Internal
   *  dot-components (.versions, .audit.jsonl, …) are refused outright: they are
   *  the store's own machinery, never user/model content. */
  resolveInside(rel) {
    if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new Error('path required');
    if (path.isAbsolute(rel) || rel.startsWith('~')) throw new Error('absolute paths are not allowed');
    const root = fs.existsSync(this.memoryDir) ? fs.realpathSync(this.memoryDir) : path.resolve(this.memoryDir);
    const target = path.resolve(this.memoryDir, rel);
    const relParts = path.relative(this.memoryDir, target).split(path.sep).filter(Boolean);
    if (!relParts.length) throw new Error('path required');
    if (relParts.includes('..')) throw new Error('path escapes the memory folder');
    if (relParts.some(p => p.startsWith('.'))) throw new Error('internal dot paths are not accessible');
    let cur = root;
    for (let i = 0; i < relParts.length; i++) {
      cur = path.join(cur, relParts[i]);
      let st = null;
      try { st = fs.lstatSync(cur); } catch { /* does not exist yet: the rest is lexical and cannot hide a link */ }
      if (!st) { cur = path.join(cur, ...relParts.slice(i + 1)); break; }
      if (st.isSymbolicLink()) {
        let real;
        try { real = fs.realpathSync(cur); } catch { throw new Error('dangling symlink in memory path'); }
        if (real !== root && !real.startsWith(root + path.sep)) throw new Error('path escapes the memory folder');
        cur = real; // continue the walk from the resolved location
      }
    }
    if (cur !== root && !cur.startsWith(root + path.sep)) throw new Error('path escapes the memory folder');
    return cur;
  }
  listFiles(limit = 200) {
    const out = [];
    const walk = (dir, prefix) => {
      let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), rel);
        else if (e.name.toLowerCase().endsWith('.md')) out.push(rel);
        if (out.length >= limit) return;
      }
    };
    walk(this.memoryDir, '');
    return out.sort();
  }
  readFile(rel) { return fs.readFileSync(this.resolveInside(rel), 'utf8'); }
  overview() {
    let me = ''; try { me = this.readFile('me.md'); } catch { /* not seeded */ }
    const files = this.listFiles(200);
    return { me, files, meOverGuard: me.length > ME_GUARD_CHARS, meChars: me.length };
  }
  /** Ranked in-process search: returns [{file, score, snippet}] best first. */
  search(query, { limit = 12, maxSnippet = 300 } = {}) {
    const terms = String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1);
    if (!terms.length) return [];
    const results = [];
    for (const rel of this.listFiles(1000)) {
      let text = ''; try { text = this.readFile(rel); } catch { continue; }
      const lower = text.toLowerCase();
      let score = 0; let firstHit = -1;
      for (const t of terms) {
        let idx = lower.indexOf(t), count = 0;
        while (idx !== -1) { count++; if (firstHit === -1 || idx < firstHit) firstHit = idx; idx = lower.indexOf(t, idx + t.length); if (count > 50) break; }
        score += count;
        if (rel.toLowerCase().includes(t)) score += 5;      // filename/title boost
      }
      if (score > 0) {
        const start = Math.max(0, (firstHit < 0 ? 0 : firstHit) - 60);
        results.push({ file: rel, score, snippet: text.slice(start, start + maxSnippet).replace(/\s+/g, ' ').trim() });
      }
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }
  /** Snapshot key for a file. SEC-M3: the old `a/b.md` -> `a__b.md` flattening
   *  collided with a real file literally named `a__b.md`, so undo could restore
   *  the WRONG file's content. base64url of the normalized rel is injective. */
  snapSuffix(rel) { return `__${Buffer.from(String(rel).replace(/\\/g, '/'), 'utf8').toString('base64url')}`; }
  /** Append one hash-chained audit entry (SEC-M5: tamper-evident trail). */
  _appendAudit(entry) {
    let tip = AUDIT_GENESIS;
    try {
      const lines = fs.readFileSync(this.auditFile, 'utf8').trim().split('\n').filter(Boolean);
      const last = JSON.parse(lines[lines.length - 1]); if (last && last.h) tip = last.h;
    } catch { /* no audit file yet */ }
    const stored = { ...entry, prev: tip };
    stored.h = sha256(JSON.stringify(stored));
    fs.appendFileSync(this.auditFile, JSON.stringify(stored) + '\n');
  }
  /** Verify the audit hash chain. Entries written before chaining existed
   *  (no `h`) are accepted as a legacy prefix only. */
  verifyAudit() {
    let lines = [];
    try { lines = fs.readFileSync(this.auditFile, 'utf8').trim().split('\n').filter(Boolean); } catch { return { ok: true, entries: 0, brokenAt: null }; }
    let prev = AUDIT_GENESIS, chained = false;
    for (let i = 0; i < lines.length; i++) {
      let e; try { e = JSON.parse(lines[i]); } catch { return { ok: false, entries: lines.length, brokenAt: i }; }
      if (!e.h) { if (chained) return { ok: false, entries: lines.length, brokenAt: i }; continue; }
      chained = true;
      const { h, ...rest } = e;
      if (e.prev !== prev || sha256(JSON.stringify(rest)) !== h) return { ok: false, entries: lines.length, brokenAt: i };
      prev = h;
    }
    return { ok: true, entries: lines.length, brokenAt: null };
  }
  /** Write with audit + undo snapshot. mode: 'append' (default) | 'replace'. Only .md files. */
  write(rel, content, mode = 'append', source = 'model') {
    if (!/\.md$/i.test(rel)) throw new Error('only .md files can be written');
    if (String(content).length > MAX_WRITE_CHARS) throw new Error(`memory write too large (max ${MAX_WRITE_CHARS} chars)`);
    const target = this.resolveInside(rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // TOCTOU mitigation: re-resolve after creating directories; a swapped-in
    // symlink between check and write changes the answer and aborts the write.
    if (this.resolveInside(rel) !== target) throw new Error('path changed during write');
    fs.mkdirSync(this.versionsDir, { recursive: true });
    const existed = fs.existsSync(target);
    const prev = existed ? fs.readFileSync(target, 'utf8') : '';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const suffix = this.snapSuffix(rel);
    const snapName = `${stamp}-${++snapCounter}${suffix}`;
    if (existed) {
      atomicWriteText(path.join(this.versionsDir, snapName), prev);
      // cap undo history per file at 20 snapshots (audit minor: unbounded growth)
      const mine = fs.readdirSync(this.versionsDir).filter(f => f.endsWith(suffix)).sort();
      for (const old of mine.slice(0, Math.max(0, mine.length - 20))) { try { fs.unlinkSync(path.join(this.versionsDir, old)); } catch { /* ignore */ } }
    }
    const next = mode === 'replace' ? String(content) : (prev + (prev && !prev.endsWith('\n') ? '\n' : '') + String(content));
    atomicWriteText(target, next);
    this._appendAudit({ ts: new Date().toISOString(), rel, mode, source, bytes: Buffer.byteLength(String(content)), contentHash: sha256(next), snapshot: existed ? snapName : null });
    return { rel, snapshot: existed ? snapName : null, chars: next.length };
  }
  /** Undo the most recent write to a file (restore its latest snapshot). */
  undoLastWrite(rel) {
    const suffix = this.snapSuffix(rel);
    const snaps = fs.readdirSync(this.versionsDir).filter(f => f.endsWith(suffix)).sort();
    if (!snaps.length) return false;
    const latest = snaps[snaps.length - 1];
    const target = this.resolveInside(rel);
    const restored = fs.readFileSync(path.join(this.versionsDir, latest), 'utf8');
    atomicWriteText(target, restored);
    this._appendAudit({ ts: new Date().toISOString(), rel, mode: 'undo', source: 'user', snapshot: latest, contentHash: sha256(restored) });
    return true;
  }
  audit(limit = 50) {
    // Tolerant per-line parse: a crash mid-append can leave ONE torn final
    // line; that must not blank the whole trail (previously any bad line
    // made audit() return [] via the outer catch).
    let raw; try { raw = fs.readFileSync(this.auditFile, 'utf8'); } catch { return []; }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* torn line: skip it, keep the rest */ }
    }
    return out.slice(-limit);
  }
  logHistory(entry) {
    const day = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(path.join(this.historyDir, `${day}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  }
}
module.exports = { MemoryStore, defaultDataDir, ME_GUARD_CHARS };
