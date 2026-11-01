'use strict';
/* Cross-platform syntax check (npm run check). The old version used a POSIX
   shell for-loop, which cannot run under cmd.exe on Windows — the exact
   platform this app ships on. This walks the same file set in Node. */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const files = ['main.js', 'preload.js', path.join('renderer', 'renderer.js'),
  ...fs.readdirSync(path.join(root, 'src')).filter(f => f.endsWith('.js')).map(f => path.join('src', f)),
  ...fs.readdirSync(path.join(root, 'scripts')).filter(f => f.endsWith('.js')).map(f => path.join('scripts', f))];
let failed = 0;
for (const rel of files) {
  try { execFileSync(process.execPath, ['--check', path.join(root, rel)], { stdio: 'pipe' }); }
  catch (e) { failed++; console.error(`SYNTAX FAIL ${rel}\n${e.stderr?.toString() || e.message}`); }
}
if (failed) { console.error(`${failed} file(s) failed`); process.exit(1); }
console.log(`ALL_SYNTAX_OK (${files.length} files)`);
