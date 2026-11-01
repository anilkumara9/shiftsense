'use strict';
/**
 * ShellPolicy — a hardened port of the original Shell.swift policy.
 * The original allowlist missed common read-only tools and its read path did
 * not resolve symlinks; this version:
 *  - widens the allowlist with sort/uniq/awk-free read-only staples (sort, uniq, cut, ls…)
 *  - rejects the same chaining/redirection/substitution characters
 *  - rejects absolute paths, ~, .., flag-attached paths, exec/write flags
 *  - is used ONLY as defence-in-depth: D Shift's own memory search is
 *    implemented in-process (MemoryStore.search) and never spawns a shell
 *    for the model's search_memory calls at all. The policy remains for the
 *    optional "advanced: run read-only shell in memory folder" setting.
 */
const ALLOWED = new Set(['rg','grep','egrep','fgrep','find','ls','cat','head','tail','wc','tree','file','stat','sort','uniq','cut','du']);
const FORBIDDEN_CHARS = /[;&`$<>\n\\(){}|]/;           // note: | also banned — pipelines are split & checked per segment by callers if enabled
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F]/; // SEC-P2: \r and friends are token boundaries to some shells, not to ours — ambiguity is banned
const FORBIDDEN_FLAGS = ['-exec','-execdir','-ok','-okdir','-delete','-fprint','-fprintf','-fls','--pre'];
function segmentOk(segment) {
  const parts = segment.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return false;
  const cmd = parts[0];
  if (!ALLOWED.has(cmd)) return false;
  let positional = 0;
  for (const a of parts.slice(1)) {
    if (FORBIDDEN_FLAGS.includes(a) || FORBIDDEN_FLAGS.some(f => a.startsWith(f) || a.startsWith(f + '='))) return false;
    if (a.startsWith('/') || a === '~' || a.startsWith('~/')) return false;
    if (/^[A-Za-z]:/.test(a)) return false; // SEC-P2: Windows drive paths (C:/…, C:…) are absolute on the target platform
    if (a.startsWith('--output')) return false; // no allowlisted read-only tool has a benign --output
    // SEC-P1: sort and tree can WRITE a file via -o/--output, including inside
    // a combined short-flag cluster (`sort -ro out.md`). ls -o is benign and
    // ls is not in this branch.
    if ((cmd === 'sort' || cmd === 'tree') && /^-[A-Za-z]*o/.test(a)) return false;
    if (a.split('/').includes('..')) return false;
    if (/^-[a-zA-Z]*\//.test(a) || /^--[\w-]+=\//.test(a)) return false; // flag-attached path
    if (!a.startsWith('-')) positional++;
  }
  // SEC-P1: uniq's optional second positional argument is an OUTPUT file.
  if (cmd === 'uniq' && positional > 1) return false;
  return true;
}
function isReadOnlyWithinFolder(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > 2000) return false;
  if (FORBIDDEN_CHARS.test(command) || CONTROL_CHARS.test(command)) return false;
  if (command.includes('&&') || command.includes('||')) return false;
  return segmentOk(command);
}
module.exports = { isReadOnlyWithinFolder, ALLOWED };
