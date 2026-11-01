'use strict';
/**
 * D Shift — Windows sidebar (Electron main process)
 * Double-tap Shift anywhere -> translucent, floating sidebar that does not
 * steal focus from the app you are asking about. Esc closes it.
 * Windows answers to the macOS original (recon §9):
 *   non-activating NSPanel  -> focusable:false + showInactive(), flipped to
 *                              focusable only while you type, plus an optional
 *                              native WS_EX_NOACTIVATE helper note in README
 *   menu bar item           -> system tray (notification area) menu
 *   Keychain                -> safeStorage (Windows DPAPI)
 *   AX tree                 -> UI Automation via native/uia-dump.ps1
 *   ScreenCaptureKit        -> desktopCapturer (window scope, sidebar excluded)
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, desktopCapturer, shell, safeStorage, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { DoubleShiftDetector } = require('./src/doubleShift');
const { MemoryStore, defaultDataDir } = require('./src/memory');
const { serializeTree, decideContext } = require('./src/contextEngine');
const { ChatStore } = require('./src/chatStore');
const settingsMod = require('./src/settings');
const { CodexHandoff } = require('./src/codex');
const { anthropicStream, openaiStream } = require('./src/llm');
const { runTurn, SYSTEM_PROMPT } = require('./src/agent');

const dataDir = defaultDataDir();
const memory = new MemoryStore(dataDir).seed();
let settings = settingsMod.loadSettings(dataDir);
const store = new ChatStore(dataDir, settings.priceOverrides);
const codex = new CodexHandoff({ dataDir });
let win = null, tray = null, lastContextHash = null, lastContext = null, aborter = null;
let codexDetected = { found: false };

// ---------- single instance (original: SingleInstance.swift) ----------
if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => toggleSidebar(true));

// ---------- window ----------
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 420, height = workArea.height - 16;
  win = new BrowserWindow({
    width, height, x: workArea.x + workArea.width - width - 8, y: workArea.y + 8,
    frame: false, transparent: true,          // translucency (Win11 acrylic via CSS backdrop too)
    alwaysOnTop: true, skipTaskbar: true, resizable: true, show: false,
    focusable: false,                          // peek without stealing focus
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', e => { if (!app.isQuitting) { e.preventDefault(); hideSidebar(); } });
}
function showSidebar() {
  if (!win) createWindow();
  win.setFocusable(true);                      // deliberate: typing needs key focus
  win.showInactive();                          // show without activating the app
  win.webContents.send('sidebar:shown');
  registerEsc();
}
function hideSidebar() { if (win) win.hide(); try { globalShortcut.unregister('Escape'); } catch {} }
function toggleSidebar(forceShow = false) { if (win && win.isVisible() && !forceShow) hideSidebar(); else showSidebar(); }
function registerEsc() {
  try { globalShortcut.register('Escape', () => { if (win && win.isVisible()) hideSidebar(); }); } catch { /* already */ }
}

// ---------- double-Shift global hook (uiohook-napi; fallback shortcut always on) ----------
function startShiftHook() {
  const detector = new DoubleShiftDetector({ onTrigger: () => toggleSidebar() });
  try {
    const { uIOhook, UiohookKey } = require('uiohook-napi');
    const SHIFT = new Set([UiohookKey.Shift, UiohookKey.ShiftRight]);
    uIOhook.on('keydown', e => {
      const t = Date.now();
      if (SHIFT.has(e.keycode)) detector.feed({ type: 'shiftDown', side: e.keycode === UiohookKey.ShiftRight ? 'right' : 'left', time: t, repeat: !!e.repeat });
      else if (e.ctrlKey || e.altKey || e.metaKey) detector.feed({ type: 'modifierDown', time: t });
      else detector.feed({ type: 'otherKey', time: t });
    });
    uIOhook.on('keyup', e => { if (SHIFT.has(e.keycode)) detector.feed({ type: 'shiftUp', time: Date.now() }); });
    uIOhook.start();
  } catch (e) {
    console.warn('[dshift] uiohook-napi unavailable, double-Shift disabled; fallback shortcut active:', e.message);
  }
  globalShortcut.register(settings.fallbackShortcut || 'CommandOrControl+Shift+Space', () => toggleSidebar());
}

