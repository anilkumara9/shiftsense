'use strict';
/**
 * Settings — file-backed config + API-key handling.
 * Key storage: the Electron main process encrypts keys with safeStorage
 * (Windows DPAPI) and stores only ciphertext in settings.json. This module
 * is the pure file/format layer so it can be unit-tested without Electron.
 * Resolution order mirrors the original: env > ./.env > ~/.config/dshift/.env
 * > stored (encrypted) key.
 *
 * SEC-S1: settings.json is an attack surface — it arrives via renderer IPC
 * merges and hand edits, and its values flow into globalShortcut.register(),
 * the context denylist, and the budget gate. loadSettings/saveSettings now
 * run every known field through sanitizeSettings(): enums are enforced, the
 * budget is a finite clamped number (never NaN), the denylist is always a
 * string array, the fallback shortcut must be a modifier+key accelerator,
 * price overrides keep only numeric fields, encrypted keys must be base64
 * strings, and panelBounds must be sane numbers. Unknown keys pass through
 * untouched (forward-compatible), but they can no longer smuggle type
 * confusion into the fields main actually consumes.
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
const PROVIDERS = ['anthropic', 'openai', 'ollama'];
const EFFORTS = ['low', 'medium', 'high'];
const PRICE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'contextWindow'];
const ACCEL_MODS = new Set(['CommandOrControl', 'Command', 'Control', 'Ctrl', 'Alt', 'Option', 'Shift', 'Super', 'Meta', 'AltGr']);
const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);

/** A valid Electron accelerator: >=1 known modifier + a single key token.
 *  A bare letter ("A") or arbitrary string must never reach globalShortcut. */
function isValidAccelerator(s) {
  if (typeof s !== 'string' || !s || s.length > 64) return false;
  const parts = s.split('+').map(x => x.trim());
  if (parts.length < 2) return false;
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (!mods.length || !mods.every(m => ACCEL_MODS.has(m))) return false;
  return /^[A-Za-z0-9]$/.test(key) || /^F([1-9]|1[0-9]|2[0-4])$/.test(key)
    || /^(Space|Tab|Enter|Return|Escape|Esc|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|Plus)$/.test(key);
}
function sanitizeDenylist(v) {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
  if (!raw) return [...DEFAULTS.denylist];
  const out = [];
  for (const item of raw) {
    const s = String(item).trim().toLowerCase();
    if (s && s.length <= 64 && !out.includes(s)) out.push(s);
    if (out.length >= 50) break;
  }
  return out;
}
function sanitizePriceOverrides(v) {
  if (!isPlainObject(v)) return {};
  const out = {};
  for (const [model, prices] of Object.entries(v)) {
    if (typeof model !== 'string' || model.length > 80 || !isPlainObject(prices)) continue;
    const clean = {};
    for (const f of PRICE_FIELDS) {
      const n = Number(prices[f]);
      if (Number.isFinite(n) && n >= 0 && (f !== 'contextWindow' || n > 0)) clean[f] = n;
    }
    if (Object.keys(clean).length) out[model] = clean;
  }
  return out;
}
function sanitizeEncryptedKeys(v) {
  if (!isPlainObject(v)) return {};
  const out = {};
  for (const [provider, blob] of Object.entries(v)) {
    if (typeof blob === 'string' && blob.length <= 16384 && /^[A-Za-z0-9+/=]+$/.test(blob)) out[provider] = blob;
  }
  return out;
}
function sanitizePanelBounds(v) {
  if (!isPlainObject(v)) return undefined;
  const { width, height, yOffset } = v;
  const ok = [width, height, yOffset].every(n => Number.isFinite(Number(n)))
    && Number(width) >= 300 && Number(width) <= 4000 && Number(height) >= 320 && Number(height) <= 4000 && Number(yOffset) >= 0 && Number(yOffset) <= 4000;
  return ok ? { width: Number(width), height: Number(height), yOffset: Number(yOffset) } : undefined;
}
function sanitizeSettings(raw) {
  const s = { ...DEFAULTS, ...(isPlainObject(raw) ? raw : {}) };
  if (!PROVIDERS.includes(s.provider)) s.provider = DEFAULTS.provider;
  if (!EFFORTS.includes(s.effort)) s.effort = DEFAULTS.effort;
  if (!(typeof s.model === 'string' && /^[A-Za-z0-9._:\/-]{1,80}$/.test(s.model))) s.model = DEFAULTS.model;
  if (typeof s.dataDir !== 'string') s.dataDir = '';
  s.denylist = sanitizeDenylist(s.denylist);
  const budget = Number(s.budgetUSDPerDay);
  s.budgetUSDPerDay = Number.isFinite(budget) ? Math.min(100000, Math.max(0, budget)) : 0;
  s.launchAtLogin = s.launchAtLogin === true;
  if (!isValidAccelerator(s.fallbackShortcut)) s.fallbackShortcut = DEFAULTS.fallbackShortcut;
  s.priceOverrides = sanitizePriceOverrides(s.priceOverrides);
  s.encryptedKeys = sanitizeEncryptedKeys(s.encryptedKeys);
  const pb = sanitizePanelBounds(s.panelBounds);
  if (pb) s.panelBounds = pb; else delete s.panelBounds;
  return s;
}
function settingsPath(dataDir) { return path.join(dataDir, 'settings.json'); }
function loadSettings(dataDir) {
  try { return sanitizeSettings(JSON.parse(fs.readFileSync(settingsPath(dataDir), 'utf8'))); }
  catch { return sanitizeSettings(null); }
}
function saveSettings(dataDir, s) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = settingsPath(dataDir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(sanitizeSettings(s), null, 2));
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
/** SEC-S2: a key is printable ASCII with no whitespace/control characters.
 *  Anything else (a pasted sentence, a value with an embedded newline) is
 *  rejected — it would otherwise flow verbatim into an Authorization header. */
function plausibleKey(v) {
  return typeof v === 'string' && v.length >= 16 && v.length <= 512 && /^[\x21-\x7E]+$/.test(v);
}
function envKey(provider, env = process.env, cwd = process.cwd(), home = os.homedir()) {
  const name = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  if (plausibleKey(env[name])) return env[name];
  for (const p of [path.join(cwd, '.env'), path.join(home, '.config', 'dshift', '.env')]) {
    try { const v = parseDotEnv(fs.readFileSync(p, 'utf8'))[name]; if (plausibleKey(v)) return v; } catch { /* next */ }
  }
  return null;
}
module.exports = { DEFAULTS, loadSettings, saveSettings, parseDotEnv, envKey, settingsPath, sanitizeSettings, isValidAccelerator };
