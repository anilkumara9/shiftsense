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
const FORBIDDEN_FLAGS = ['-exec','-execdir','-ok','-okdir','-delete','-fprint','-fprintf','-fls','--pre','-delete'];
function segmentOk(segment) {
  const parts = segment.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return false;
  if (!ALLOWED.has(parts[0])) return false;
  for (const a of parts.slice(1)) {
    if (FORBIDDEN_FLAGS.includes(a) || FORBIDDEN_FLAGS.some(f => a.startsWith(f + '='))) return false;
    if (a.startsWith('/') || a === '~' || a.startsWith('~/')) return false;
    if (a.split('/').includes('..')) return false;
    if (/^-[a-zA-Z]*\//.test(a) || /^--[\w-]+=\//.test(a)) return false; // flag-attached path
  }
  return true;
}
function isReadOnlyWithinFolder(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > 2000) return false;
  if (FORBIDDEN_CHARS.test(command)) return false;
  if (command.includes('&&') || command.includes('||')) return false;
  return segmentOk(command);
}
module.exports = { isReadOnlyWithinFolder, ALLOWED };
