'use strict';
/**
 * ChatStore — multi-tab chats that PERSIST across restarts.
 * The original's tabs die on quit (its own roadmap lists "Persist chat tabs
 * across restarts" as unbuilt). Tabs, messages, per-tab usage and the queue
 * are saved to <data>/chats.json (atomic write) and restored on launch.
 *
 * HARD RULE (learned from the v1 audit): the API transcript (`messages`,
 * Anthropic content-block format) and the UI transcript (`display`,
 * {role, text, at}) are SEPARATE arrays. Mixing them posts {role, text}
 * objects to the Messages API, which rejects them with a 400 — the app
 * "worked" in unit tests and failed on the first real send.
 */
const fs = require('fs');
const path = require('path');
const { UsageStats } = require('./usage');
let seq = 0;
const newId = () => `tab-${Date.now().toString(36)}-${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Replace base64 image payloads with a note — used for the on-disk copy and
 *  for restored sessions (a restored screenshot is gone; its text note stays). */
function stripImages(messages) {
  return JSON.parse(JSON.stringify(messages || [], (k, v) => {
    if (v && typeof v === 'object' && v.type === 'image' && v.source && v.source.data) {
      return { type: 'text', text: '[screenshot image — not persisted]' };
    }
    return v;
  }));
}
/**
 * Repair a transcript broken by a quit/crash mid-turn (audit M2): an
 * assistant message carrying tool_use blocks MUST be followed by a user
 * message whose tool_results cover every id, or the provider 400s the tab
 * forever. Drop the dangling assistant message and anything after it.
 * (The original macOS app has the same repair; v1 shipped without it.)
 */
function repairTranscript(messages) {
  const out = [];
  for (let i = 0; i < (messages || []).length; i++) {
    const m = messages[i];
    out.push(m);
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const ids = m.content.filter(b => b.type === 'tool_use').map(b => b.id);
      if (!ids.length) continue;
      const next = messages[i + 1];
      const covered = next && next.role === 'user' && Array.isArray(next.content)
        ? new Set(next.content.filter(b => b.type === 'tool_result').map(b => b.tool_use_id)) : new Set();
      if (!ids.every(id => covered.has(id))) { out.pop(); break; } // dangling: truncate here
    }
  }
  return out;
}
/**
 * Crash-safe replacement of a file with `text`: write to a sibling temp
 * file, fsync it, then rename over the target. A power loss at any instant
 * leaves either the complete old file or the complete new one — never a
 * torn file. (Directory fsync is best-effort: unsupported on Windows.)
 */
function writeTmpRename(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  try { const dfd = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } } catch { /* ignore */ }
}
/**
 * Write `text` as the new content of `file`, first rotating the previous
 * on-disk payload into `<file>.bak` (only if it still parses — never back
 * up garbage). load paths fall back to the .bak when the main file is
 * unparseable, so one bad write can never silently erase user state.
 */
function atomicWriteJson(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const prev = fs.readFileSync(file, 'utf8');
    JSON.parse(prev); // throws on garbage -> skip rotation
    writeTmpRename(file + '.bak', prev);
  } catch { /* no previous good payload */ }
  writeTmpRename(file, text);
}
class ChatStore {
  constructor(dataDir, priceOverrides = {}) {
    this.file = path.join(dataDir, 'chats.json');
    this.priceOverrides = priceOverrides;
    this.tabs = []; this.activeId = null;
    this._lastSaved = null; // dirty-check: payload string last successfully written by save()
    /** Set when load() had to recover state from a .bak file; the
     *  coordinator can log/surface this (recovery is never silent). */
    this.recoveryInfo = { chatsFromBackup: false, archiveFromBackup: false };
    this.load();
    if (!this.tabs.length) this.newTab();
  }
  /** Read+parse `file`; on any failure retry `<file>.bak`. Returns { data, fromBackup } or null. */
  _readJsonWithBackup(file) {
    try { return { data: JSON.parse(fs.readFileSync(file, 'utf8')), fromBackup: false }; } catch { /* try backup */ }
    try { return { data: JSON.parse(fs.readFileSync(file + '.bak', 'utf8')), fromBackup: true }; } catch { /* try mirror */ }
    // Mirror = the latest successfully saved payload (closes the first-write
    // gap .bak rotation leaves, same pattern as the spend ledger).
    try { return { data: JSON.parse(fs.readFileSync(file + '.mirror', 'utf8')), fromBackup: true }; } catch { return null; }
  }
  load() {
    const res = this._readJsonWithBackup(this.file);
    if (!res) { this.tabs = []; this.activeId = null; return; }
    {
      const j = res.data || {};
      this.tabs = (j.tabs || []).map(t => {
        // migrate v1 files where display entries were mixed into messages
        const mixed = Array.isArray(t.messages) ? t.messages : [];
        const display = Array.isArray(t.display) ? t.display : mixed.filter(m => typeof m?.text === 'string' && !('content' in m)).map(m => ({ role: m.role, text: m.text, at: m.at }));
        const messages = repairTranscript(stripImages(mixed.filter(m => 'content' in m)));
        return { id: t.id, title: t.title, model: t.model, messages, display, queue: Array.isArray(t.queue) ? t.queue : [], usage: UsageStats.fromJSON(t.usage, this.priceOverrides), createdAt: t.createdAt };
      });
      this.activeId = j.activeId && this.tabs.some(t => t.id === j.activeId) ? j.activeId : (this.tabs[0]?.id || null);
    }
    if (res.fromBackup) {
      this.recoveryInfo.chatsFromBackup = true;
      // Heal: rewrite the main file from the recovered in-memory state so the
      // next launch doesn't depend on the backup. Rotation inside save()
      // skips unparseable payloads, so the good .bak is not overwritten.
      try { this.save(); } catch { /* state survives in memory regardless */ }
    }
  }
  /** Coalesced save for hot paths (per-request usage updates mid-turn). */
  saveSoon() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; try { this.save(); } catch { /* best effort */ } }, 250);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }
  save() {
    const payload = { v: 2, activeId: this.activeId, tabs: this.tabs.map(t => ({ id: t.id, title: t.title, model: t.model, messages: stripImages(t.messages), display: t.display, queue: t.queue, usage: t.usage.toJSON(), createdAt: t.createdAt })) };
    const text = JSON.stringify(payload);
    if (text === this._lastSaved) return; // dirty-check: payload unchanged since last successful write
    atomicWriteJson(this.file, text);
    try { atomicWriteJson(this.file + '.mirror', text); } catch { /* mirror is best-effort redundancy */ }
    this._lastSaved = text;
  }
  newTab(model) {
    const tab = { id: newId(), title: 'New chat', model: model || 'claude-sonnet-5-5', messages: [], display: [], queue: [], usage: new UsageStats(model, this.priceOverrides), createdAt: new Date().toISOString() };
    this.tabs.push(tab); this.activeId = tab.id; this.save();
    return tab;
  }
  get(id) { return this.tabs.find(t => t.id === (id || this.activeId)) || this.tabs[0]; }
  archiveFile() { return path.join(path.dirname(this.file), 'archive.json'); }
  readArchive() {
    const res = this._readJsonWithBackup(this.archiveFile());
    if (!res) return [];
    if (res.fromBackup) this.recoveryInfo.archiveFromBackup = true;
    return Array.isArray(res.data) ? res.data : [];
  }
  writeArchive(list) { try { atomicWriteJson(this.archiveFile(), JSON.stringify(list.slice(0, 200))); } catch { /* best effort */ } }
  /** Closed chats with content are archived (his ChatArchive) so History can reopen them. */
  archiveTab(tab) {
    if (!tab.display?.length) return;
    const list = this.readArchive().filter(a => a.id !== tab.id);
    list.unshift({ id: tab.id, title: tab.title, model: tab.model, display: tab.display, messages: stripImages(tab.messages), usage: tab.usage.toJSON(), preview: (tab.display.find(m => m.role === 'user')?.text || '').slice(0, 120), updatedAt: new Date().toISOString() });
    this.writeArchive(list);
  }
  listArchive() { return this.readArchive().map(a => ({ id: a.id, title: a.title, preview: a.preview, updatedAt: a.updatedAt })); }
  openArchived(id) {
    const list = this.readArchive(); const a = list.find(x => x.id === id); if (!a) return null;
    this.writeArchive(list.filter(x => x.id !== id));
    const tab = { id: a.id, title: a.title, model: a.model, messages: repairTranscript(a.messages || []), display: a.display || [], queue: [], usage: UsageStats.fromJSON(a.usage, this.priceOverrides), createdAt: new Date().toISOString() };
    this.tabs.push(tab); this.activeId = tab.id; this.save();
    return tab;
  }
  deleteArchived(id) { this.writeArchive(this.readArchive().filter(x => x.id !== id)); }
  closeTab(id) {
    const i = this.tabs.findIndex(t => t.id === id); if (i === -1) return { closed: false, hideSidebar: false };
    const [removed] = this.tabs.splice(i, 1);
    this.archiveTab(removed);
    if (!this.tabs.length) { this.activeId = null; this.save(); return { closed: true, hideSidebar: true }; } // original: closing last tab hides sidebar
    if (this.activeId === id) this.activeId = this.tabs[Math.max(0, i - 1)].id;
    this.save(); return { closed: true, hideSidebar: false };
  }
  renameFromFirstMessage(tab) {
    const first = (tab.display || []).find(m => m.role === 'user');
    if (first && tab.title === 'New chat') tab.title = String(first.text || '').slice(0, 28) || tab.title; // original truncates title at 28 chars
  }
  /** UI transcript only. NEVER put display entries into tab.messages (the API transcript). */
  addDisplay(tab, entry) { tab.display.push(entry); this.renameFromFirstMessage(tab); this.save(); }
  enqueue(tab, text) { tab.queue.push({ text, queuedAt: new Date().toISOString() }); this.save(); }
  dequeue(tab) { const q = tab.queue.shift(); this.save(); return q; }
  clear(tab) { tab.messages = []; tab.display = []; tab.queue = []; /* usage intentionally kept — original resets it, we don't */ this.save(); }
  publicState() {
    return { activeId: this.activeId, tabs: this.tabs.map(t => ({ id: t.id, title: t.title, model: t.model, display: t.display, queue: t.queue, usage: t.usage.snapshot() })) };
  }
}
module.exports = { ChatStore, stripImages, repairTranscript, atomicWriteJson, writeTmpRename };
