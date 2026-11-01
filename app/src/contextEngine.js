'use strict';
/**
 * ContextEngine — accessibility-first screen context for Windows (UIA),
 * the direct Windows answer to the original's AXSnapshot (recon §9).
 * Ported constants: 3,000 nodes max, depth 40, 60k chars, 500 chars/value,
 * selected text up to 2,000 chars, empty structural containers skipped.
 * Beats the original where recon §7.2 found it weak:
 *  - PASSWORD / secure fields are NEVER emitted (original can leak
 *    kAXValueAttribute of secure fields; UIA IsPassword is checked here)
 *  - per-app DENYLIST (password managers, banking by default): no read at all
 *  - snapshot DIFFING: unchanged subtrees are hashed; a repeat read returns
 *    "unchanged since last read" instead of re-sending up to 60k chars
 *  - THIN-TREE detection: <200 chars of text or <10 text-bearing nodes on a
 *    large window => needsScreenshot/OCR (the original's only fallback was
 *    a blind screenshot; we flag it explicitly and let the model decide)
 */
const MAX_NODES = 3000, MAX_CHARS = 60000, MAX_VALUE = 500, MAX_DEPTH = 40, MAX_SELECTED = 2000;
const SKIP_TYPES = new Set(['Group', 'Pane', 'Custom', 'Separator']); // structural, like AXGroup
const DEFAULT_DENYLIST = ['1password', 'keepass', 'bitwarden', 'lastpass', 'dashlane'];

function isDenied(appName, denylist = DEFAULT_DENYLIST) {
  const a = String(appName || '').toLowerCase();
  return denylist.some(d => a.includes(d));
}
/**
 * Serialize a UIA tree (plain JSON from native/uia-dump.ps1) to compact
 * indented text. Node shape:
 * { type, name, value, description, rect:[x,y,w,h], focused, isPassword,
 *   isSelectedText?, selectedText?, children: [] }
 */
function serializeTree(root, opts = {}) {
  const maxNodes = opts.maxNodes ?? MAX_NODES, maxChars = opts.maxChars ?? MAX_CHARS;
  const lines = []; let nodes = 0, textNodes = 0, textChars = 0, truncated = false;
  const seenNames = new Map();
  function label(node) {
    const parts = [];
    const type = String(node.type || 'Unknown').replace(/^ControlType\./, '');
    parts.push(type);
    const add = (v, cap = MAX_VALUE) => {
      if (!v) return; const s = String(v).slice(0, cap);
      if (seenNames.get(s) && parts.includes(s)) return; seenNames.set(s, 1);
      parts.push(JSON.stringify(s)); textChars += s.length;
    };
    if (node.isPassword) { parts.push('"(password — value hidden)"'); return { line: parts.join(' '), type }; }
    add(node.name); if (node.value && node.value !== node.name) add(node.value);
    if (node.description && node.description !== node.name) add(node.description);
    if (node.focused) parts.push('[focused]');
    if (node.rect && node.rect.length === 4) parts.push(`(${node.rect.join(',')})`);
    return { line: parts.join(' '), type };
  }
  function walk(node, depth) {
    if (!node || nodes >= maxNodes || depth > MAX_DEPTH) { if (nodes >= maxNodes) truncated = true; return; }
    const { line, type } = label(node);
    const kids = Array.isArray(node.children) ? node.children : [];
    const hasText = /"/.test(line);
    const skip = SKIP_TYPES.has(type) && !hasText && kids.length > 0 && !node.focused;
    if (!skip) { lines.push('  '.repeat(depth) + line); nodes++; if (hasText) textNodes++; }
    for (const k of kids) walk(k, skip ? depth : depth + 1);
  }
  if (root) walk(root, 0);
  let text = lines.join('\n');
  if (text.length > maxChars) { text = text.slice(0, maxChars); truncated = true; }
  let selected = '';
  if (root && root.selectedText) { selected = String(root.selectedText).slice(0, MAX_SELECTED); text += `\n\n[Selected text]\n${selected}`; }
  const thin = textChars < 200 || textNodes < 10;
  return { text, nodes, textNodes, textChars, truncated, thin, selectedText: selected };
}
function treeHash(serializedText) {
  let h = 5381; const s = String(serializedText || '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}
/** Decide what the model gets, in priority order. Pure decision function. */
function decideContext({ appName, snapshot, denylist, lastHash } = {}) {
  if (isDenied(appName, denylist)) return { mode: 'denied', text: '', needsScreenshot: false, reason: `${appName} is on your no-read list` };
  if (!snapshot || !snapshot.text) return { mode: 'none', text: '', needsScreenshot: true, reason: 'no accessibility tree available' };
  const hash = treeHash(snapshot.text);
  if (lastHash && hash === lastHash) return { mode: 'unchanged', text: '', needsScreenshot: false, hash, reason: 'screen unchanged since last read' };
  if (snapshot.thin) return { mode: 'thin', text: snapshot.text, needsScreenshot: true, hash, reason: 'accessibility tree is thin (canvas/image app?) — a screenshot or OCR will see more' };
  return { mode: 'accessibility', text: snapshot.text, needsScreenshot: false, hash, reason: 'accessibility tree' };
}
module.exports = { serializeTree, decideContext, treeHash, isDenied, DEFAULT_DENYLIST, MAX_NODES, MAX_CHARS, MAX_DEPTH };
