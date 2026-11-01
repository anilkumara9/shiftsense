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
  ask(payload) { return this.askDetailed(payload).then(r => r.ok); }
  /** Like ask(), but reports WHY: 'allowed' | 'denied' | 'timeout' | 'cancelled'
   *  so audit trails don't mislabel a timeout as a user denial. */
  askDetailed(payload) {
    const gen = this.generation;
    const run = () => new Promise(resolve => {
      let timer = null;
      const entry = { finish: (ok, reason) => { this.pending.delete(entry); if (timer) clearTimeout(timer); resolve({ ok: !!ok, reason: reason || (ok ? 'allowed' : 'denied') }); } };
      if (gen !== this.generation) { entry.finish(false, 'cancelled'); return; } // cancelled while queued
      timer = setTimeout(() => entry.finish(false, 'timeout'), this.timeoutMs);
      // Deliberately NOT unref'd: this timer resolves a promise a caller is
      // awaiting. An unref'd timer lets the event loop drain first in
      // bare-Node hosts (CI test runners on Node 20 fail such tests with
      // "Promise resolution is still pending"). In the app, the window and
      // hook keep the loop alive anyway; a pending approval SHOULD hold.
      this.pending.add(entry);
      try { this.present(payload, entry.finish); } catch { entry.finish(false, 'denied'); }
    });
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => ({ ok: false, reason: 'denied' }));
    return p;
  }
  /** Stop pressed / app quitting: resolve everything outstanding as denied. */
  cancelAll() { this.generation++; for (const e of [...this.pending]) e.finish(false, 'cancelled'); }
  get size() { return this.pending.size; }
}
module.exports = { ApprovalQueue };
