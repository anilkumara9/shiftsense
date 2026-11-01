'use strict';
/**
 * Usage accounting — ported from the original Usage.swift, then fixed:
 *  - prices live in an editable table (the original hardcodes them in source;
 *    its own recon shows they'll rot) and can be overridden from settings
 *  - usage PERSISTS to disk per tab (the original resets on quit / /clear)
 *  - optional budget cap with warn/block thresholds
 * All prices USD per 1M tokens. Verify on build day via the provider's
 * Models/pricing pages — see recon/DOCS_RESEARCH.md §4.3.
 */
const PRICE_TABLE = {
  // Anthropic (per DOCS_RESEARCH 2026-11-01 — re-verify in Settings)
  'claude-sonnet-5-5': { provider: 'anthropic', input: 2.0, output: 10.0, cacheRead: 0.20, cacheWrite: 2.50, contextWindow: 1000000 },
  'claude-opus-5-5':   { provider: 'anthropic', input: 4.0, output: 20.0, cacheRead: 0.20, cacheWrite: 5.00, contextWindow: 1000000 },
  'claude-haiku-5-5':  { provider: 'anthropic', input: 0.10, output: 0.50, cacheRead: 0.01, cacheWrite: 0.125, contextWindow: 200000 },
  // OpenAI
  'gpt-5':        { provider: 'openai', input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite: 1.25, contextWindow: 400000 },
  'gpt-5-mini':   { provider: 'openai', input: 0.25, output: 2.0, cacheRead: 0.025, cacheWrite: 0.25, contextWindow: 400000 },
  // Local (Ollama) — free
  'ollama':       { provider: 'ollama', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextWindow: 128000 },
};
function priceFor(model, overrides = {}) {
  if (overrides && overrides[model]) return { ...PRICE_TABLE['claude-sonnet-5-5'], ...overrides[model] };
  if (PRICE_TABLE[model]) return PRICE_TABLE[model];
  if (/^ollama[:/]/i.test(model || '')) return PRICE_TABLE.ollama;
  return PRICE_TABLE['claude-sonnet-5-5'];
}
class UsageStats {
  constructor(model = 'claude-sonnet-5-5', priceOverrides = {}) {
    this.model = model; this.priceOverrides = priceOverrides;
    this.input = 0; this.output = 0; this.cacheRead = 0; this.cacheWrite = 0;
    this.requests = 0; this.lastRequestTotal = 0; this.screenshots = 0; this.screenReads = 0;
  }
  record({ input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = {}) {
    this.input += input; this.output += output; this.cacheRead += cacheRead; this.cacheWrite += cacheWrite;
    this.lastRequestTotal = input + output + cacheRead + cacheWrite; // original's context formula (recon §2.6)
    this.requests += 1;
    return this.snapshot();
  }
  cost(model = this.model) {
    const p = priceFor(model, this.priceOverrides);
    return (this.input * p.input + this.output * p.output + this.cacheRead * p.cacheRead + this.cacheWrite * p.cacheWrite) / 1e6;
  }
  cacheHitRate() {
    const denom = this.cacheRead + this.input + this.cacheWrite;
    return denom === 0 ? 0 : this.cacheRead / denom;
  }
  contextFraction(model = this.model) {
    const w = priceFor(model, this.priceOverrides).contextWindow || 1000000;
    return Math.min(1, this.lastRequestTotal / w);
  }
  snapshot() {
    return {
      model: this.model, input: this.input, output: this.output,
      cacheRead: this.cacheRead, cacheWrite: this.cacheWrite, requests: this.requests,
      lastRequestTotal: this.lastRequestTotal, screenshots: this.screenshots, screenReads: this.screenReads,
      costUSD: +this.cost().toFixed(6), cacheHitRate: +this.cacheHitRate().toFixed(4),
      contextFraction: +this.contextFraction().toFixed(4),
    };
  }
  toJSON() { return { ...this.snapshot(), priceOverrides: undefined }; }
  static fromJSON(j, priceOverrides = {}) {
    const u = new UsageStats(j?.model || 'claude-sonnet-5-5', priceOverrides);
    if (j) { u.input = j.input|0; u.output = j.output|0; u.cacheRead = j.cacheRead|0; u.cacheWrite = j.cacheWrite|0; u.requests = j.requests|0; u.lastRequestTotal = j.lastRequestTotal|0; u.screenshots = j.screenshots|0; u.screenReads = j.screenReads|0; }
    return u;
  }
}
module.exports = { UsageStats, PRICE_TABLE, priceFor };
