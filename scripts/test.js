'use strict';
/* Cross-platform test runner (npm test). Shell globs (tests/*.test.js) don't
   expand under cmd.exe, and `node --test <dir>` behaves inconsistently across
   Node versions — so enumerate the suite files explicitly and pass them as
   arguments, which works identically on Windows, macOS and Linux. */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'tests');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js')).sort().map(f => path.join(dir, f));
if (!files.length) { console.error('no test files found'); process.exit(1); }
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
