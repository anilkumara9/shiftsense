'use strict';
/* Quit-smoke regression (npm run smoke).
 *
 * Reproduces the v1.5.0 crash a real user hit on Windows: "TypeError:
 * Object has been destroyed at Timeout._onTimeout (main.js:171)" when
 * closing the app — the 4s context tracker fired after the window was
 * destroyed. This harness boots the REAL main.js, destroys the window the
 * way quit does, waits through multiple tracker ticks, and fails if any
 * destroyed-object error escapes.
 *
 * Self-spawning: run with plain node, it relaunches itself under Electron.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.versions.electron) {
  const { spawnSync } = require('child_process');
  const electron = require('electron');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshift-smoke-'));
  const env = { ...process.env, DSHIFT_DATA_DIR: dataDir };
  if (typeof process.getuid === 'function' && process.getuid() === 0) env.ELECTRON_DISABLE_SANDBOX = '1';
  const r = spawnSync(electron, [__filename], { stdio: 'inherit', env, timeout: 120000 });
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(r.status ?? 1);
}

/* ---- Electron mode ---- */
const { app, BrowserWindow } = require('electron');
let destroyedErrors = 0;
process.on('uncaughtException', err => {
  if (/Object has been destroyed/i.test(String(err?.message || err))) destroyedErrors++;
});
app.setPath('userData', path.join(process.env.DSHIFT_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'dshift-smoke-')), 'electron-user-data'));
require(path.join(__dirname, '..', 'main.js'));

const deadline = setTimeout(() => { console.error('QUIT_SMOKE_TIMEOUT'); app.exit(2); }, 60000);
const poll = setInterval(() => {
  const wins = BrowserWindow.getAllWindows();
  if (!wins.length) return;
  clearInterval(poll);
  setTimeout(() => {
    wins[0].destroy(); // exactly what app quit does to the window
    setTimeout(() => {
      clearTimeout(deadline);
      if (destroyedErrors > 0) { console.error(`QUIT_SMOKE_FAIL: ${destroyedErrors} destroyed-object error(s) escaped after window teardown`); app.exit(1); }
      console.log('QUIT_SMOKE_OK: window destroyed, tracker ticks fired, no destroyed-object errors');
      app.exit(0);
    }, 9500); // >2 tracker ticks (4s cadence)
  }, 1200);
}, 250);
