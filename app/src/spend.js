'use strict';
/**
 * SpendLedger — daily spend tracking so the budget cap in Settings is REAL.
 * (v1 shipped the setting with nothing enforcing it — found in the audit.)
 * File: <data>/spend.json  { day: 'YYYY-MM-DD', usd: number }
 */
const fs = require('fs');
const path = require('path');
const { priceFor } = require('./usage');
function costOf(usage, model, overrides = {}) {
  const p = priceFor(model, overrides);
  return ((usage.input || 0) * p.input + (usage.output || 0) * p.output + (usage.cacheRead || 0) * p.cacheRead + (usage.cacheWrite || 0) * p.cacheWrite) / 1e6;
}
class SpendLedger {
  constructor(dataDir) { this.file = path.join(dataDir, 'spend.json'); this.day = this.today(); this.usd = 0; this.load(); }
  today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; } // LOCAL day — a budget resets at the user's midnight, not UTC's (audit minor)
  load() {
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (j.day === this.day) this.usd = +j.usd || 0; } catch { /* fresh day */ }
  }
  add(usd) {
    const day = this.today();
    if (day !== this.day) { this.day = day; this.usd = 0; }
    this.usd += Math.max(0, usd);
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify({ day: this.day, usd: +this.usd.toFixed(6) })); } catch { /* best effort */ }
    return this.usd;
  }
  spentToday() { if (this.today() !== this.day) return 0; return this.usd; }
  exceeded(capUSD) { return capUSD > 0 && this.spentToday() >= capUSD; }
}
module.exports = { SpendLedger, costOf };
