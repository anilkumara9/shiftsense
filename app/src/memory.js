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

function defaultDataDir(env = process.env) {
  if (env.DSHIFT_DATA_DIR) return path.resolve(env.DSHIFT_DATA_DIR.replace(/^~(?=$|\/|\\)/, os.homedir()));
  return path.join(os.homedir(), 'DShift');
}
const ME_GUARD_CHARS = 8000;

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
  /** Resolve a user/model-supplied relative path safely inside memoryDir. Throws on escape. */
  resolveInside(rel) {
    if (typeof rel !== 'string' || !rel) throw new Error('path required');
    if (path.isAbsolute(rel) || rel.startsWith('~')) throw new Error('absolute paths are not allowed');
    const target = path.resolve(this.memoryDir, rel);
    const root = fs.existsSync(this.memoryDir) ? fs.realpathSync(this.memoryDir) : path.resolve(this.memoryDir);
    // resolve the parent chain to catch symlink escapes on the final component too
    let probe = target;
    while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
    const realProbe = fs.existsSync(probe) ? fs.realpathSync(probe) : probe;
    const rebuilt = path.join(realProbe, path.relative(probe, target));
    if (rebuilt !== root && !rebuilt.startsWith(root + path.sep)) throw new Error('path escapes the memory folder');
    return rebuilt;
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
  /** Write with audit + undo snapshot. mode: 'append' (default) | 'replace'. Only .md files. */
  write(rel, content, mode = 'append', source = 'model') {
    if (!/\.md$/i.test(rel)) throw new Error('only .md files can be written');
    const target = this.resolveInside(rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const existed = fs.existsSync(target);
    const prev = existed ? fs.readFileSync(target, 'utf8') : '';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const snapName = `${stamp}__${rel.replace(/[\\/]/g, '__')}`;
    if (existed) fs.writeFileSync(path.join(this.versionsDir, snapName), prev);
    const next = mode === 'replace' ? String(content) : (prev + (prev && !prev.endsWith('\n') ? '\n' : '') + String(content));
    fs.writeFileSync(target, next);
    fs.appendFileSync(this.auditFile, JSON.stringify({ ts: new Date().toISOString(), rel, mode, source, bytes: Buffer.byteLength(String(content)), snapshot: existed ? snapName : null }) + '\n');
    return { rel, snapshot: existed ? snapName : null, chars: next.length };
  }
  /** Undo the most recent write to a file (restore its latest snapshot). */
  undoLastWrite(rel) {
    const snaps = fs.readdirSync(this.versionsDir).filter(f => f.endsWith(`__${rel.replace(/[\\/]/g, '__')}`)).sort();
    if (!snaps.length) return false;
    const latest = snaps[snaps.length - 1];
    fs.copyFileSync(path.join(this.versionsDir, latest), this.resolveInside(rel));
    fs.appendFileSync(this.auditFile, JSON.stringify({ ts: new Date().toISOString(), rel, mode: 'undo', source: 'user', snapshot: latest }) + '\n');
    return true;
  }
  audit(limit = 50) {
    try { return fs.readFileSync(this.auditFile, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).map(l => JSON.parse(l)); } catch { return []; }
  }
  logHistory(entry) {
    const day = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(path.join(this.historyDir, `${day}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  }
}
module.exports = { MemoryStore, defaultDataDir, ME_GUARD_CHARS };
