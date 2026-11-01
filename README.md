# D Shift — for Windows (the beat-him rebuild)

A screen-aware AI sidebar for **Windows**. Double-tap **Shift** anywhere, ask a question, and the model answers using what's on your screen plus a local memory of who you are.

This project started as a full reverse-engineering of [Kylejeong2/d-shift](https://github.com/Kylejeong2/d-shift) — a macOS-only Swift app — and rebuilds it natively for Windows, feature for feature, then goes past it. The complete recon is in [`recon/RECON_REPORT.md`](recon/RECON_REPORT.md) (every file, every constant, every weakness) and the docs research behind the Windows design is in [`recon/DOCS_RESEARCH.md`](recon/DOCS_RESEARCH.md).

## What you asked for — and where it lives

| Requirement | Implementation |
|---|---|
| Double-tap Shift anywhere to open | Low-level global key hook (`uiohook-napi`) feeding a hardened detector (tap <250 ms, two taps <400 ms, typing capitals / held Shift / other modifiers never trigger) — `app/src/doubleShift.js`. Fallback shortcut Ctrl+Shift+Space always on. |
| Floats over other apps, doesn't steal focus | Frameless transparent always-on-top window, shown with `showInactive()`; it's non-focusable in peek mode and only takes key focus when you click in to type — `app/main.js` |
| Translucent, lightweight | Acrylic-style backdrop blur, one small window, no bundled model, no database |
| Esc closes | Global Esc registration while visible; closing the last tab also hides it |
| Answers from your screen, accessibility first | Windows **UI Automation** tree of the foreground window via `app/native/uia-dump.ps1` (3,000 nodes / 60k chars caps, focused element marked, selected text included). Screenshot only when the tree is thin/missing or the model asks — max 1 per question |
| Local memory in plain markdown, easy to open/edit | `~/DShift/memory/` — `me.md`, `notes.md`, `people/`, `projects/` — plus an in-app editor, a tray "Open Memory Folder" item, and Settings showing the exact path |
| Multiple chat tabs | Ctrl+T / + button, Ctrl+W closes; **tabs, messages and usage persist across restarts** |
| Token & cost stats | Per-tab bar: context %, input/output tokens, cache hit rate, estimated $ cost, screen reads, screenshots |
| Menu-bar app for settings | On Windows that's the **system tray** app: Show/Hide, New Tab, Open Memory Folder, Change API Key, provider switch, Quit |
| Codex computer-use handoff, approval only | Per-task approval card, 2-minute expiry, **no "always allow" mode**, read-only sandbox, full audit log — `app/src/codex.js` |

> One honest boundary: Codex *Computer Use* itself lives in the ChatGPT desktop app, not the CLI (see recon/DOCS_RESEARCH.md §3.4). D Shift hands approved tasks to the real `codex exec` agent; it does not fake a Computer Use integration.

## How it beats the original

See [`BEAT_SHEET.md`](BEAT_SHEET.md) — 15 concrete wins, each tied to a weakness found in the original's code, including: Windows + cross-platform instead of macOS-only, persistent tabs, a model picker (Claude / OpenAI / local Ollama) instead of a compile-time Claude lock, password-field redaction and a per-app no-read list, memory write audit + **undo**, ranked memory search instead of grep-only, parallel tool execution, transient-error retry instead of full-turn rollback, editable price table + daily budget cap, and launch-at-login.

## Run it (Windows)

```powershell
cd app
npm install
npm start
```

1. On first run a tray icon appears. Double-tap **Shift** (or Ctrl+Shift+Space) to open the sidebar.
2. Open ⚙️ Settings, paste your Anthropic (or OpenAI) key, Save. The key is stored **encrypted with Windows DPAPI** (`safeStorage`) — never in plain text. Or set `ANTHROPIC_API_KEY` in the environment / `.env`.
3. No key? Switch the provider to **Ollama** in the tray menu and run a local model — free, fully offline for chat (screen text still stays on your machine in that mode).

### Build the installer

```powershell
npm run dist:win          # NSIS installer into app/dist/
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
npm test    # 18 tests: detector, memory, context engine, usage/cost,
            # shell policy, tab persistence, Codex approval gate, agent loop
npm run check
```

Verified in this repo: all syntax checks pass, **18/18 tests pass**, the Electron app boots and seeds its data folder, and the full agent loop (screen → tools → memory → answer, screenshot cap, rollback on failure) is exercised end-to-end with a scripted model. The UIA PowerShell script and the Windows packaging run on Windows — they are syntax-reviewed and follow the patterns in `recon/DOCS_RESEARCH.md` §2, but a physical Windows pass (focus-steal click test, UIA wake matrix) is the honest remaining verification item.

## Layout

```
app/
├── main.js            window, tray, global hook, IPC, key store
├── preload.js         sandboxed bridge (contextIsolation, no node in renderer)
├── renderer/          sidebar UI: tabs, transcript, usage bar, settings, memory editor, approval card
├── src/               pure, tested core: doubleShift · contextEngine · memory ·
│                      chatStore · usage · agent · llm · codex · shellPolicy · settings
├── native/uia-dump.ps1  Windows UI Automation reader
└── tests/
recon/                 RECON_REPORT.md (84 KB, file-by-file) · DOCS_RESEARCH.md · original/
```
