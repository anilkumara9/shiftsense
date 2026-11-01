'use strict';
/* Cross-platform UI-screenshot launcher (npm run shot). Electron refuses to
   run as root without the sandbox disabled; POSIX env-prefix syntax in an
   npm script would break cmd.exe, so set it here instead. Only applied when
   actually running as root (Linux dev VMs) — never for normal users. */
const { spawnSync } = require('child_process');
const path = require('path');
const electron = require('electron');
const env = { ...process.env };
if (typeof process.getuid === 'function' && process.getuid() === 0) env.ELECTRON_DISABLE_SANDBOX = '1';
const r = spawnSync(electron, [path.join(__dirname, 'ui-shot.js')], { stdio: 'inherit', env });
process.exit(r.status ?? 1);
