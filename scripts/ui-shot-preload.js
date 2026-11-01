'use strict';
/* Test-only preload: stubs window.dshift with a rich sample state so the
   parity UI can be screenshotted headlessly (npm run shot). */
const { contextBridge } = require('electron');
const usage = { model: 'claude-sonnet-5-5', input: 42100, output: 8300, cacheRead: 31200, cacheWrite: 1200, requests: 6, lastRequestTotal: 81234, screenshots: 1, screenReads: 3, costUSD: 0.412, cacheHitRate: 0.42, contextFraction: 0.08 };
const state = { activeId: 't1', tabs: [
  { id: 't1', title: 'Q3 launch email', model: 'claude-sonnet-5-5', queue: [], usage, display: [
    { role: 'user', text: 'Draft a reply to Sam about the launch date' },
    { role: 'assistant', text: 'Sam confirmed **Friday** works. The draft says:\n\n```\nHi Sam,\nFriday is locked for the launch.\n```\nWant me to tighten it?' },
  ] },
  { id: 't2', title: 'Chart question', model: 'gpt-5', queue: [], usage: { ...usage, costUSD: 0.02 }, display: [{ role: 'user', text: 'What does this chart show?' }] },
] };
const settings = { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low', hasAnthropicKey: true, hasOpenAIKey: false, keySources: { anthropic: 'stored (encrypted)' }, denylist: ['1password'], hook: { doubleShift: true, detail: 'double-Shift hook active' }, dataDir: 'C:\\Users\\you\\DShift', memoryDir: 'C:\\Users\\you\\DShift\\memory', codex: { found: true, version: 'codex-cli 0.5' }, budgetUSDPerDay: 0, spentToday: 0.41 };
contextBridge.exposeInMainWorld('dshift', {
  getState: async () => ({ state, settings }),
  newTab: async () => state, closeTab: async () => state, activateTab: async () => state,
  setTabModel: async () => state, clearChat: async () => state, send: async () => state, stop: async () => {},
  openMemory: async () => {}, listMemory: async () => ({ files: ['me.md', 'notes.md', 'people/sam.md'], overview: { meOverGuard: false }, audit: [] }),
  readMemory: async () => '# About me', writeMemory: async () => {}, undoMemory: async () => true,
  saveSettings: async () => ({ ok: true }), setKey: async () => ({ ok: true }), detectCodex: async () => ({ found: true }),
  codexDecision: () => {}, appshot: async () => ({}), historyList: async () => [], historyOpen: async () => state, historyDelete: async () => [],
  feedbackCapture: async () => ({}), feedbackSave: async () => ({ ok: true }), setAuto: async () => ({ auto: true }), getAuto: async () => ({ auto: false }),
  openExternal: async () => {},
  on: (ch, fn) => { if (ch === 'ctx:update') setTimeout(() => fn({ app: 'Chrome', title: 'Q3 Launch — Google Docs', mode: 'accessibility' }), 50); },
});
