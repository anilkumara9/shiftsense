# AUDIT V1 — D Shift (Windows/Electron) production-readiness audit

**Standard applied:** "this must NOT be a demo." Every finding below is a concrete failure scenario for a real Windows user running the app for real — not style, not preference.

**Scope:** `app/main.js`, `app/preload.js`, `app/renderer/{index.html,renderer.js,style.css}`, `app/src/*.js`, `app/native/uia-dump.ps1`, `app/package.json`, `app/tests/*.js`.

**State note (important):** the app was being modified by a parallel fix lane *during* this audit. This report audits the on-disk state as of 2026-11-01 ~17:03 UTC — commit `61d49e1` plus uncommitted fixes (`src/spend.js` and `tests/audit.test.js` added; `main.js`, `renderer.js`, `src/chatStore.js`, `src/llm.js` modified). Findings that the fix lane already repaired are **not** listed as open; they are credited in §4 so they are not double-fixed. Line numbers cite the current on-disk files.

**Verdict:** 2 blockers, 11 majors, ~15 minors. The two blockers break the product's core loop — *read the app I'm looking at* and *approve a computer task* — in ordinary use. As it stands this is a well-structured prototype with a real core, **not yet a production app**.

---

## 1. BLOCKERS

### B1. Screen context reads D Shift's own window, not the app the user is asking about
- **Where:** `main.js` `runUIA()` / `getContext()` (reads `GetForegroundWindow()` via `native/uia-dump.ps1:24`); `main.js:60-64` `showSidebar()`; no code anywhere tracks the last non-D-Shift foreground window (verified by grep — no HWND/pid exclusion exists).
- **Scenario:** Double-tap Shift → sidebar appears without activation (correct). The renderer never focuses the input on show (`sidebar:shown` is sent at `main.js:62` but has **no listener** in `renderer.js`; there is no `.focus()` call anywhere), so the user's first act is to **click into the textarea — which makes D Shift the foreground window**. They type, press Enter. `runTurn` calls `getContext(false)`; the 1.5 s cache from show-time has expired while typing, so a fresh UIA walk runs against `GetForegroundWindow()` = **D Shift's own Electron window**. `read_screen` (force) has the same problem, guaranteed. The model then answers questions about the sidebar's own UI (its buttons, the question text itself) instead of the user's app. The new header (`ctx:update`, read at show time when the answer was still correct) actively masks the bug by displaying the right app name.
- **Why it's a blocker:** the flagship feature — "answers from your screen" — silently reads the wrong window in the primary interaction path. It demos well only if the question is sent within ~1.5 s of opening.
- **Fix:** track the last foreground HWND whose pid ≠ D Shift's pid (poll on an interval and/or hook `EVENT_SYSTEM_FOREGROUND` via a small native helper / the persistent PowerShell host), pass that HWND into `uia-dump.ps1` as a parameter instead of `GetForegroundWindow()`, and exclude the app's own pid in the serializer as a belt-and-braces check.

### B2. Codex approval can deadlock the turn forever — guaranteed with ≥2 computer calls in one model reply
- **Where:** `src/agent.js:63` (tools executed via `Promise.all`), `src/agent.js` `CAPS.use_computer = 3`; `main.js:187` (`await new Promise(res => pendingApprovals.set(...))` — no timeout, not tied to the AbortController); `renderer.js` `codex:approval` handler (single modal, `curApproval` overwritten by each new request); `main.js` `chat:stop` (aborts only the LLM fetch).
- **Scenario A (guaranteed):** the model emits two `use_computer` calls in one block — explicitly permitted by the design (cap 3, parallel execution). Two `codex:approval` events fire back-to-back; the renderer shows only the *second* card (the first `approvalId` is overwritten and can never be answered). The user approves #2; #1's promise never resolves; `Promise.all` never settles; the `chat:send` invoke never returns; the tab is dead until app restart.
- **Scenario B:** one approval card is open and the user presses **Stop** (or hides the sidebar, or just walks away). Stop aborts the fetch — but the turn isn't in a fetch, it's parked on the approval promise. Nothing ever resolves it. Same permanent hang.
- **Fix:** serialize approval-gated tools (run `use_computer` calls sequentially, never inside the parallel batch); add a hard timeout + abort linkage to the decision promise in `main.js` (Stop and sidebar-hide must resolve pending approvals as denied); queue approval cards in the renderer instead of overwriting.

