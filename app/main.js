'use strict';
/**
 * D Shift — Windows sidebar (Electron main process)
 * Double-tap Shift anywhere -> translucent, floating sidebar.
 *
 * v2 (post-audit) architecture notes — the audit (recon/AUDIT_V1.md) found
 * two blockers in v1, both fixed here:
 *  B1  The sidebar must NEVER read its own window as "the screen". A
 *      background tracker follows the last EXTERNAL foreground window;
 *      all context comes from that tracked window, so clicking into the
 *      sidebar to type can never poison the context.
 *  B2  Codex approvals are serialized through ApprovalQueue: one card at
 *      a time, every request resolves (allow/deny/120s timeout/Stop).
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, desktopCapturer, shell, safeStorage, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { DoubleShiftDetector } = require('./src/doubleShift');
const { MemoryStore, defaultDataDir } = require('./src/memory');
const { serializeTree, decideContext, treeHash } = require('./src/contextEngine');
const { ChatStore } = require('./src/chatStore');
const settingsMod = require('./src/settings');
const { CodexHandoff } = require('./src/codex');
const { anthropicStream, openaiStream, resolveModel } = require('./src/llm');
const { runTurn, SYSTEM_PROMPT } = require('./src/agent');
const { SpendLedger, costOf } = require('./src/spend');
const { ApprovalQueue } = require('./src/approvalQueue');
const { UiaClient } = require('./src/uiaClient');
// Packaged builds keep native scripts OUTSIDE app.asar (powershell.exe cannot
// read inside an archive) — translate the path (platform lane's catch).
const nativePath = name => path.join(__dirname, 'native', name).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const uia = new UiaClient({ hostPath: nativePath('uia-host.ps1') });

const dataDir = defaultDataDir();
const memory = new MemoryStore(dataDir).seed();
let settings = settingsMod.loadSettings(dataDir);
const store = new ChatStore(dataDir, settings.priceOverrides);
const codex = new CodexHandoff({ dataDir });
const ledger = new SpendLedger(dataDir);
let win = null, tray = null, aborter = null;
let codexDetected = { found: false };
let hookStatus = { doubleShift: false, detail: 'starting' };
const PROVIDER_DEFAULT_MODEL = { anthropic: 'claude-sonnet-5-5', openai: 'gpt-5', ollama: 'ollama:llama3.1' };

// ---------- single instance (original: SingleInstance.swift) ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
app.on('second-instance', () => toggleSidebar(true));

// ---------- Codex approval queue (B2 fix) ----------
const approvals = new ApprovalQueue({
  timeoutMs: 120000,
  present: (payload, finish) => {
    pendingDecision = finish;
    win?.webContents.send('codex:approval', payload);
  },
});
let pendingDecision = null;

// ---------- window ----------
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  // His panel: 400pt default, min 300x320, docked right with an 8pt inset;
  // size and vertical position are remembered across launches.
  const saved = settings.panelBounds || {};
  const width = Math.max(300, saved.width || 400), height = Math.max(320, saved.height || workArea.height - 16);
  win = new BrowserWindow({
    width, height, x: workArea.x + workArea.width - width - 8, y: workArea.y + (saved.yOffset ?? 8), minWidth: 300, minHeight: 320,
    frame: false, transparent: true,
    alwaysOnTop: true, skipTaskbar: true, resizable: true, show: false,
    focusable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  let boundsTimer = null;
  win.on('resize', () => { clearTimeout(boundsTimer); boundsTimer = setTimeout(() => { if (!win) return; const b = win.getBounds(); const { workArea } = screen.getPrimaryDisplay(); settings.panelBounds = { width: b.width, height: b.height, yOffset: Math.max(0, b.y - workArea.y) }; settingsMod.saveSettings(dataDir, settings); }, 400); });
  win.on('close', e => { if (!app.isQuitting) { e.preventDefault(); hideSidebar(); } });
}
function showSidebar() {
  if (!win) createWindow();
  win.setFocusable(true);
  win.showInactive();
  win.webContents.send('sidebar:shown');
  registerEsc();
  const c = lastExternal.value;
  try { win.webContents.send('ctx:update', { app: c.app, title: c.title, mode: c.mode }); } catch { /* noop */ }
}
function hideSidebar() { if (win) win.hide(); try { globalShortcut.unregister('Escape'); } catch { /* noop */ } }
function toggleSidebar(forceShow = false) { if (win && win.isVisible() && !forceShow) hideSidebar(); else showSidebar(); }
function registerEsc() {
  // M4 fix: when the key hook is alive, Esc is OBSERVED (not consumed) there,
  // so other apps still receive it. globalShortcut — which hijacks Esc
  // system-wide — is only the fallback, and its result is checked.
  if (hookStatus.doubleShift) return;
  try {
    const ok = globalShortcut.register('Escape', () => { if (win && win.isVisible()) hideSidebar(); });
    if (!ok) console.warn('[dshift] Escape registration failed (another app owns it); use the ✕ button or double-Shift to close');
  } catch { /* already registered */ }
}

