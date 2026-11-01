'use strict';
/**
 * ChatStore — multi-tab chats that PERSIST across restarts.
 * The original's tabs die on quit (its own roadmap lists "Persist chat tabs
 * across restarts" as unbuilt). Tabs, messages, per-tab usage and the queue
 * are saved to <data>/chats.json (atomic write) and restored on launch.
 */
const fs = require('fs');
const path = require('path');
const { UsageStats } = require('./usage');
let seq = 0;
const newId = () => `tab-${Date.now().toString(36)}-${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

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
      this.tabs = (j.tabs || []).map(t => ({ ...t, usage: UsageStats.fromJSON(t.usage, this.priceOverrides), queue: Array.isArray(t.queue) ? t.queue : [] }));
      this.activeId = j.activeId && this.tabs.some(t => t.id === j.activeId) ? j.activeId : (this.tabs[0]?.id || null);
    } catch { this.tabs = []; this.activeId = null; }
  }
  save() {
    const payload = { v: 1, activeId: this.activeId, tabs: this.tabs.map(t => ({ id: t.id, title: t.title, model: t.model, messages: t.messages, queue: t.queue, usage: t.usage.toJSON(), createdAt: t.createdAt })) };
    const tmp = this.file + '.tmp';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, this.file);
  }
  newTab(model) {
    const tab = { id: newId(), title: 'New chat', model: model || 'claude-sonnet-5-5', messages: [], queue: [], usage: new UsageStats(model, this.priceOverrides), createdAt: new Date().toISOString() };
    this.tabs.push(tab); this.activeId = tab.id; this.save();
    return tab;
  }
  get(id) { return this.tabs.find(t => t.id === (id || this.activeId)) || this.tabs[0]; }
  closeTab(id) {
    const i = this.tabs.findIndex(t => t.id === id); if (i === -1) return { closed: false, hideSidebar: false };
    this.tabs.splice(i, 1);
    if (!this.tabs.length) { this.activeId = null; this.save(); return { closed: true, hideSidebar: true }; } // original: closing last tab hides sidebar
    if (this.activeId === id) this.activeId = this.tabs[Math.max(0, i - 1)].id;
    this.save(); return { closed: true, hideSidebar: false };
  }
  renameFromFirstMessage(tab) {
    const first = tab.messages.find(m => m.role === 'user');
    if (first && tab.title === 'New chat') tab.title = String(first.text || '').slice(0, 28) || tab.title; // original truncates title at 28 chars
  }
  addMessage(tab, msg) { tab.messages.push(msg); this.renameFromFirstMessage(tab); this.save(); }
  enqueue(tab, text) { tab.queue.push({ text, queuedAt: new Date().toISOString() }); this.save(); }
  dequeue(tab) { const q = tab.queue.shift(); this.save(); return q; }
  clear(tab) { tab.messages = []; tab.queue = []; /* usage intentionally kept — original resets it, we don't */ this.save(); }
  publicState() {
    return { activeId: this.activeId, tabs: this.tabs.map(t => ({ id: t.id, title: t.title, model: t.model, messages: t.messages, queue: t.queue, usage: t.usage.snapshot() })) };
  }
}
module.exports = { ChatStore };
