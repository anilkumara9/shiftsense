'use strict';
/**
 * Settings — file-backed config + API-key handling.
 * Key storage: the Electron main process encrypts keys with safeStorage
 * (Windows DPAPI) and stores only ciphertext in settings.json. This module
 * is the pure file/format layer so it can be unit-tested without Electron.
 * Resolution order mirrors the original: env > ./.env > ~/.config/dshift/.env
 * > stored (encrypted) key.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const DEFAULTS = {
  provider: 'anthropic',                       // anthropic | openai | ollama
  model: 'claude-sonnet-5-5',
  effort: 'low',                               // low | medium | high  (original hardcodes low)
  dataDir: '',                                 // '' = ~/DShift
  denylist: ['1password', 'keepass', 'bitwarden', 'lastpass', 'dashlane'],
  budgetUSDPerDay: 0,                          // 0 = no cap
  launchAtLogin: false,
  fallbackShortcut: 'CommandOrControl+Shift+Space',
  priceOverrides: {},
  encryptedKeys: {},                           // provider -> base64 ciphertext (safeStorage)
};
function settingsPath(dataDir) { return path.join(dataDir, 'settings.json'); }
function loadSettings(dataDir) {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath(dataDir), 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}
function saveSettings(dataDir, s) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = settingsPath(dataDir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ ...DEFAULTS, ...s }, null, 2));
  fs.renameSync(tmp, settingsPath(dataDir));
}
function parseDotEnv(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}
function envKey(provider, env = process.env, cwd = process.cwd(), home = os.homedir()) {
  const name = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  if (env[name]) return env[name];
  for (const p of [path.join(cwd, '.env'), path.join(home, '.config', 'dshift', '.env')]) {
    try { const v = parseDotEnv(fs.readFileSync(p, 'utf8'))[name]; if (v) return v; } catch { /* next */ }
  }
  return null;
}
module.exports = { DEFAULTS, loadSettings, saveSettings, parseDotEnv, envKey, settingsPath };
