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
class ChatStore {
  constructor(dataDir, priceOverrides = {}) {
    this.file = path.join(dataDir, 'chats.json');
    this.priceOverrides = priceOverrides;
    this.tabs = []; this.activeId = null;
    this.load();
    if (!this.tabs.length) this.newTab();
  }
  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.tabs = (j.tabs || []).map(t => {
        // migrate v1 files where display entries were mixed into messages
        const mixed = Array.isArray(t.messages) ? t.messages : [];
        const display = Array.isArray(t.display) ? t.display : mixed.filter(m => typeof m?.text === 'string' && !('content' in m)).map(m => ({ role: m.role, text: m.text, at: m.at }));
        const messages = repairTranscript(stripImages(mixed.filter(m => 'content' in m)));
        return { id: t.id, title: t.title, model: t.model, messages, display, queue: Array.isArray(t.queue) ? t.queue : [], usage: UsageStats.fromJSON(t.usage, this.priceOverrides), createdAt: t.createdAt };
      });
      this.activeId = j.activeId && this.tabs.some(t => t.id === j.activeId) ? j.activeId : (this.tabs[0]?.id || null);
    } catch { this.tabs = []; this.activeId = null; }
  }
  /** Coalesced save for hot paths (per-request usage updates mid-turn). */
  saveSoon() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; try { this.save(); } catch { /* best effort */ } }, 250);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }
  save() {
    const payload = { v: 2, activeId: this.activeId, tabs: this.tabs.map(t => ({ id: t.id, title: t.title, model: t.model, messages: stripImages(t.messages), display: t.display, queue: t.queue, usage: t.usage.toJSON(), createdAt: t.createdAt })) };
    const tmp = this.file + '.tmp';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, this.file);
  }
  newTab(model) {
    const tab = { id: newId(), title: 'New chat', model: model || 'claude-sonnet-5-5', messages: [], display: [], queue: [], usage: new UsageStats(model, this.priceOverrides), createdAt: new Date().toISOString() };
    this.tabs.push(tab); this.activeId = tab.id; this.save();
    return tab;
  }
  get(id) { return this.tabs.find(t => t.id === (id || this.activeId)) || this.tabs[0]; }
  archiveFile() { return path.join(path.dirname(this.file), 'archive.json'); }
  readArchive() { try { return JSON.parse(fs.readFileSync(this.archiveFile(), 'utf8')); } catch { return []; } }
  writeArchive(list) { try { fs.writeFileSync(this.archiveFile(), JSON.stringify(list.slice(0, 200))); } catch { /* best effort */ } }
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
module.exports = { ChatStore, stripImages, repairTranscript };