// ---------- double-Shift global hook ----------
function startShiftHook() {
  const detector = new DoubleShiftDetector({ onTrigger: () => toggleSidebar() });
  try {
    const { uIOhook, UiohookKey } = require('uiohook-napi');
    const SHIFT = new Set([UiohookKey.Shift, UiohookKey.ShiftRight]);
    uIOhook.on('keydown', e => {
      const t = Date.now();
      if (e.keycode === UiohookKey.Escape) { if (win && win.isVisible()) hideSidebar(); return; }
      if (SHIFT.has(e.keycode)) detector.feed({ type: 'shiftDown', side: e.keycode === UiohookKey.ShiftRight ? 'right' : 'left', time: t, repeat: !!e.repeat });
      else if (e.ctrlKey || e.altKey || e.metaKey) detector.feed({ type: 'modifierDown', time: t });
      else detector.feed({ type: 'otherKey', time: t });
    });
    uIOhook.on('keyup', e => { if (SHIFT.has(e.keycode)) detector.feed({ type: 'shiftUp', time: Date.now() }); });
    uIOhook.start();
    hookStatus = { doubleShift: true, detail: 'double-Shift hook active' };
  } catch (e) {
    hookStatus = { doubleShift: false, detail: `double-Shift unavailable (${e.message}); fallback shortcut active` };
    console.warn('[dshift]', hookStatus.detail);
  }
  globalShortcut.register(settings.fallbackShortcut || 'CommandOrControl+Shift+Space', () => toggleSidebar());
}

// ---------- screen context: TRACKED last external window (B1 fix) ----------
// lastExternal holds the serialized context of the most recent foreground
// window that is NOT D Shift itself. A slow tracker refreshes it while the
// sidebar is hidden; at send time we use the tracked snapshot, so the
// sidebar having focus can never contaminate the answer.
let lastExternal = { raw: null, value: { app: '', title: '', text: '', mode: 'none' }, hash: null, at: 0 };
async function runUIA() {
  if (process.platform !== 'win32') return null;
  // Fast path: the persistent UIA host (one warm PowerShell, ~tens of ms).
  if (uia.healthy) { const warm = await uia.dump().catch(() => null); if (warm) return warm; }
  // Fallback: the original one-shot script.
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', nativePath('uia-dump.ps1')],
      { timeout: 6000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
      });
  });
}
const isOurs = raw => {
  if (!raw) return true;
  if (raw.pid === process.pid) return true; // the sidebar lives in the main process
  return /^(D Shift|electron)$/i.test(String(raw.app || '')) && String(raw.title || '') === 'D Shift';
};
async function refreshExternal() {
  const raw = await runUIA();
  if (!raw || !raw.root || isOurs(raw)) return lastExternal.value;
  const snap = serializeTree(raw.root);
  const decision = decideContext({ appName: raw.app, snapshot: snap, denylist: settings.denylist, lastHash: null });
  lastExternal = { raw, hash: treeHash(snap.text), at: Date.now(), value: { app: raw.app, title: raw.title, text: decision.text, mode: decision.mode, needsScreenshot: decision.needsScreenshot } };
  return lastExternal.value;
}
async function getContext(force) {
  // One live attempt: if the user is still in their app (sidebar summoned
  // but not clicked), this is fresh. If the sidebar has focus, refresh
  // returns the tracked external snapshot instead of our own UI.
  const before = lastExternal.at;
  await refreshExternal();
  if (force && lastExternal.at === before && lastExternal.value.text) {
    return { ...lastExternal.value, text: lastExternal.value.text + '\n[note: live re-read unavailable while the sidebar has focus — this is the last tracked state of the app]' };
  }
  return lastExternal.value;
}
function startContextTracker() {
  setInterval(() => { if (!win || !win.isVisible()) refreshExternal().catch(() => {}); }, 4000);
}
async function takeScreenshot(scope = 'window') {
  const sources = await desktopCapturer.getSources({ types: [scope === 'screen' ? 'screen' : 'window'], thumbnailSize: { width: 1568, height: 1568 } });
  const usable = sources.filter(s => !/D Shift/i.test(s.name));
  // M5 fix: prefer the window the user is actually asking about (tracked title)
  const wanted = lastExternal.value.title;
  const src = usable.find(s => wanted && s.name === wanted) || usable.find(s => wanted && s.name.includes(wanted)) || usable.sort((a, b) => b.thumbnail.getSize().width - a.thumbnail.getSize().width)[0];
  if (!src) return { text: 'No capturable window found.' };
  const img = src.thumbnail.resize({ width: Math.min(1568, src.thumbnail.getSize().width) });
  return { text: `Screenshot of "${src.name}".`, jpegBase64: img.toJPEG(80).toString('base64') };
}

