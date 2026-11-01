# Changelog

## 1.5.1 — Close-crash fix + environment hardening (2026-11-02)

Fixes the crash a real user hit on Windows within minutes of installing v1.5.0, plus the whole class of related issues found by auditing every timer, send, and shutdown path in the main process.

- **Fixed: "Object has been destroyed" error dialog on close.** The 4-second screen-context tracker kept firing after the window was torn down during quit, and calling `isVisible()` on a destroyed window throws. The tracker is now guarded by a destroyed-aware check and is cleared on quit. A new `npm run smoke` regression harness boots the real app, destroys the window, and fails if any destroyed-object error escapes — it reproduces the original crash exactly (2 errors) against the old code and passes against this build.
- **Every window/renderer access hardened.** All main-process code now goes through destroyed-aware guards (`winAlive()` / `sendTo()`): streaming sends during a mid-turn quit, tray menu actions, approval cards, the resize-save timer, the Esc paths, and the key-hook callbacks can no longer throw against a dead window. The window reference is nulled on `closed`.
- **Orderly quit.** `will-quit` now stops the context tracker, cancels approvals, stops Codex and the UI Automation host, stops the keyboard hook, and flushes chats to disk — nothing outlives the app, and a pending coalesced save is no longer lost on exit.
- **No more raw error dialogs.** A main-process safety net logs unexpected errors to `~/DShift/logs/crash.log`; destroyed-object shutdown races are swallowed after logging, and anything else shows one friendly dialog naming the log file instead of a stack trace.
- **Fits changing displays.** Remembered panel size/position is clamped to the display that exists at launch (a size saved on a large monitor can no longer open off-screen on a laptop), and if a monitor is unplugged while the panel sits on it, the panel is re-docked onto the primary display.
- **Download checksums are now automatic**: every release ships `SHA256SUMS.txt` (v1.5.0's was backfilled manually).

## 1.5.0 — Scale-and-release pass (2026-11-01)

Everything re-verified end to end, the repo restructured into a standard product layout, and the first GitHub Release (Windows installer built by CI on a real Windows runner).

- **Repository layout flattened** — the app no longer hides inside an `app/` subfolder; `src/`, `native/`, `renderer/`, `tests/`, `scripts/`, `docs/` sit at the root.
- **Full product scaffolding** — LICENSE, `.env.example` (the documented key-resolution order), issue/PR templates, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, `docs/` (architecture, memory, tools), and GitHub Actions: CI on Windows **and** Linux, plus a tag-triggered release workflow that tests, preflights, builds the installer, and publishes it.
- **Cross-platform developer scripts** — `npm run check`, `npm test`, and `npm run shot` previously relied on POSIX shell behaviour (a `for` loop, glob expansion, env prefixes) that cannot run under cmd.exe — on the very platform this app ships on. All three now run through Node launchers that behave identically everywhere.
- **Persistence performance fix** — every chat save was re-reading, re-parsing and re-writing the entire previous payload just to rotate the backup (~4 full writes + 2 parses per save). Rotation is now a verified rename when the store knows its last-written payload, and the mirror no longer keeps a backup of itself. One save at a full 50-tab / 1.4 MB state: **12 ms**.
- **Heavy-load stress suite** (`npm run stress`) — 50 tabs × 40 messages, 1,000 memory files with ranked search and a 1,000-entry audit-chain verification, a 9,330-node accessibility tree serialized under the caps, 10,000 ledger operations with exact totals, 1,000 reserve/settle cycles, 100 serialized approvals: all within budget.
- Symlink security tests now skip cleanly where symlink creation needs elevation (Windows without Developer Mode) instead of failing.

## 1.4.0 — Team build (2026-11-01)

Six specialist engineering lanes, integrated and fully re-verified (99/99 tests):

- **Performance:** persistent UIA host (`native/uia-host.ps1` + `src/uiaClient.js`) — screen reads no longer spawn a cold PowerShell per read; one-shot script remains as fallback.
- **Security (19 fixes):** dangling-symlink write escape in memory, Codex discovery can no longer resolve through the launch folder or cwd, `.cmd`-shim task injection refused, hash-chained tamper-evident audit trails (memory + Codex), full settings validation, shell-policy write holes closed.
- **Reliability:** atomic writes (temp + fsync + rename) with `.bak` rotation and mirror recovery for chats and the budget ledger; fixed a 2³¹-token usage overflow that corrupted cost stats on long-lived tabs; race-safe budget reserve/settle.
- **AI engine:** Anthropic prompt caching (system + tools), retry with backoff on 429/5xx that never double-streams text, 30 s stream watchdog, 240 s per-turn wall-clock budget with partial-answer return.
- **Platform:** asar-safe packaging (native scripts unpacked so PowerShell can read them), packaged-file whitelist, generated multi-size icons, `preflight` build gate.
- **QA:** 12-test end-to-end chaos suite (crash mid-turn, walked-away approvals, parallel computer tasks stopped at once, provider switching, corrupted state files, cost math to 6 decimals).

## 1.3.0 — UI parity

The sidebar UI rebuilt as a faithful port of the original's SwiftUI interface — same theme tokens, layout order, Thinking row, tool chips/groups, Codex task cards, inline approval cards, usage-bar format, slash commands, history archive, feedback composer, API-key setup screen, text zoom, image attachments — cross-checked line-by-line against `recon/UI_SPEC.md`. Additions in the same visual language: per-tab model picker, memory and settings in the tab strip.

## 1.2.0 — Production hardening

Two adversarial audits (the second independent, `recon/AUDIT_V1.md`) — 2 blockers, 11 majors, ~15 minors, all fixed with regression tests: display/API transcript split (first-send 400), tool calling on OpenAI/Ollama, enforced budget cap, last-external-window context tracking (the sidebar can never read itself), serialized approval queue (no deadlock), provider/model remapping, Esc via the key hook instead of a global hijack, foreground-matched screenshots, `.cmd`-aware Codex spawning, thinking-block preservation, transcript windowing and crash repair.

## 1.0.0 — First build

Ground-up Windows rebuild of the macOS original (reverse-engineered in full, `recon/RECON_REPORT.md`): double-tap Shift sidebar, UIA accessibility-first screen context, markdown memory with audit + undo, persistent multi-tab chat with token/cost stats, tray settings with DPAPI-encrypted keys, Anthropic/OpenAI/Ollama providers, approval-gated Codex handoff.
