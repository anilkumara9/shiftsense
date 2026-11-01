'use strict';
/**
 * SpendLedger — daily spend tracking so the budget cap in Settings is REAL.
 * (v1 shipped the setting with nothing enforcing it — found in the audit.)
 * File: <data>/spend.json  { day: 'YYYY-MM-DD', usd: number }
 *
 * Reliability (v3 hardening):
 *  - Writes are crash-safe: previous payload rotates to spend.json.bak,
 *    new payload goes to a temp file + fsync + rename, and every payload is
 *    also mirrored to spend.json.mirror. load() falls back .bak -> .mirror
 *    when the main file is CORRUPT (a parseable stale-day file is a fresh
 *    day, never corruption) and flags the recovery on
 *    `recoveredFromBackup` instead of silently zeroing the day's spend
 *    (a zeroed ledger would defeat the budget cap after any corruption).
 *    The mirror exists because rotation alone leaves the FIRST write of a
 *    file unprotected — exactly the early-day state of this ledger.
 *  - The clock is injectable ({ now }) so day-rollover is testable.
 *  - add() is fully synchronous — no awaits — so concurrent callers in this
 *    process can never interleave mid-add. It also merges the on-disk value
 *    (adopts it when larger for the same day) so a second process's spend
 *    is not clobbered.
 *
 * Cap-check race: the caller pattern `if (!exceeded(cap)) await llm();
 * add(cost)` lets several parallel calls all pass the check before any of
 * them adds. Mitigation exposed here: reserve the estimated cost BEFORE
 * the awaited call, check with wouldExceed() (spent + reserved), then
 * settle() with the actual cost (or release() on failure):
 *    const r = ledger.reserve(est);
 *    if (ledger.wouldExceed(cap, r)) { ledger.release(r); // over budget }
 *    try { const u = await call(); ledger.settle(r, costOf(u, model)); }
 *    catch { ledger.release(r); }
 * exceeded() keeps its old spent-only semantics for existing callers.
 */
const fs = require('fs');
const path = require('path');
const { priceFor } = require('./usage');
const { atomicWriteJson, writeTmpRename } = require('./chatStore');
function costOf(usage, model, overrides = {}) {
  const p = priceFor(model, overrides);
  return ((usage.input || 0) * p.input + (usage.output || 0) * p.output + (usage.cacheRead || 0) * p.cacheRead + (usage.cacheWrite || 0) * p.cacheWrite) / 1e6;
}
class SpendLedger {
  /** opts.now: () => Date — injectable clock (tests); defaults to real time. */
  constructor(dataDir, opts = {}) {
    this.file = path.join(dataDir, 'spend.json');
    this._now = typeof opts.now === 'function' ? opts.now : () => new Date();
    this.day = this.today(); this.usd = 0;
    this.recoveredFromBackup = false;
    this._reservations = new Map(); this._resSeq = 0;
    this.load();
  }
  today() { const d = this._now(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; } // LOCAL day — a budget resets at the user's midnight, not UTC's (audit minor)
  load() {
    // Main file first. A PARSEABLE main file is authoritative: today's valid
    // payload wins; a stale-day payload means a fresh day (never consult the
    // backups — they can only be older). Only CORRUPTION (unparseable, or
    // today's date with a bogus amount) falls through to the backups:
    // .bak (previous write) first, then .mirror (latest write — it covers
    // the first-write-of-a-file case where no .bak rotation exists yet;
    // without it a single-add ledger corrupted before its second write
    // read as $0 and the budget cap failed open).
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!j || j.day !== this.day) return; // stale day: fresh day, not corruption
      if (Number.isFinite(+j.usd)) { this.usd = Math.max(0, +j.usd); return; }
    } catch { /* unparseable/missing: try the backups */ }
    for (const f of [this.file + '.bak', this.file + '.mirror']) {
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (j && j.day === this.day && Number.isFinite(+j.usd)) {
          this.usd = Math.max(0, +j.usd);
          this.recoveredFromBackup = true;
          return;
        }
      } catch { /* try the next backup */ }
    }
  }
  _persist() {
    const text = JSON.stringify({ day: this.day, usd: +this.usd.toFixed(6) });
    try {
      atomicWriteJson(this.file, text);
      // Mirror the just-written payload so even the FIRST write of the file
      // is recoverable (rotation alone only protects from the second write).
      try { writeTmpRename(this.file + '.mirror', text); } catch { /* best effort */ }
    } catch { /* best effort */ }
  }
  _rollover() {
    const day = this.today();
    if (day !== this.day) { this.day = day; this.usd = 0; this._reservations.clear(); }
  }
  add(usd) {
    this._rollover();
    // Merge: if the file holds a larger same-day total (written by another
    // process since our load), adopt it rather than clobbering it.
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (j && j.day === this.day && +j.usd > this.usd) this.usd = +j.usd; } catch { /* keep in-memory value */ }
    this.usd += Math.max(0, +usd || 0);
    this._persist();
    return this.usd;
  }
  spentToday() { return this.today() !== this.day ? 0 : this.usd; }
  exceeded(capUSD) { return capUSD > 0 && this.spentToday() >= capUSD; }
  /** Reserve an estimated amount against today's budget. Returns a token for settle()/release(). */
  reserve(estUSD) {
    this._rollover();
    const token = { id: ++this._resSeq, amount: Math.max(0, +estUSD || 0), day: this.day };
    this._reservations.set(token.id, token);
    return token;
  }
  /** Sum of live reservations for today (stale-day reservations are pruned). */
  reservedTotal() {
    const day = this.today(); let sum = 0;
    for (const [id, r] of this._reservations) { if (r.day !== day) this._reservations.delete(id); else sum += r.amount; }
    return sum;
  }
  /** Race-safe cap check: spent + reserved (+ optionally one extra pending reservation). */
  wouldExceed(capUSD, extra = null) {
    if (!(capUSD > 0)) return false;
    return this.spentToday() + this.reservedTotal() + (extra ? Math.max(0, +extra.amount || 0) : 0) >= capUSD;
  }
  /** Commit a reservation at its actual cost. Returns the new spent total. */
  settle(token, actualUSD) { if (token) this._reservations.delete(token.id); return this.add(actualUSD); }
  /** Drop a reservation without charging (call failed / was rejected). */
  release(token) { if (token) this._reservations.delete(token.id); }
}
module.exports = { SpendLedger, costOf };