// ---------- screen context: UIA first, screenshot only on demand ----------
function runUIA() {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve(null); // dev on mac/linux: no UIA
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'native', 'uia-dump.ps1')],
      { timeout: 4000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
      });
  });
}
async function getContext(force) {
  if (!force && lastContext && Date.now() - lastContext.at < 1500) return lastContext.value;
  const raw = await runUIA();
  if (!raw || !raw.root) { lastContext = { at: Date.now(), value: { app: '', title: '', text: '', mode: 'none' } }; return lastContext.value; }
  const snap = serializeTree(raw.root);
  const decision = decideContext({ appName: raw.app, snapshot: snap, denylist: settings.denylist, lastHash: force ? null : lastContextHash });
  if (decision.hash) lastContextHash = decision.hash;
  const value = { app: raw.app, title: raw.title, text: decision.mode === 'unchanged' ? '(screen unchanged since last read)' : decision.text, mode: decision.mode, needsScreenshot: decision.needsScreenshot };
  lastContext = { at: Date.now(), value };
  return value;
}
async function takeScreenshot(scope = 'window') {
  const sources = await desktopCapturer.getSources({ types: [scope === 'screen' ? 'screen' : 'window'], thumbnailSize: { width: 1568, height: 1568 } });
  // exclude our own sidebar, prefer the largest remaining window (original's fallback heuristic)
  const usable = sources.filter(s => !/D Shift/i.test(s.name));
  const src = usable.sort((a, b) => b.thumbnail.getSize().width - a.thumbnail.getSize().width)[0] || sources[0];
  if (!src) return { text: 'No capturable window found.' };
  const img = src.thumbnail.resize({ width: Math.min(1568, src.thumbnail.getSize().width) });
  return { text: `Screenshot of "${src.name}" (accessibility was insufficient).`, jpegBase64: img.toJPEG(80).toString('base64') };
}

// ---------- API keys (safeStorage / DPAPI on Windows) ----------
function getApiKey(provider) {
  const fromEnv = settingsMod.envKey(provider);
  if (fromEnv) return fromEnv;
  const enc = settings.encryptedKeys?.[provider];
  if (enc && safeStorage.isEncryptionAvailable()) { try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { return null; } }
  return null;
}
function setApiKey(provider, key) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption unavailable');
  settings.encryptedKeys = settings.encryptedKeys || {};
  settings.encryptedKeys[provider] = safeStorage.encryptString(key).toString('base64');
  settingsMod.saveSettings(dataDir, settings);
}

// ---------- LLM wiring ----------
async function callLLM(tab, args) {
  const provider = settings.provider;
  const model = tab.model || settings.model;
  if (provider === 'openai') return openaiStream({ apiKey: getApiKey('openai'), model, system: SYSTEM_PROMPT, messages: args.messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.filter(b => b.type === 'text').map(b => b.text).join('\n') })), onText: args.onText, signal: aborter?.signal });
  if (provider === 'ollama') return openaiStream({ apiKey: '', baseURL: 'http://localhost:11434/v1', model: model.replace(/^ollama[:/]/, ''), system: SYSTEM_PROMPT, messages: args.messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })), onText: args.onText, signal: aborter?.signal });
  return anthropicStream({ apiKey: getApiKey('anthropic'), model, system: SYSTEM_PROMPT, messages: args.messages, tools: args.tools, effort: settings.effort, onText: args.onText, signal: aborter?.signal });
}

