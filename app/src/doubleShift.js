'use strict';
/**
 * DoubleShiftDetector — ported from the original D-Shift's DoubleShiftMonitor
 * (tap < 250 ms, two taps within 400 ms, any other key resets) and hardened:
 *  - left/right Shift tracked independently AND combined (either side counts)
 *  - a tap used while another modifier is held does NOT count (no Ctrl+Shift)
 *  - secure-input / long-press (key repeat) never counts
 * Pure state machine: feed it events, it tells you when to toggle.
 * Events: { type:'shiftDown'|'shiftUp'|'otherKey'|'modifierDown', side:'left'|'right'|null, time:<ms>, repeat?:bool }
 */
const TAP_MAX_MS = 250;      // original: 0.25 s
const DOUBLE_GAP_MS = 400;   // original: 0.4 s

class DoubleShiftDetector {
  constructor({ tapMaxMs = TAP_MAX_MS, doubleGapMs = DOUBLE_GAP_MS, onTrigger = null } = {}) {
    this.tapMaxMs = tapMaxMs;
    this.doubleGapMs = doubleGapMs;
    this.onTrigger = onTrigger;
    this.reset();
  }
  reset() {
    this.downAt = null;       // when the current shift press started
    this.downSide = null;
    this.dirty = false;       // another key/modifier joined this press
    this.lastTapAt = null;    // when the previous clean tap ended
  }
  /** Returns true exactly on the event that completes a double-tap. */
  feed(ev) {
    if (!ev || typeof ev.time !== 'number') return false;
    switch (ev.type) {
      case 'shiftDown': {
        if (ev.repeat) return false;                 // holding Shift is not a tap
        if (this.downAt !== null) { this.dirty = true; return false; } // both shifts at once
        this.downAt = ev.time; this.downSide = ev.side || null; this.dirty = false;
        return false;
      }
      case 'otherKey':
      case 'modifierDown': {
        if (this.downAt !== null) this.dirty = true; // typing capitals never triggers
        this.lastTapAt = null;
        return false;
      }
      case 'shiftUp': {
        if (this.downAt === null) return false;
        const duration = ev.time - this.downAt;
        const wasDirty = this.dirty;
        this.downAt = null; this.dirty = false;
        if (wasDirty || duration > this.tapMaxMs || duration < 0) { this.lastTapAt = null; return false; }
        // clean tap
        if (this.lastTapAt !== null && (ev.time - this.lastTapAt) <= this.doubleGapMs) {
          this.lastTapAt = null;
          if (this.onTrigger) this.onTrigger(ev.time);
          return true;
        }
        this.lastTapAt = ev.time;
        return false;
      }
      default: return false;
    }
  }
}
module.exports = { DoubleShiftDetector, TAP_MAX_MS, DOUBLE_GAP_MS };
