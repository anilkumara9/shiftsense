# Architecture

ShiftSense is an Electron app with a hard split: a **pure, tested core** (`src/`, plain Node, no Electron imports) and a **thin shell** (`main.js`, `preload.js`, `renderer/`) that wires the core to the OS. Almost every behaviour that matters can be — and is — tested without a window.

## The shell

- `main.js` owns the frameless translucent window (right-docked, `showInactive()`, focusable only once summoned), the tray, the double-Shift hook (`uiohook-napi` feeding `src/doubleShift.js`, with a fallback shortcut), single-instance lock, IPC handlers, and the DPAPI key store (`safeStorage`).
- `preload.js` exposes a minimal `window.dshift` bridge. The renderer has no Node access (`contextIsolation: true`).
- `renderer/` is a faithful port of the reference interface (see `../recon/UI_SPEC.md`): tab strip → context header → transcript → queue → usage bar → composer, with tool chips, task cards, and inline approval cards rendered from live events.

## Screen context pipeline

1. A background tracker (4 s cadence while the sidebar is hidden) keeps the **last external foreground window** fresh. The sidebar can never read itself: snapshots whose process is ours are discarded (audit blocker B1).
2. Reads go through a **persistent UIA host** (`native/uia-host.ps1`, spoken to by `src/uiaClient.js` over JSON-lines: one warm PowerShell, serialized requests, 2.5 s timeout, single restart, permanent fallback latch) with `native/uia-dump.ps1` as the one-shot fallback.
3. `src/contextEngine.js` serializes the tree under hard caps (3,000 nodes / 60,000 chars / depth 40), never emits password values, drops denylisted apps, diffs against the previous tree, and flags thin trees (`<200` chars or `<10` text nodes) as screenshot candidates.

## Agent loop

`src/agent.js` runs the tool loop (max 12 iterations, per-turn wall-clock budget 240 s): screen text is attached to the first turn automatically; tools are `read_screen` (≤3), `take_screenshot` (≤1), `search_memory`, `write_memory`, and `use_computer` (≤3), executed in parallel per block. Two transcripts are kept strictly apart — `display[]` for the UI and `messages[]` for the provider — and a tab whose turn fails rolls its transcript back; a crash mid-turn is repaired on load (`repairTranscript`).

`src/llm.js` streams Anthropic (with prompt caching on system + tools, thinking blocks preserved verbatim) and OpenAI-compatible endpoints (including local Ollama), with retry/backoff that never re-emits streamed text, and a 30 s stall watchdog.

## Money

Every request is priced by an editable table (`src/usage.js`) and charged to a daily ledger (`src/spend.js`). Sends pass a **reserve → wouldExceed → settle/release** gate so concurrent tabs can't slip past the cap together.

## Computer use

`src/codex.js` runs `codex exec --json --ephemeral --sandbox read-only` only after a per-task approval. Approvals are serialized through `src/approvalQueue.js` — one card at a time, always resolving (allow / deny / 120 s timeout / Stop) with the true reason written to a hash-chained audit log that stores task hashes, never task text. The child process environment is scrubbed of provider keys and generic secret-suffixed variables.

## Persistence

Chats, archive, and the spend ledger are written atomically (temp file → fsync → rename) with previous-payload `.bak` rotation and a latest-payload mirror, so corruption costs at most nothing-to-one-save and is always flagged (`recoveryInfo`, `recoveredFromBackup`) rather than silently zeroed. Memory files get versioned snapshots and undo on top of the same discipline.
