# Beat sheet — original D-Shift (macOS/Swift) vs this build (Windows)

Every row is grounded in the recon report (`recon/RECON_REPORT.md` §7) — a weakness found in *his* code, and what this build does instead.

| # | Original | This build |
|---|---|---|
| 1 | macOS-only, end to end; no platform abstraction (recon §7.1) | Windows-native (UIA, tray, DPAPI) on Electron — also runs on macOS/Linux; platform pieces isolated in `main.js` + `native/` |
| 2 | Ad-hoc signed, unnotarized; no auto-update, no launch-at-login (§7.1) | NSIS installer + portable exe via electron-builder; launch-at-login shipped (tray setting → `setLoginItemSettings`) |
| 3 | No OCR; canvas apps get one blind screenshot (§7.2) | Thin-tree detection (<200 chars or <10 text nodes) flags canvas/image apps explicitly; screenshot becomes a deliberate, visible fallback |
| 4 | Secure-field values can leak via AX (§7.2) | `IsPassword` checked in the UIA walker — values are never read; serializer prints "(password — value hidden)" (tested) |
| 5 | No per-app privacy controls (§7.7) | No-read denylist: password managers by default, user-editable; denied apps return zero context |
| 6 | Snapshot resent up to 60k chars every read (§7.2) | Snapshot hashing: unchanged screen returns "unchanged since last read" instead of the full tree |
| 7 | Model locked at compile time (`claude-opus-5-5`, effort low); README tells you to edit source (§7.3) | Per-tab model picker + provider switch (Anthropic / OpenAI / Ollama-local), effort selectable in Settings |
| 8 | Prices hardcoded, silently rot; usage resets on quit (§7.3) | Editable price table with overrides, usage persisted per tab, daily budget cap setting |
| 9 | Memory search = literal grep only (§7.4) | Ranked in-process search (term frequency + filename boost) — no shell spawned at all for model searches |
| 10 | Silent memory writes: no log, no undo — a prompt-injection sink (§7.4) | Every write audited (`.audit.jsonl`), previous content snapshotted, one-click **Undo** in the memory editor, audit visible in-app |
| 11 | `me.md` sent unbounded every turn (§7.4) | 8,000-char guard surfaced in the memory overview |
| 12 | Tools run sequentially; one SSE failure rolls back the whole turn (§7.5) | Independent tools run in parallel; transient HTTP errors get one retry with backoff before rollback |
| 13 | Codex "auto mode" boolean disables approvals indefinitely; no audit (§7.5, §7.7) | Approval is per-task, expires in 2 minutes, can never be remembered; every request/approval/denial/run is in `codex/audit.jsonl` |
| 14 | `OPENAI_API_KEY` leaked into the Codex subprocess env (§7.7) | Subprocess env strips **all** provider keys and `*_TOKEN` vars (tested) |
| 15 | Tabs die on restart; usage session-only; no rename/export (§7.6) | Tabs, messages, queue and usage persist to `chats.json` and restore on launch |
| 16 | Codex path trusted without validation; stderr tail 800 chars (§7.5) | Discovery runs `--version` to validate; stderr kept at 8,000 chars |

**Kept from the original, deliberately** (credit where due): the double-Shift timings (250 ms / 400 ms), the 3,000-node / 60k-char context caps, 1 screenshot and 3 `read_screen` / 3 Codex calls per question, the 12-iteration agent loop with transcript rollback, the read-only shell policy (ported + widened, §src/shellPolicy.js), markdown memory layout, and "closing the last tab hides the sidebar."