---

## 2. MAJORS

### M1. Provider/model mismatch: switching provider breaks every existing tab
- **Where:** `main.js` `callLLM()` (model = `tab.model || settings.model`); `main.js:220-222` (tray provider switch changes only `settings.provider`); `src/chatStore.js` `newTab()` (model defaults to `settings.model` = `claude-sonnet-5-5` regardless of provider); `renderer.js` `MODELS` (one mixed list offered for all providers).
- **Scenario:** user switches Anthropic → OpenAI in the tray (a headline feature). Every existing tab still carries `claude-sonnet-5-5`, which is now sent to the OpenAI API → `404 model not found` on every send. Reverse direction sends `gpt-5` to Anthropic → 400. Ollama + a fresh tab sends `claude-sonnet-5-5` to localhost → "model not found". There is no validation or remapping anywhere.
- **Fix:** make model lists per-provider; on provider switch, remap tab models (or store provider+model per tab and validate the pair in `callLLM`).

### M2. A kill/crash during tool execution permanently bricks the tab (dangling `tool_use` persisted)
- **Where:** `main.js` `onUsage` → `store.save()` fires after each LLM iteration — i.e. *after* the assistant `tool_use` message is appended (`src/agent.js:60`) but *before* tool results exist (`src/agent.js:86`); `src/chatStore.js` `load()` migrates display entries and strips images but performs **no dangling-tool_use repair**; `src/agent.js:91` rollback only runs if the process lives to catch the error.
- **Scenario:** model calls `use_computer`; usage is recorded and the transcript (ending in an unmatched `tool_use`) is written to `chats.json`; the Codex run takes minutes; the user quits from the tray / the app crashes / the laptop sleeps hard. On relaunch the tab is restored with the dangling `tool_use`. Every subsequent Anthropic request in that tab returns `400 … tool_use ids were found without tool_result` — forever. (The macOS original had `repairDanglingToolUses` for exactly this; the port dropped it.) Only escape is `/clear`, losing the history the persistence feature exists to keep.
- **Fix:** on `load()`, truncate/repair any transcript whose last assistant message contains `tool_use` without a following `tool_result` (synthesize error results or drop the incomplete turn); don't persist mid-turn state, or persist it flagged `inFlight` and roll back on load.

### M3. UIA PowerShell path is fragile in four compounding ways
- **Where:** `native/uia-dump.ps1:13` (`$ErrorActionPreference='Stop'`) with unguarded `$el.Current` reads in `Convert-El` (~line 36); `ps1:14-16` + C# `Add-Type` compiled on **every** invocation; `main.js:97` (`timeout: 4000`, `maxBuffer: 8MB`); `ps1:69` (`ConvertTo-Json -Depth 64`) vs walk depth 40 (`ps1:12`).
- **Scenarios:**
  1. Real apps (browsers, Office) mutate their trees constantly; one element going stale mid-walk throws `ElementNotAvailableException`, `Stop` kills the whole script, stdout is empty → context = null → "no accessibility text". No per-element try/catch except for focus/selection.
  2. Every read cold-spawns PowerShell + compiles the C# type (~1–3 s on a modest machine) against a 4 s hard timeout — on slower/loaded machines reads intermittently time out and context silently vanishes. The docs research for this project explicitly recommended a persistent PowerShell host; the implementation spawns per read.
  3. JSON nesting costs ~2 depth levels per tree level, so `-Depth 64` truncates real trees at ~31 levels (deep web apps) — deeper content is silently replaced/dropped by `ConvertTo-Json`.
  4. `ValuePattern` values are uncapped in the script (the 500-char cap lives in the JS serializer, after transfer); text-heavy windows can exceed the 8 MB `maxBuffer` → child killed → null context.
- **Fix:** persistent PowerShell host process with line-delimited JSON; per-element try/catch (skip dead elements); `-Depth` raised to ≥100 or streaming JSON; cap values in-script; raise/align the timeout.

