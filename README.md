# D Shift — for Windows (the beat-him rebuild)

A screen-aware AI sidebar for **Windows**. Double-tap **Shift** anywhere, ask a question, and the model answers using what's on your screen plus a local memory of who you are.

This project started as a full reverse-engineering of [Kylejeong2/d-shift](https://github.com/Kylejeong2/d-shift) — a macOS-only Swift app — and rebuilds it natively for Windows, feature for feature, then goes past it. The complete recon is in [`recon/RECON_REPORT.md`](recon/RECON_REPORT.md) (every file, every constant, every weakness) and the docs research behind the Windows design is in [`recon/DOCS_RESEARCH.md`](recon/DOCS_RESEARCH.md).

## What you asked for — and where it lives

| Requirement | Implementation |
|---|---|
| Double-tap Shift anywhere to open | Low-level global key hook (`uiohook-napi`) feeding a hardened detector (tap <250 ms, two taps <400 ms, typing capitals / held Shift / other modifiers never trigger) — `src/doubleShift.js`. Fallback shortcut Ctrl+Shift+Space always on. |
| Floats over other apps, doesn't steal focus | Frameless transparent always-on-top window, shown with `showInactive()`; it's non-focusable in peek mode and only takes key focus when you click in to type — `main.js` |
| Translucent, lightweight | Acrylic-style backdrop blur, one small window, no bundled model, no database |
| Esc closes | Global Esc registration while visible; closing the last tab also hides it |
| Answers from your screen, accessibility first | Windows **UI Automation** tree of the foreground window via `native/uia-dump.ps1` (3,000 nodes / 60k chars caps, focused element marked, selected text included). Screenshot only when the tree is thin/missing or the model asks — max 1 per question |
| Local memory in plain markdown, easy to open/edit | `~/DShift/memory/` — `me.md`, `notes.md`, `people/`, `projects/` — plus an in-app editor, a tray "Open Memory Folder" item, and Settings showing the exact path |
| Multiple chat tabs | Ctrl+T / + button, Ctrl+W closes; **tabs, messages and usage persist across restarts** |
| Token & cost stats | Per-tab bar: context %, input/output tokens, cache hit rate, estimated $ cost, screen reads, screenshots |
| Menu-bar app for settings | On Windows that's the **system tray** app: Show/Hide, New Tab, Open Memory Folder, Change API Key, provider switch, Quit |
| Codex computer-use handoff, approval only | Per-task approval card, 2-minute expiry, **no "always allow" mode**, read-only sandbox, full audit log — `src/codex.js` |

> One honest boundary: Codex *Computer Use* itself lives in the ChatGPT desktop app, not the CLI (see recon/DOCS_RESEARCH.md §3.4). D Shift hands approved tasks to the real `codex exec` agent; it does not fake a Computer Use integration.

## UI parity (v3)

The sidebar UI is a faithful port of his SwiftUI interface — same Theme tokens (surface radius 12, inner 8, black-40% surfaces, white-10% strokes, blue user bubble, 400pt panel), same layout order (tab strip → app header → transcript → queue → usage bar → composer), same components (pixel-grid Thinking row with shimmer, tool chips and groups, Codex task cards with status pills, inline approval cards, exact usage-bar format, queue rows, slash-command menu, history popover, feedback composer, API-key setup screen, text zoom) and the same shortcuts (with Ctrl in place of Cmd). On top of that parity, our additions wear the same visual language: a per-tab model picker in the header, memory and settings buttons in the tab strip, and budget/hook-health details in the usage-bar tooltip and Settings. His AutoMode hint line is present too — but session-only in ours (see `BEAT_SHEET.md` for why his persistent version is a liability, not a feature).

## How it beats the original

See [`BEAT_SHEET.md`](BEAT_SHEET.md) — 15 concrete wins, each tied to a weakness found in the original's code, including: Windows + cross-platform instead of macOS-only, persistent tabs, a model picker (Claude / OpenAI / local Ollama) instead of a compile-time Claude lock, password-field redaction and a per-app no-read list, memory write audit + **undo**, ranked memory search instead of grep-only, parallel tool execution, transient-error retry instead of full-turn rollback, editable price table + daily budget cap, and launch-at-login.

## Run it (Windows)

```powershell
npm install
npm start
```

1. On first run a tray icon appears. Double-tap **Shift** (or Ctrl+Shift+Space) to open the sidebar.
2. Open ⚙️ Settings, paste your Anthropic (or OpenAI) key, Save. The key is stored **encrypted with Windows DPAPI** (`safeStorage`) — never in plain text. Or set `ANTHROPIC_API_KEY` in the environment / `.env`.
3. No key? Switch the provider to **Ollama** in the tray menu and run a local model — free, fully offline for chat (screen text still stays on your machine in that mode).

### Build the installer

```powershell
npm run dist:win          # NSIS installer into dist/
npm run dist:win:portable # single portable .exe
```

## Where your data lives

```
~/DShift/
├── memory/     me.md · notes.md · people/ · projects/   (+ .audit.jsonl, .versions/ for undo)
├── history/    YYYY-MM-DD.jsonl  (append-only chat log, for you — never sent back to the model)
├── chats.json  your tabs, restored on launch
├── settings.json (API keys only as DPAPI ciphertext)
└── codex/      audit.jsonl + last-run-stderr.log
```

Override with the `DSHIFT_DATA_DIR` environment variable. Nothing here is ever committed — see `.gitignore`.

## Privacy

- Memory and history never leave your machine.
- Screen context is sent to the model provider only when you ask a question (the accessibility text, or one screenshot if needed) along with `me.md` + the memory file list.
- Password fields are never read. Apps on the no-read list (1Password, KeePass, Bitwarden, LastPass, Dashlane by default — edit in settings) are never read at all.
- Every memory write by the model is logged and undoable. Every Codex task needs your click, and the Codex subprocess gets **none** of your API keys in its environment.

## Tests

```powershell
npm test    # 99 tests: detector, memory, context engine, usage/cost, shell
            # policy, tab persistence, Codex approvals, agent loop, both audit
            # regression suites, plus team suites — UIA host protocol,
            # security, reliability, AI engine, end-to-end chaos (tests/e2e)
npm run check
```

**Production audits:** this app has been through two adversarial audits of its own — the second one independent (`recon/AUDIT_V1.md`: 2 blockers, 11 majors, ~15 minors, all addressed in v2). The blockers were real: screen context could read the sidebar's own window (fixed with last-external-window tracking), and parallel Codex approvals could deadlock a tab (fixed with a serialized approval queue that always resolves).

**Team build (v1.4.0):** six specialist engineers then hardened it in parallel lanes, each proven by tests: a *persistent UIA host* (screen reads no longer spawn a cold PowerShell each time; the one-shot script remains as fallback), a *security pass* (19 fixes incl. a dangling-symlink write escape, Codex discovery that can no longer be planted via the launch folder, `.cmd`-shim task injection refused, hash-chained tamper-evident audit trails, settings validation), a *reliability pass* (atomic writes, backup + mirror recovery for chats and budget, a 2³¹-token usage-overflow bug fixed), an *AI engine pass* (Anthropic prompt caching, retry/backoff that never double-streams, a 30 s stream watchdog, a per-turn wall-clock budget), a *platform pass* (asar-safe packaging — native scripts unpacked so PowerShell can read them, packaged-file whitelist, generated multi-size icons, a preflight gate that fails builds loudly), and a *QA chaos suite* wiring the real modules together end-to-end.

Verified here: all syntax checks pass, **99/99 tests pass**, preflight passes, the Electron app boots and seeds its data folder, and a Linux package assembly was inspected (whitelist-exact contents, packaged binary boots). Still honestly unverified without a physical Windows machine: the UIA walk against real apps, the native double-Shift hook, focus behaviour, and the actual NSIS build — the Day-1 checklist is in `recon/DOCS_RESEARCH.md` §6. Known remaining limitations: provider calls don't honour HTTP proxy env vars, and the installer is unsigned until a code-signing certificate exists.

## Repository layout

```
├── main.js              Electron main: window, tray, global double-Shift hook, IPC, DPAPI key store
├── preload.js           sandboxed bridge (contextIsolation, no Node in the renderer)
├── src/                 the tested core (14 modules)
│   ├── doubleShift.js     hardened double-tap detector (state machine)
│   ├── contextEngine.js   UIA tree serializer: caps, password redaction, denylist, tree diffing
│   ├── uiaClient.js       persistent UIA host client (warm PowerShell, restart, timeout)
│   ├── memory.js          markdown memory: ranked search, write audit (hash-chained), undo
│   ├── chatStore.js       tabs: display/API transcript split, archive, atomic + backup + mirror saves
│   ├── usage.js · spend.js  token/cache/cost stats · race-safe daily budget ledger
│   ├── agent.js           tool loop: caps, parallel tools, rollback, per-turn wall-clock budget
│   ├── llm.js             Anthropic + OpenAI streaming: prompt caching, retry, stall watchdog
│   ├── codex.js           approval-gated Codex handoff (audit-chained, env-scrubbed)
│   ├── approvalQueue.js   serialized approvals — every request resolves, none can deadlock
│   ├── settings.js        validated settings + .env discovery
│   └── shellPolicy.js     read-only shell allowlist (defence in depth)
├── native/              uia-host.ps1 (persistent reader) · uia-dump.ps1 (one-shot fallback)
├── renderer/            the sidebar UI — a faithful port of the original's interface (see recon/UI_SPEC.md)
├── tests/               99 tests: unit, both audit regression suites, security, reliability,
│                        AI engine, UIA protocol, and the end-to-end chaos suite
├── scripts/             preflight.js (build gate) · make-icon.js (icon generator)
├── build/               generated app icons (icon.png / icon.ico)
└── recon/               RECON_REPORT.md (file-by-file teardown of the original) · DOCS_RESEARCH.md
                         UI_SPEC.md · AUDIT_V1.md · UI_PARITY_SHOT.png
```