// ---------- IPC ----------
function wireIPC() {
  ipcMain.handle('state:get', () => ({ state: store.publicState(), settings: { provider: settings.provider, model: settings.model, effort: settings.effort, hasAnthropicKey: !!getApiKey('anthropic'), hasOpenAIKey: !!getApiKey('openai'), dataDir, memoryDir: memory.memoryDir, codex: codexDetected, budgetUSDPerDay: settings.budgetUSDPerDay } }));
  ipcMain.handle('tab:new', () => { store.newTab(settings.model); return store.publicState(); });
  ipcMain.handle('tab:close', (_e, id) => { const r = store.closeTab(id); if (r.hideSidebar) hideSidebar(); return store.publicState(); });
  ipcMain.handle('tab:activate', (_e, id) => { store.activeId = id; store.save(); return store.publicState(); });
  ipcMain.handle('tab:model', (_e, id, model) => { const t = store.get(id); if (t) { t.model = model; t.usage.model = model; store.save(); } return store.publicState(); });
  ipcMain.handle('chat:clear', (_e, id) => { const t = store.get(id); if (t) store.clear(t); return store.publicState(); });
  ipcMain.handle('chat:stop', () => { aborter?.abort(); codex.stop(); });
  ipcMain.handle('memory:open', () => shell.openPath(memory.memoryDir));
  ipcMain.handle('memory:read', (_e, rel) => memory.readFile(rel));
  ipcMain.handle('memory:write', (_e, rel, content) => memory.write(rel, content, 'replace', 'user'));
  ipcMain.handle('memory:list', () => ({ files: memory.listFiles(500), overview: memory.overview(), audit: memory.audit(30) }));
  ipcMain.handle('memory:undo', (_e, rel) => memory.undoLastWrite(rel));
  ipcMain.handle('settings:save', (_e, patch) => { settings = { ...settings, ...patch }; settingsMod.saveSettings(dataDir, settings); return { ok: true }; });
  ipcMain.handle('settings:key', (_e, provider, key) => { setApiKey(provider, key); return { ok: true }; });
  ipcMain.handle('codex:detect', async () => { codexDetected = await codex.detect(); return codexDetected; });
  // Codex approval round-trip: renderer shows the card; ONLY its Allow click resolves this.
  const pendingApprovals = new Map();
  ipcMain.on('codex:decision', (_e, approvalId, approved) => { const p = pendingApprovals.get(approvalId); if (p) { pendingApprovals.delete(approvalId); p(approved); } });

  ipcMain.handle('chat:send', async (e, tabId, question) => {
    const tab = store.get(tabId); if (!tab) throw new Error('no tab');
    store.addMessage(tab, { role: 'user', text: question, at: new Date().toISOString() });
    memory.logHistory({ role: 'user', text: question, tabId: tab.id });
    codex.newTurn(); aborter = new AbortController();
    const host = {
      memory,
      getContext: async force => { if (force) tab.usage.screenReads++; return getContext(force); },
      takeScreenshot: async scope => { tab.usage.screenshots++; return takeScreenshot(scope); },
      onUsage: u => { tab.usage.record(u); store.save(); e.sender.send('state:patch', store.publicState()); },
      callLLM: args => callLLM(tab, args),
      requestCodexApproval: async task => {
        if (!codexDetected.found) codexDetected = await codex.detect();
        if (!codexDetected.found) return { text: 'Codex CLI is not installed, so the task was not run. Tell the user.' };
        const req = codex.requestApproval(task);
        e.sender.send('codex:approval', req);
        const approved = await new Promise(res => pendingApprovals.set(req.approvalId, res));
        if (!approved) { codex.deny(req.approvalId); return { text: 'The user declined this computer task. Do not retry it.' }; }
        const r = await codex.approve(req.approvalId, codexDetected.path, txt => e.sender.send('codex:progress', { approvalId: req.approvalId, text: txt }));
        return { text: r.text };
      },
    };
    try {
      const res = await runTurn({ tab, question, host, onText: delta => e.sender.send('chat:delta', { tabId: tab.id, delta }), onTool: t => e.sender.send('chat:tool', { tabId: tab.id, ...t }) });
      const lastText = [...tab.messages].reverse().find(m => m.role === 'assistant');
      store.addMessage(tab, { role: 'assistant', text: res.text || (Array.isArray(lastText?.content) ? lastText.content.filter(b => b.type === 'text').map(b => b.text).join('') : ''), at: new Date().toISOString() });
      memory.logHistory({ role: 'assistant', text: res.text || '', tabId: tab.id });
    } catch (err) {
      e.sender.send('chat:error', { tabId: tab.id, error: String(err.message || err) });
    }
    store.save();
    return store.publicState();
  });
}

// ---------- tray (the Windows "menu bar app") ----------
function createTray() {
  const iconPath = path.join(__dirname, 'renderer', 'icon.png');
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('D Shift — double-tap Shift');
  const menu = Menu.buildFromTemplate([
    { label: 'Show / Hide Sidebar  (double-tap Shift)', click: () => toggleSidebar() },
    { label: 'New Chat Tab', click: () => { store.newTab(settings.model); showSidebar(); win?.webContents.send('state:patch', store.publicState()); } },
    { type: 'separator' },
    { label: 'Open Memory Folder', click: () => shell.openPath(memory.memoryDir) },
    { label: 'Change API Key…', click: () => { showSidebar(); win?.webContents.send('ui:openSettings'); } },
    { label: 'Settings…', click: () => { showSidebar(); win?.webContents.send('ui:openSettings'); } },
    { type: 'separator' },
    { label: settings.provider === 'anthropic' ? '✓ Anthropic' : 'Use Anthropic', click: () => { settings.provider = 'anthropic'; settingsMod.saveSettings(dataDir, settings); createTray(); } },
    { label: settings.provider === 'openai' ? '✓ OpenAI' : 'Use OpenAI', click: () => { settings.provider = 'openai'; settingsMod.saveSettings(dataDir, settings); createTray(); } },
    { label: settings.provider === 'ollama' ? '✓ Ollama (local, free)' : 'Use Ollama (local, free)', click: () => { settings.provider = 'ollama'; settingsMod.saveSettings(dataDir, settings); createTray(); } },
    { type: 'separator' },
    { label: 'Quit D Shift', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => toggleSidebar());
}

app.whenReady().then(async () => {
  createWindow(); wireIPC(); createTray(); startShiftHook();
  codexDetected = await codex.detect().catch(() => ({ found: false }));
  if (settings.launchAtLogin) app.setLoginItemSettings({ openAtLogin: true }); // beats original: roadmap item, shipped here
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { /* tray app: stay alive */ });
