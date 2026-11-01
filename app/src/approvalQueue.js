'use strict';
/**
 * ApprovalQueue — serializes user-approval prompts (audit fix B2).
 * v1 let parallel tool calls fire several approval cards into ONE modal:
 * the second overwrote the first's id and the turn hung forever; Stop and
 * walk-away hung it too. This queue guarantees: one card at a time, every
 * request resolves (allow / deny / timeout / cancelled), in FIFO order.
 * cancelAll() also poisons asks that are queued but not yet presented —
 * a Stop pressed in that gap must not leave a promise pending forever.
 */
class ApprovalQueue {
  constructor({ present, timeoutMs = 120000 } = {}) {
    if (typeof present !== 'function') throw new Error('present callback required');
    this.present = present; this.timeoutMs = timeoutMs;
    this.chain = Promise.resolve(); this.pending = new Set(); this.generation = 0;
  }
  /** Returns a promise that ALWAYS resolves to boolean. Never rejects, never hangs. */
  ask(payload) {
    const gen = this.generation;
    const run = () => new Promise(resolve => {
      let timer = null;
      const entry = { finish: ok => { this.pending.delete(entry); if (timer) clearTimeout(timer); resolve(!!ok); } };
      if (gen !== this.generation) { entry.finish(false); return; } // cancelled while queued
      timer = setTimeout(() => entry.finish(false), this.timeoutMs);
      if (timer.unref) timer.unref();
      this.pending.add(entry);
      try { this.present(payload, entry.finish); } catch { entry.finish(false); }
    });
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }
  /** Stop pressed / app quitting: resolve everything outstanding as denied. */
  cancelAll() { this.generation++; for (const e of [...this.pending]) e.finish(false); }
  get size() { return this.pending.size; }
}
module.exports = { ApprovalQueue };