// ---------- API keys (safeStorage / DPAPI) + source visibility (M6 fix) ----------
function getKeySource(provider) {
  if (settingsMod.envKey(provider)) return 'environment / .env (takes precedence)';
  if (settings.encryptedKeys?.[provider]) return 'stored (encrypted)';
  return 'none';
}
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
  if (ledger.exceeded(settings.budgetUSDPerDay || 0)) throw new Error(`Daily budget cap reached ($${(settings.budgetUSDPerDay).toFixed(2)}). Raise it in Settings or wait until tomorrow.`);
  const provider = settings.provider;
  const model = resolveModel(provider, tab.model || settings.model); // M1 fix
  if (provider === 'openai') return openaiStream({ apiKey: getApiKey('openai'), model, system: SYSTEM_PROMPT, messages: args.messages, tools: args.tools, onText: args.onText, signal: aborter?.signal });
  if (provider === 'ollama') return openaiStream({ apiKey: '', baseURL: 'http://localhost:11434/v1', model, system: SYSTEM_PROMPT, messages: args.messages, tools: args.tools, onText: args.onText, signal: aborter?.signal });
  return anthropicStream({ apiKey: getApiKey('anthropic'), model, system: SYSTEM_PROMPT, messages: args.messages, tools: args.tools, effort: settings.effort, onText: args.onText, signal: aborter?.signal });
}