### M4. Esc is hijacked system-wide while the sidebar is visible
- **Where:** `main.js:69` (`globalShortcut.register('Escape', …)`), unregistered only on hide; the `register()` return value is never checked.
- **Scenario:** the sidebar is designed to float while the user works in another app. With it visible, pressing Esc to dismiss a menu/dialog/autocomplete in Excel, VS Code, a browser, a game — does nothing there; it hides D Shift instead, because the global shortcut consumes the key before the foreground app sees it. The macOS original used a *local* event monitor for this reason. If registration fails (returns `false`, not a throw — the try/catch doesn't catch that), Esc silently stops closing the sidebar with no signal.
- **Fix:** consume Esc via a low-level keyboard hook that only swallows it when D Shift is the intended target (and passes it through otherwise), or accept focus-based Esc handling in the renderer plus hook-based detection; check `register()`'s boolean and surface failure.

### M5. Screenshot captures the largest window, not the user's app
- **Where:** `main.js:115-118` (`takeScreenshot` sorts all window sources by thumbnail width, excluding only the name "D Shift").
- **Scenario:** user is working in a small Notepad/terminal window in front of a maximized browser. They ask about the small window; accessibility is thin; the screenshot tool fires and captures the **browser** — wrong content for the answer, and the wrong app's pixels (potentially private) are sent to the cloud API. Minimized/background windows can also win the size sort with stale thumbnails.
- **Fix:** capture the tracked foreground window (same fix as B1 — match by the target app's window title/pid), falling back to largest only if the target can't be captured.

### M6. "Change API Key" can silently have no effect — env/.env always wins
- **Where:** `src/settings.js` `envKey()` (env var → `./.env` in `process.cwd()` → `~/.config/dshift/.env`, all taking precedence over the stored key); `main.js:126` `getApiKey()` (env checked first, on every call).
- **Scenario:** the target user for this app very likely has `ANTHROPIC_API_KEY` exported (or an old `.env` lying in whatever directory the packaged app inherits as cwd). They paste a new key in Settings, get "saved", and the app keeps using the old/revoked key — errors persist or usage keeps billing the old account, with zero indication. The in-app key store becomes a placebo for exactly the users most likely to install this.
- **Fix:** prefer the in-app (DPAPI) key when one is set, or detect the conflict and tell the user which source is active (Settings already computes `hasAnthropicKey`; show the *source*, not just presence).

### M7. Thinking blocks are dropped, so tool turns can 400 when effort is raised
- **Where:** `src/llm.js` `anthropicStream()` (parses only text/tool_use deltas; `thinking` blocks and their signatures are discarded); `src/agent.js:57-59` (assistant content rebuilt from text + tool_use only); `src/llm.js:25` (`output_config: { effort }` sent whenever effort ≠ low — a setting the Settings UI offers).
- **Scenario:** user sets Effort = medium/high in Settings (the UI invites it). With thinking enabled, the API requires thinking blocks to be passed back *unchanged* with tool use; the loop strips them, and the follow-up request in the same turn is rejected. The feature combination the UI offers (effort + tools) is the one that breaks.
- **Fix:** capture thinking blocks verbatim (including `signature`) in the stream parser and re-emit them in the assistant content, or refuse effort>low for tool-enabled turns.

### M8. Streaming text vanishes mid-turn; stream events ignore which tab they belong to
- **Where:** `main.js` `onUsage` sends `state:patch` after **every** LLM iteration; `renderer.js` `render()` rebuilds the transcript via `innerHTML=''`; `renderer.js:65-67` `chat:delta` appends to `streamEl` without checking `tabId`.
- **Scenario:** any multi-step (tool) turn: iteration 1 streams visibly, then `onUsage` → `state:patch` → full re-render destroys the streaming element; iteration 2's deltas append to the detached node — the user stares at a transcript with no answer until the turn ends and a final refresh restores it. If the user switches tabs mid-stream, deltas from the background tab are drawn into the tab they're looking at.
- **Fix:** don't re-render the transcript on usage patches (patch the usage bar only); key streaming state by tabId and ignore deltas for non-active tabs.

### M9. No bound on transcript growth — long-term use degrades into 400s and jank
- **Where:** `src/agent.js:54` (every turn permanently appends the full screen snapshot — up to 60k chars — plus `me.md` to the API transcript; nothing is ever trimmed or compacted); `src/chatStore.js` `save()` (full `JSON.stringify` + file rewrite on *every* `addDisplay` and *every* `onUsage`, synchronously, on the main process).
- **Scenario:** weeks of real use: the tab's request payload grows until Anthropic returns `400 prompt is too long`; before that, each save rewrites an ever-larger `chats.json` (containing every historical screen dump in full) several times per turn, on the UI's main thread. The tab dies slowly and then suddenly, with `/clear` (total history loss) as the only remedy.
- **Fix:** window the API transcript (keep the last N turns verbatim; replace older screen blocks with a placeholder), strip screen text from the *persisted* copy the way images already are, and debounce/coalesce saves.

### M10. Codex installed the standard way (npm) cannot be spawned on Windows
- **Where:** `src/codex.js:68` (`execFile` for `--version`), `src/codex.js:93` (`spawn`), neither passes `shell: true`; `candidatePaths()` includes `%APPDATA%\Roaming\npm\codex.cmd`.
- **Scenario:** the documented install route (`npm i -g @openai/codex`) produces a **`codex.cmd` shim**. Since the Node CVE-2024-27980 fix (Node ≥ 20.12, and Electron 33's Node), spawning a `.cmd`/`.bat` without a shell throws `EINVAL` — detection reports "not installed" (or approve fails) even though Codex is installed and works in the user's terminal. The hard-coded exe path (`C:\Program Files\OpenAI\Codex\codex.exe`) doesn't match where the Windows app actually installs (`%LOCALAPPDATA%\Programs\…` / WindowsApps), so that fallback rarely saves it.
- **Fix:** resolve the real executable (`codex.exe` under the npm package's vendor dir or the app's install path), or spawn `.cmd` via `cmd.exe /c` with argument escaping reviewed; add the actual Windows install locations to discovery.

### M11. The core gesture has a silent single point of failure (native hook)
- **Where:** `package.json` (`uiohook-napi` under `optionalDependencies`); `main.js` `startShiftHook()` (failure path is a single `console.warn`).
- **Scenario:** if the native module is missing/mismatched at runtime (electron-builder pruning of optional deps, ARM64 Windows prebuild gap, missing VC++ runtime), double-tap Shift — the product's front door — simply doesn't exist, and a packaged app has no visible console: the user sees an app that never opens, with only an undocumented Ctrl+Shift+Space fallback. Nothing in the UI ever states whether the hook is alive.
- **Fix:** surface hook health in the tray tooltip/settings ("Double-Shift: active / FAILED — use Ctrl+Shift+Space"), add a startup self-check, and treat the native module as a hard dependency in packaging with an install-time verification.

---

## 3. MINORS

| # | Finding | Where |
|---|---|---|
| m1 | Tray icon leaks on every provider switch: `createTray()` builds a new `Tray` without `tray.destroy()` on the old one → accumulating ghost icons (a classic Windows tell of an unfinished Electron app). | `main.js:207-222` |
| m2 | Single-instance failure path still runs setup: on lock failure `app.quit()` is called but module init (stores, Codex dir, `whenReady` → window/tray/hooks) proceeds; two processes also share the same `chats.json.tmp` / `settings.json.tmp` names → save races can corrupt both files. | `main.js:39`; `src/chatStore.js` `save()`; `src/settings.js` `saveSettings()` |
| m3 | The message queue is renderer-local fiction: `ChatStore.enqueue/dequeue` are **dead code** (no callers); the renderer keeps its own queue in its state copy — queued messages are lost on restart and stranded when the user switches tabs mid-drain (`renderer.js:55` reads whichever tab is active). | `renderer.js:49,55`; `src/chatStore.js` |
| m4 | `sidebar:shown` is sent but never consumed; the textarea is never focused when the sidebar opens (also a contributing cause of B1's click-to-type). | `main.js:62`; `renderer.js` (no listener) |
| m5 | `ChatStore.get(id)` silently falls back to `tabs[0]` for a stale/unknown id — a send racing a tab close lands in the wrong conversation without any error. | `src/chatStore.js` `get()` |
| m6 | Anthropic retry after a partial stream re-emits text from the start → the UI shows a duplicated prefix while the saved answer differs; mid-stream SSE `error` events are ignored entirely, so a truncated/overloaded response is presented as a complete answer. | `src/llm.js` `anthropicStream()` |
| m7 | Codex `stop()` and the 10-minute timeout kill only the direct child, not the process tree (the original did tree-kill); a detached Codex grandchild can outlive "Stop". `detect()` also contains a dead no-op loop (leftover expression that does nothing) — untested code in the discovery path. | `src/codex.js` `stop()`, `approve()`, `detect()` |
| m8 | The per-app denylist — a headline privacy feature — has **no UI and no IPC path**; it can only be changed by hand-editing `settings.json`. Conversely `settings:save` merges an arbitrary, unvalidated patch object from the renderer. | `main.js` `settings:save`; `renderer/index.html` (no denylist control) |
| m9 | `launchAtLogin` has no UI toggle and is only applied during startup; it is never actively unset through the app (a stale login entry survives if the setting is later removed by hand). In dev/portable runs `setLoginItemSettings` registers the Electron binary path, not the product. | `main.js:233`; settings schema |
| m10 | `priceOverrides` are captured once when `ChatStore` is constructed; later settings changes never reach existing tabs' cost math. | `main.js` (store construction); `src/chatStore.js` |
| m11 | Spend ledger day boundary is UTC (`toISOString`), so the "daily" cap resets at 05:30 for the IST user / local-midnight-mismatched everywhere outside UTC. | `src/spend.js` `today()` |
| m12 | Memory safety net grows unbounded: `.versions/` snapshots the *entire* previous file on every write (append-heavy `notes.md` → quadratic disk growth over months); `write()` silently treats any mode ≠ `replace` as append; `undoLastWrite()` matches snapshots by sanitized suffix, so `people/a-b.md` and a literal `people/a__b.md` collide. | `src/memory.js` `write()`, `undoLastWrite()` |
| m13 | Node's `fetch` in the main process ignores the Windows system proxy → on corporate networks where browsers work via proxy, every API call fails with network errors. | `src/llm.js` (both streams) |
| m14 | IPC handlers perform no sender/frame validation, and preload's `on()` allows subscribing to arbitrary channels. Low risk today (only local page loads, CSP `default-src 'self'`, all model output rendered via `textContent` — verified, no `innerHTML` injection path), but it's one future feature (any remote content/link) away from mattering; there are likewise no `setWindowOpenHandler`/`will-navigate` guards. | `preload.js:21`; `main.js` `wireIPC()` |
| m15 | Installer is unsigned and there's no auto-update: SmartScreen warnings on first install for every real user — the exact distribution friction the recon criticised in the original. | `package.json` `build` |
| m16 | History log under-records multi-step turns: `logHistory` for the assistant stores only the final segment's `res.text`, so `history/*.jsonl` silently omits intermediate answer text the user saw. | `main.js` `chat:send` |

## 4. What the fix lane already repaired (verified in current code — do not double-fix)

- **Transcript split:** UI entries (`display`) and API messages (`messages`) are now separate arrays with a v1 migration — the v1 app would indeed have posted `{role, text}` objects to the Messages API and been 400-rejected on the first real send; that specific blocker is **fixed and regression-tested** (`tests/audit.test.js`).
- **OpenAI/Ollama tools:** a real translation layer (`toOpenAIMessages`/`toOpenAITools`) plus streamed `tool_calls` parsing — v1 silently ran tool-less there; now covered by tests.
- **Budget cap:** `SpendLedger` actually enforces `budgetUSDPerDay` in `chat:send` and per-iteration in `callLLM` (see m11 for the UTC nit).
- **Screenshot persistence:** base64 images are stripped from the on-disk transcript (`stripImages`) — but screen *text* still persists in full (see M9).
- **Context header + me.md guard:** `ctx:update` is wired to the header (incl. "(no-read list)"), and the me.md size guard is surfaced in the memory drawer.

## 5. Coverage gap (why these shipped)

23/23 tests pass, but they are all unit tests below the integration line: **no test loads `main.js` or Electron, none exercises the IPC approval round-trip, the tray, the Esc/shortcut wiring, or `uia-dump.ps1`, and none validates a request against a strict Anthropic/OpenAI-shaped schema validator.** The v1 mixed-transcript bug — the kind that makes an app "work in tests, fail on first real send" — is now regression-tested at the store layer, but the same class of bug remains fully possible at every layer above it (B1, B2, M10 all live exactly there).

## 6. Unverified risks (not counted as findings)

- **Model IDs & prices** (`claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-5-5`, `gpt-5`, … in `renderer.js`/`src/usage.js`) come from the project's same-day docs research and were **not re-verified against the live Models API in this audit**; if any ID is wrong, that model's every request 404s. The header comment in `usage.js` itself flags this.
- **`output_config.effort`** acceptance varies by model (e.g. Haiku-class) — unverified against the live API; worst case compounds M7.
- **Ollama's** tolerance of `stream_options: { include_usage: true }` on its OpenAI-compatible endpoint is assumed, not verified.