// ---------- IPC ----------
function wireIPC() {
  ipcMain.handle('ext:open', (_e, url) => { if (/^https:\/\//.test(String(url))) return shell.openExternal(url); });
  ipcMain.handle('state:get', () => ({ state: store.publicState(), settings: { provider: settings.provider, model: settings.model, effort: settings.effort, hasAnthropicKey: !!getApiKey('anthropic'), hasOpenAIKey: !!getApiKey('openai'), keySources: { anthropic: getKeySource('anthropic'), openai: getKeySource('openai') }, denylist: settings.denylist, hook: hookStatus, dataDir, memoryDir: memory.memoryDir, codex: codexDetected, budgetUSDPerDay: settings.budgetUSDPerDay, spentToday: +ledger.spentToday().toFixed(4) } }));
  ipcMain.handle('tab:new', () => { store.newTab(PROVIDER_DEFAULT_MODEL[settings.provider] || settings.model); return store.publicState(); });
  ipcMain.handle('tab:close', (_e, id) => { const r = store.closeTab(id); if (r.hideSidebar) hideSidebar(); return store.publicState(); });
  ipcMain.handle('tab:activate', (_e, id) => { store.activeId = id; store.save(); return store.publicState(); });
  ipcMain.handle('tab:model', (_e, id, model) => { const t = store.get(id); if (t) { t.model = model; t.usage.model = model; store.save(); } return store.publicState(); });
  ipcMain.handle('chat:clear', (_e, id) => { const t = store.get(id); if (t) store.clear(t); return store.publicState(); });
  ipcMain.handle('chat:stop', () => { aborter?.abort(); approvals.cancelAll(); codex.stop(); });
  ipcMain.handle('memory:open', () => shell.openPath(memory.memoryDir));
  ipcMain.handle('memory:read', (_e, rel) => memory.readFile(rel));
  ipcMain.handle('memory:write', (_e, rel, content) => memory.write(rel, content, 'replace', 'user'));
  ipcMain.handle('memory:list', () => ({ files: memory.listFiles(500), overview: memory.overview(), audit: memory.audit(30) }));
  ipcMain.handle('memory:undo', (_e, rel) => memory.undoLastWrite(rel));
  ipcMain.handle('settings:save', (_e, patch) => { settings = { ...settings, ...patch }; settingsMod.saveSettings(dataDir, settings); refreshTrayMenu(); return { ok: true }; });
  ipcMain.handle('settings:key', (_e, provider, key) => { setApiKey(provider, key); return { ok: true, source: getKeySource(provider) }; });
  ipcMain.handle('codex:detect', async () => { codexDetected = await codex.detect(); return codexDetected; });
  ipcMain.on('codex:decision', (_e, approved) => { const f = pendingDecision; pendingDecision = null; if (f) f(approved); });

  let sessionAuto = false; // his AutoMode, made session-only in ours: never persisted, dies with the app
  ipcMain.handle('auto:set', (_e, on) => { sessionAuto = !!on; return { auto: sessionAuto }; });
  ipcMain.handle('auto:get', () => ({ auto: sessionAuto }));
  ipcMain.handle('context:appshot', async () => { const s = await takeScreenshot('window'); return { dataUrl: s.jpegBase64 ? `data:image/jpeg;base64,${s.jpegBase64}` : null, jpegBase64: s.jpegBase64 || null, app: lastExternal.value.app, title: lastExternal.value.title }; });
  ipcMain.handle('history:list', () => store.listArchive());
  ipcMain.handle('history:open', (_e, id) => { store.openArchived(id); return store.publicState(); });
  ipcMain.handle('history:delete', (_e, id) => { store.deleteArchived(id); return store.listArchive(); });
  ipcMain.handle('feedback:capture', async () => { const s = await takeScreenshot('screen'); return { dataUrl: s.jpegBase64 ? `data:image/jpeg;base64,${s.jpegBase64}` : null, jpegBase64: s.jpegBase64 || null }; });
  ipcMain.handle('feedback:save', (_e, note, jpegBase64) => {
    const dir = path.join(dataDir, 'feedback'); fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const tab = store.get();
    fs.writeFileSync(path.join(dir, `${stamp}.md`), `# Feedback ${stamp}\n\n${note}\n\n## Chat (current tab: ${tab?.title || ''})\n\n${(tab?.display || []).map(m => `**${m.role}:** ${m.text}`).join('\n\n')}\n`);
    if (jpegBase64) fs.writeFileSync(path.join(dir, `${stamp}.jpg`), Buffer.from(jpegBase64, 'base64'));
    return { ok: true, dir };
  });
  ipcMain.handle('feedback:open', () => { const dir = path.join(dataDir, 'feedback'); fs.mkdirSync(dir, { recursive: true }); return shell.openPath(dir); });

  ipcMain.handle('chat:send', async (e, tabId, question, attachments = []) => {
    const tab = store.get(tabId); if (!tab) throw new Error('no tab');
    // Race-safe budget gate (reliability lane's reserve/settle): reserve an
    // estimate for the turn so two tabs sending at once can't both slip past
    // the cap; actuals are added per request in onUsage; release at turn end.
    const cap = settings.budgetUSDPerDay || 0;
    const reservation = cap > 0 ? ledger.reserve(0.25) : null;
    if (reservation && ledger.wouldExceed(cap, reservation)) { ledger.release(reservation); e.sender.send('chat:error', { tabId: tab.id, error: `Daily budget cap reached ($${cap.toFixed(2)}; spent $${ledger.spentToday().toFixed(2)} today). Raise it in Settings.` }); return store.publicState(); }
    if (ledger.exceeded(cap)) { if (reservation) ledger.release(reservation); e.sender.send('chat:error', { tabId: tab.id, error: `Daily budget cap reached ($${cap.toFixed(2)}; spent $${ledger.spentToday().toFixed(2)} today). Raise it in Settings.` }); return store.publicState(); }
    const atts = Array.isArray(attachments) ? attachments.filter(a => a && a.jpegBase64) : [];
    store.addDisplay(tab, { role: 'user', text: question, at: new Date().toISOString(), attachments: atts.map(a => a.dataUrl).filter(Boolean) });
    memory.logHistory({ role: 'user', text: question, tabId: tab.id });
    codex.newTurn(); aborter = new AbortController();
    const host = {
      memory,
      getContext: async force => { if (force) tab.usage.screenReads++; return getContext(force); },
      takeScreenshot: async scope => { tab.usage.screenshots++; return takeScreenshot(scope); },
      onUsage: u => { tab.usage.record(u); ledger.add(costOf(u, resolveModel(settings.provider, tab.model || settings.model), settings.priceOverrides)); store.saveSoon(); e.sender.send('state:patch', store.publicState()); },
      callLLM: args => callLLM(tab, args),
      requestCodexApproval: async task => {
        if (!codexDetected.found) codexDetected = await codex.detect();
        if (!codexDetected.found) return { text: 'Codex CLI is not installed, so the task was not run. Tell the user.' };
        let req;
        try { req = codex.requestApproval(task); } catch (err) { return { text: String(err.message || err) }; }
        const verdict = sessionAuto ? { ok: true, reason: 'allowed' } : await approvals.askDetailed(req); // serialized; always resolves (B2). Session auto skips the card but never the audit log.
        if (!verdict.ok) { codex.deny(req.approvalId, verdict.reason === 'timeout' ? 'approval timed out' : verdict.reason === 'cancelled' ? 'cancelled by user (Stop)' : 'denied by user'); return { text: 'The user did not approve this computer task (denied, timed out, or stopped). Do not retry it.' }; }
        const r = await codex.approve(req.approvalId, codexDetected.path, txt => e.sender.send('codex:progress', { approvalId: req.approvalId, text: txt }));
        return { text: r.text };
      },
    };
    try {
      const res = await runTurn({ tab, question, images: atts.map(a => a.jpegBase64), host, onText: delta => e.sender.send('chat:delta', { tabId: tab.id, delta }), onTool: t => e.sender.send('chat:tool', { tabId: tab.id, ...t }) });
      store.addDisplay(tab, { role: 'assistant', text: res.text || '', at: new Date().toISOString() });
      memory.logHistory({ role: 'assistant', text: res.text || '', tabId: tab.id });
    } catch (err) {
      e.sender.send('chat:error', { tabId: tab.id, error: String(err.message || err) });
    } finally {
      if (reservation) ledger.release(reservation); // actuals already added per request
    }
    store.save();
    return store.publicState();
  });
}

// ---------- tray (the Windows "menu bar app") ----------
function buildTrayMenu() {
  const prov = p => ({ label: settings.provider === p ? `✓ ${p}` : `Use ${p}`, click: () => { settings.provider = p; settingsMod.saveSettings(dataDir, settings); refreshTrayMenu(); } });
  // His exact menu first (labels/order from AppDelegate.swift), our extras after.
  return Menu.buildFromTemplate([
    { label: 'Toggle Sidebar (Shift Shift)', click: () => toggleSidebar() },
    { label: 'Open Memory Folder', click: () => shell.openPath(memory.memoryDir) },
    { label: 'Open Feedback Folder', click: () => { const dir = path.join(dataDir, 'feedback'); fs.mkdirSync(dir, { recursive: true }); shell.openPath(dir); } },
    { label: 'Change API Key...', click: () => { showSidebar(); win?.webContents.send('ui:openSettings'); } },
    { label: 'Set OpenAI API Key...', click: () => { settings.provider = 'openai'; settingsMod.saveSettings(dataDir, settings); showSidebar(); win?.webContents.send('ui:openSettings'); refreshTrayMenu(); } },
    { type: 'separator' },
    { label: 'New Chat Tab', click: () => { store.newTab(PROVIDER_DEFAULT_MODEL[settings.provider] || settings.model); showSidebar(); win?.webContents.send('state:patch', store.publicState()); } },
    { label: 'Settings…', click: () => { showSidebar(); win?.webContents.send('ui:openSettings'); } },
    prov('anthropic'), prov('openai'), prov('ollama'),
    { type: 'separator' },
    { label: 'Quit D-Shift', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
}
function refreshTrayMenu() { if (tray) tray.setContextMenu(buildTrayMenu()); }
function createTray() {
  if (tray) { refreshTrayMenu(); return; }
  const iconPath = path.join(__dirname, 'renderer', 'icon.png');
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('D Shift — double-tap Shift');
  refreshTrayMenu();
  tray.on('click', () => toggleSidebar());
}

if (gotLock) {
  app.whenReady().then(async () => {
    // Recovery is never silent (reliability lane): surface it in the log + settings.
    if (store.recoveryInfo.chatsFromBackup) console.warn('[dshift] chats were recovered from a backup file (the main chats file was damaged)');
    if (store.recoveryInfo.archiveFromBackup) console.warn('[dshift] chat archive was recovered from a backup file');
    if (ledger.recoveredFromBackup) console.warn('[dshift] today\'s spend ledger was recovered from a backup file');
    createWindow(); wireIPC(); createTray(); startShiftHook(); startContextTracker();
    refreshExternal().catch(() => {});
    codexDetected = await codex.detect().catch(() => ({ found: false }));
    if (settings.launchAtLogin) app.setLoginItemSettings({ openAtLogin: true });
  });
}
app.on('will-quit', () => { approvals.cancelAll(); globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => { /* tray app: stay alive */ });
