# D-Shift — Exhaustive Reverse-Engineering Report

> **Target:** `github.com/Kylejeong2/d-shift` (cloned, read-only, at `recon/original/`)
> **Snapshot analysed:** `main @ 85a6cbe` ("fix(context): ignore apps that take focus with only floating widgets"), tags `v0.1.0`, `v0.2.0`; `[Unreleased]` work in tree
> **Scope read:** every file — 37 Swift files under `Sources/DShift/` (7,451 LOC), 10 test files (397 LOC), `scripts/make-icon.swift` (38 LOC; 7,897 Swift LOC total), all `docs/`, `README.md`, `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md`, `Packaging/Info.plist`, `.github/workflows/{ci,release}.yml`, all `scripts/*.sh`, `.env.example`, `.swift-format`, `.gitignore`, `Package.swift`
> **Method:** line-by-line source read. Numbers below are copied from code, not docs. Where docs and code disagree, code wins and the drift is flagged (§8).
> **Purpose:** competitive teardown for building a stronger Windows version ("D Shift" for Windows). §6 is the porting checklist; §7 is where we beat it.

---

## 0. Executive summary — what D-Shift actually is

A **single-process, zero-third-party-dependency SwiftPM executable** (Swift 5.9, `Package.swift:5` platforms `[.macOS(.v14)]`) for macOS 14+:

- A borderless, **non-activating, translucent `NSPanel`** docked to the right edge of the screen under the mouse, toggled by a **double-tap of Shift** detected from global `flagsChanged` events, closed with **Esc** (`SidebarPanel.cancelOperation` → `orderOut`).
- On each user turn it sends Claude **only a one-line `<context app="…" window="…"/>` tag + a `<memory>` block** (`me.md` full text + up to 200 memory filenames). Screen *contents* are **not** sent up front — the model must call `read_screen` (macOS Accessibility tree serialisation) and may call `take_screenshot` at most **once per question** as a last resort.
- A hand-rolled **Anthropic Messages API streaming client over raw HTTP/SSE** (no SDK) drives a **tool-use agent loop capped at 12 iterations**, with per-tool per-turn call caps, in-chat approval cards, transcript **rollback on error**, dangling-`tool_use` repair, and interrupted-turn salvage.
- **Memory is a plain folder of Markdown files** (`me.md`, `notes.md`, `people/`, `projects/`) under `~/Library/Application Support/DShift/memory/`. The model searches it with a **heavily allow-listed read-only shell** and writes it with a **path-confined `.md`-only writer** — both tools are **hidden** (no chat card, no approval).
- Optional escalation: `use_computer` hands a self-contained task to **OpenAI Codex via `codex app-server` (JSON-RPC over stdio — *not* `codex exec`, despite the docs)**, always approval-gated (unless "Auto mode"), with per-app elicitation forwarding, a **600 s timeout**, and full process-tree teardown.
- Optional OpenAI side-channel: if an `OPENAI_API_KEY` exists, two extra tools appear — `draw_on_screen` (GPT-written HTML overlay) and `show_3d_model` (GPT-streamed SceneKit JSON-Lines model + a self-polish pass). Without that key the app is Claude-only.
- Multiple **chat tabs**, each an independent `ChatModel` + API transcript; chats **are** persisted to disk (`history/chats/<uuid>/`) and reopenable from a History popover, but **open tabs are not restored on relaunch** (README roadmap still lists "Persist chat tabs across restarts" — see §7).
- Per-chat **usage bar**: context-window % (of 1,000,000), in/out tokens, cache hit rate, estimated USD cost at hardcoded list prices.
- Menu-bar (status item) app: `LSUIElement=true`, `.accessory` activation policy. Menu: Toggle Sidebar, Open Memory Folder, Open Feedback Folder, Change API Key…, Set OpenAI API Key…, Quit.
- Distribution: **ad-hoc signed, not notarized** by default; universal (arm64+x86_64) zip built by `scripts/bundle.sh`, released by tag-triggered GitHub Actions.

**Undocumented / under-documented surface found in code (not in README's tool table):** `make_diagram` (Mermaid→JPEG via offscreen WKWebView + jsDelivr CDN), `scratchpad` (shared floating notepad, persisted to `scratchpad.json`), `draw_on_screen`, `show_3d_model`, Anthropic server tools `web_search`/`web_fetch`, an **appshot** feature (Ctrl+Shift chord screenshots the focused window into the chat), a **Feedback** capture system, slash commands (`/auto /new /clear /history /copy /memory /help`), message queueing + Cmd+Return takeover, Auto mode (Shift+Tab), and five headless CLI test modes in `main.swift`.

---

## 1. File-by-file inventory

LOC = `wc -l` at snapshot. `file:line` citations refer to that snapshot.

### 1.1 Root / build / packaging

| File | Purpose / key content |
|---|---|
| `Package.swift` (11) | SwiftPM manifest, tools 5.9. One `.executableTarget(name:"DShift", path:"Sources/DShift")`, one `.testTarget`. macOS 14 only. **Zero dependencies.** |
| `Packaging/Info.plist` | `CFBundleIdentifier=com.kylejeong2.dshift`, executable `DShift`, icon `AppIcon`, `LSMinimumSystemVersion=14.0`, **`LSUIElement=true`** (no Dock icon), `NSHighResolutionCapable=true`, version strings are the literal placeholder `__VERSION__` substituted by `bundle.sh` via `sed`. Copyright "© 2026 Kyle Jeong. MIT". No usage-description / entitlement keys in the plist (permissions are TCC-by-API). |
| `.env.example` | `ANTHROPIC_API_KEY` (required), commented `OPENAI_API_KEY`, commented `DSHIFT_DATA_DIR`. |
| `.swift-format` | `swift-format` v1, 4-space indent, `lineLength: 120`, `ReplaceForEachWithForLoop: false`. CI lints with `--strict`. |
| `.gitignore` | `.build/`, `.env*` (except example), `/data/ /memory/ /history/ *.jsonl` (in-repo data-dir safety), `/dist/`, `.DS_Store`. |
| `README.md` | Product doc: install (Gatekeeper "Open Anyway" / `xattr -dr com.apple.quarantine`), permissions table, shortcuts, architecture diagram, memory layout, config table, privacy section (explicitly warns screen content + memory overview go to Anthropic; prompt-injection-via-memory warning). |
| `CHANGELOG.md` | Keep-a-Changelog + SemVer. `0.1.0` 2026-10-01, `0.2.0` 2026-10-02, `[Unreleased]` = `use_computer` only. **Stale vs code:** diagram/scratchpad/overlay/3D/appshot/history-persistence landed after 0.2.0 but are not in Unreleased. |
| `SECURITY.md` / `CONTRIBUTING.md` / `CODE_OF_CONDUCT.md` | Standard community files; security reporting route. |
| `.github/ISSUE_TEMPLATE/*`, `pull_request_template.md` | Bug/feature templates. |

### 1.2 `Sources/DShift/main.swift` (243) — entry point + 5 hidden headless modes

Top-level (no `@main`): sequentially checks `CommandLine.arguments` for debug flags, each ending in `RunLoop.main.run()`:

1. `--codex-test "<task>"` — runs one `CodexRunner.run` headlessly, auto-answering app-access prompts with `.once`, prints progress/result, `exit(0|1)`.
2. `--diagram-test <out.jpg>` — renders a hardcoded sample Mermaid flowchart via `DiagramRenderer.shared.render`, writes JPEG.
3. `--overlay-test "<request>" <out-dir> [--standalone] [--model] [--drag]` — runs `OverlayTool` or `ModelTool` over the frontmost app, screencaptures every **500 ms** via `/usr/sbin/screencapture -x`, then a final shot after **2,500 ms**; `--drag` synthesises CGEvent drags (30 steps × 16 ms) on the first interactive card; dumps `prompt.txt` + `drawing.html`.
4. `--scratchpad-test <out.png>` — exercises `ScratchpadTool` write/draw(broken-code case)/read, snapshots PNG.
5. `--chat-test "<message>"` — drives a real `ChatModel` headlessly, prints entries/tool status, writes tool images to `/tmp/dshift-chat-test-<n>.jpg`.

Normal path (end of file): `NSApplication.shared`, `AppDelegate`, `SingleInstance.claim(onRelaunch: delegate.showSidebar)`, `app.setActivationPolicy(.accessory)`, `app.run()`.

### 1.3 `Sources/DShift/App/` (11 files, 750 LOC)

| File (LOC) | Purpose — key types / functions / constants |
|---|---|
| `AppDelegate.swift` (104) | `@MainActor NSApplicationDelegate`. `applicationDidFinishLaunching`: `AXIsProcessTrustedWithOptions([prompt:true])` (prints grant-and-relaunch if untrusted), builds `SidebarController`, `DoubleShiftMonitor{sidebar.toggle()}`, `ModifierChordMonitor{sidebar.appshot()}` (Ctrl+Shift), status item, invisible Edit menu. `setUpEditMenu`: accessory apps get no menu bar, so a never-visible main menu supplies Undo/Redo/Cut/Copy/Select-All key equivalents; **Paste deliberately has empty keyEquivalent** (Cmd+V is handled by the input bar for image paste). `applicationWillTerminate` → `CodexProcessTree.shutDownAll()`. Status menu: Toggle Sidebar / Open Memory Folder (`Storage.memoryDir`) / Open Feedback Folder (`Feedback.dir`) / Change API Key… (`APIKeyStore.shared.reset()` + `sidebar.reveal()`) / Set OpenAI API Key… (`NSAlert` + `NSSecureTextField` 300×24, empty value deletes `OPENAI_API_KEY` from Keychain; note in alert text: *"Used only for drawing on your screen (GPT-6.1 Sol Ultrafast). Open a new chat tab after saving."*) / Quit (⌘Q). Status icon: SF Symbol `shift`. |
| `SidebarController.swift` (181) | The panel. `SidebarPanel: NSPanel` — `canBecomeKey=true`, `cancelOperation` (Esc) → `orderOut(nil)`. Controller constants: `defaultWidth=400`, `minSize=300×320`, `edgeInset=8`, `handleThickness=6`, `cornerHandleSize=24`, **`cornerRadius=20`** (continuous curve), **`backdropOpacity=0.85`**. Panel: `styleMask=[.borderless,.nonactivatingPanel]`, `level=.floating`, `collectionBehavior=[.canJoinAllSpaces,.fullScreenAuxiliary]`, `isOpaque=false`, clear bg, shadow on, `hidesOnDeactivate=false`, forced `.darkAqua` appearance. Structure: container (layer cornerRadius 20, 1 pt white 12% border, masksToBounds) → `NSVisualEffectView` (`material=.hudWindow`, `blendingMode=.behindWindow`, `state=.active`, `alpha=0.85`, `maskImage` = 9-patch rounded mask, edge `2*radius+1=41`) + sibling `NSHostingView(SidebarView)` — only backdrop is translucent, text fully opaque. Five `ResizeHandle`s: `.left, .top, .bottom, [.top,.left], [.bottom,.left]`. `show()`: docks to **right edge of `NSScreen.underMouse.visibleFrame`**, size/topInset restored from `UserDefaults` keys `sidebar.width/height/topInset`, clamped to screen −16; `makeKeyAndOrderFront`. `toggle()`, `reveal()`, `appshot()` (attach window screenshot → reveal → `focusRequest+=1`). `store.onLastChatClosed` hides panel. |
| `DoubleShiftMonitor.swift` (52) | See §2.2. `maxTapDuration=0.25 s`, `maxGapBetweenTaps=0.4 s`, keyCodes LShift=56 / RShift=60. |
| `ModifierChordMonitor.swift` (50) | Ctrl+Shift "appshot" chord. `chord=[.control,.shift]`, `maxHoldDuration=0.8 s`. Any `keyDown` while chord armed cancels; Cmd/Option joining cancels (`isCancelled` latch until all modifiers released). |
| `EventMonitor.swift` (35) | Thin wrapper registering **both** `NSEvent.addGlobalMonitorForEvents` and `addLocalMonitorForEvents` for a mask, hopping to `@MainActor` via `MainActor.assumeIsolated`; removes monitors in `deinit`. Static `.escape(handler)` = keyDown with `keyCode==53`. |
| `ResizeHandle.swift` (108) | `NSView` edge/corner resizer. `Edges: OptionSet` (left/top/bottom). Draws `NSColor(white:0, alpha:0.01)` fill clipped to the panel's rounded path (transparent pixels would pass clicks through; anything past the rounded shape would square the shadow/screenshots). `acceptsFirstMouse=true`, `mouseDownCanMoveWindow=false`. Cursor via **always-active tracking areas** (cursor rects don't work in a never-active app): `.resizeLeftRight` / `.resizeUpDown` / macOS 15 `frameResize(topLeft/bottomLeft, .all)` else `.crosshair`. Drag math pins the opposite edge (left-drag keeps `maxX` fixed; top keeps `minY`; bottom keeps `maxY`), clamped to `window.minSize/maxSize` and screen `visibleFrame`. `mouseUp` → `onResizeEnd(frame)` → persistence. |
| `Config.swift` (53) | `enum Config`. `value(_:)` precedence: **process env → `./.env` → `~/.config/dshift/.env` → Keychain** (first non-empty wins). Dotenv parser: trims, strips optional `export `, matches `NAME=`, strips surrounding `"'` quotes, skips empties. `dataDir`: `DSHIFT_DATA_DIR` (tilde-expanded) else `~/Library/Application Support/DShift`, created eagerly. `directory(_:in:)` creates subdirs on demand. |
| `Keychain.swift` (65) | `enum Keychain`: generic-password items, **service `com.kylejeong2.dshift`**, account = variable name. `read` (`kSecMatchLimitOne`, returns UTF-8 string), `save` = delete-then-`SecItemAdd`, `delete`. No access-control / biometric flags. `APIKeyStore: ObservableObject` (`@MainActor`, singleton): account `ANTHROPIC_API_KEY`, `@Published hasKey` seeded from `Config.value`, `save` (trim, non-empty), `reset` (delete + re-read — env/.env keys still apply). |
| `SingleInstance.swift` (44) | See §4.2. Lock file `$TMPDIR/dshift.lock`, `flock(LOCK_EX|LOCK_NB)`, PID written into file, loser sends `SIGUSR1` to winner and `exit(0)`; `SIGUSR1`/`SIGTERM` via `DispatchSourceSignal` on main queue. |
| `Log.swift` (24) | `enum Log.info(category,message)`: ISO-8601 timestamped line to stdout **and** append to `<dataDir>/logs/dshift.log` on a serial `DispatchQueue` (opens/seeks/writes per call). Header warns never to log API keys/message contents — but call sites do log task text, tool outputs (300-char prefixes) and Codex tasks in full (see §7 security). |
| `AppKit+Layout.swift` (23) | `NSScreen.underMouse` (screen containing `NSEvent.mouseLocation`, fallback main/first) and `NSView.addPinnedSubview` (edge-to-edge AutoLayout). |

### 1.4 `Sources/DShift/Context/` (2 files, 238 LOC)

| File (LOC) | Purpose — key types / functions / constants |
|---|---|
| `AXSnapshot.swift` (133) | See §2.3. `struct ScreenContext {appName, windowTitle, tree, windowFrame?}`. Caps: `maxNodesVisited=3000`, `maxOutputChars=60_000`, `maxValueChars=500`, `maxDepth=40`, `timeBudget=1.5 s`, app messaging timeout `0.5 s`, structural roles `{AXGroup, AXUnknown, AXSplitGroup, AXScrollArea, AXLayoutArea}` collapsed. |
| `AppTracker.swift` (105) | `@MainActor ObservableObject` with `@Published app: NSRunningApplication?`, `windowTitle`. Follows `NSWorkspace.didActivateApplicationNotification`; **ignores its own pid** and apps failing `hasNormalWindow(pid)` — via `CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements])`, requires a window with `layer==0`, `alpha>0`, `width≥200 && height≥150` (filters Screen Studio-style floating-widget apps). Per-app `AXObserver` (messaging timeout `0.25 s`) for `kAXFocusedWindowChanged/kAXMainWindowChanged` on the app element + `kAXTitleChanged` on the focused window; C callback → `MainActor.assumeIsolated`. |

### 1.5 `Sources/DShift/Chat/` (9 files, 1,286 LOC)

| File (LOC) | Purpose — key types / functions / constants |
|---|---|
| `ChatModel.swift` (698) | **The core.** `@MainActor ObservableObject`, one per tab. `maxAgentIterations=12`. Giant `systemPrompt` (see §2.4). State: `entries:[TranscriptEntry]`, `input`, `attachments`, `queue:[QueuedMessage]`, `isQueuePaused`, `usage:ChatUsage`, `focusRequest`, raw `apiMessages:[JSON]`, `toolCalls:[String:ToolCallEntry]`, `callsThisTurn:[String:Int]`, `pendingTakeover`. Tool registration in `init`: always `[ReadScreenTool, ScreenshotTool, MemorySearchTool, MemoryWriteTool, DiagramTool, ScratchpadTool]`; `+ComputerUseTool` iff `ComputerUseTool.locateCodex() != nil`; `+OverlayTool, +ModelTool` iff `OpenAIClient.hasKey`. Send paths: `send()` (queue if running), `sendNow()` (Cmd+Return takeover), `sendQueuedNow`, `stop()` (pauses queue), `interrupt()` (cancels task, denies pending approvals/access, marks `.preparing` calls cancelled). `runTurn` (§2.4), `streamAssistantMessage`, `runTools`, `execute` (validation → per-turn cap → approval → cancellable sub-`Task` with progress + access callbacks), `serverTools` (web_search/web_fetch, §3), `repairDanglingToolUses` (static, tested), `userContent` (§2.4), `handleCommand` (slash commands), `clear()` (also `ChatArchive.delete`), `save()`/`transcriptEntry(from:)` persistence mapping. Private `AssistantMessage` struct: accumulates blocks verbatim incl. thinking + signatures, parses `input_json_delta` partials (invalid JSON → `invalidToolInputs`), `dropEmptyTextBlocks()`. Title = first **28 chars** of first question. Default empty-attachment question: *"What do you make of this screenshot?"* |
| `ClaudeClient.swift` (94) | Raw Messages API client. `typealias JSON=[String:Any]`. `StreamEvent` enum (blockStart/blockDelta/blockStop/stopReason/usage). `ClaudeError` (missingAPIKey/http/stream). Endpoint `https://api.anthropic.com/v1/messages`; **`model="claude-opus-5-5"`** (public static), **`effort="low"`**, `max_tokens=64000`, headers `x-api-key`, `anthropic-version: 2023-06-01`, `anthropic-beta: server-side-fallback-2026-07-01`; body adds top-level `cache_control:{type:"ephemeral"}`, `fallbacks:"default"`, `output_config:{effort}`, `stream:true`, `tools` only if non-empty. `parseEvents` maps SSE: `message_start→usage`, `content_block_*`, `message_delta→stopReason+usage`, `error→throw`. |
| `OpenAIClient.swift` (87) | Responses API side-channel **only for graphics tools**. Endpoint `https://api.openai.com/v1/responses`; **`model="gpt-6.1-sol"`, `service_tier="ultrafast"`**, prices **input $12 / output $60 per Mtok**; `costSummary` → `"N in / M out, $X.XXX"`. `stream(instructions:input:jpeg:effort:"medium":maxOutputTokens:)` — body `store:false`, `reasoning:{effort}`, optional `input_image` as data-URL. Parses `response.output_text.delta`, `response.completed→usage`, throws on `response.failed`/`error`. `hasKey = Config.value("OPENAI_API_KEY") != nil`. |
| `ServerSentEvents.swift` (37) | Shared SSE engine: `URLSession.shared.bytes(for:)`, non-200 → collect body lines → `httpError(status,body)`; per-line `parse` → yield; `onTermination` cancels task. `payload(_:)`: only `data: ` lines (drops first 6 chars), JSON-object or throws. |
| `Transcript.swift` (206) | UI-state types. `ScrollSignal` (`@Published tick`). `Attachment`: downscales any image to **max long edge 1568 px**, re-encodes **JPEG q=0.8** on a white background; `Source{appName,windowTitle,icon}` for appshots. `QueuedMessage{id,text,attachments}`. `TranscriptEntry` enum (.text/.tool). **`TextEntry`** — the streaming-reveal engine (§2.5): 60 Hz timer, drain backlog/8 per frame. **`ToolCallEntry`** — `Status{preparing, awaitingApproval, running, succeeded, failed, denied, cancelled}`, `startedAt/finishedAt` set in `status.didSet`, `inputSummary` (sorted-keys JSON), approval via `CheckedContinuation<Bool>`, per-call `cancel()`/`onCancel`, app-access via `CheckedContinuation<AppAccess>` (`AppAccess{once, always, deny}`). |
| `Usage.swift` (62) | See §2.6. `TokenUsage` (merge = overwrite, cumulative semantics) + `ChatUsage` (`contextWindow=1_000_000`; prices in $4 / out $20 / cacheRead $0.20 / cacheWrite $5.00 per Mtok). |
| `ChatStore.swift` (71) | `@MainActor ObservableObject` tab owner: `chats:[ChatModel]`, `selectedID`, shared single `AppTracker`, `isHistoryOpen`, `onLastChatClosed`. `newChat`, `open(saved)` (switches if already open; **replaces an untouched blank selected tab** instead of appending), `select` (bumps `focusRequest`), `close` (stops chat; if last → creates a fresh chat *and* fires `onLastChatClosed` to hide the panel). Wires `onStoreCommand` for `/new` + `/history`. **Init always starts with one fresh blank chat — saved chats are never auto-restored.** |
| `ChatArchive.swift` (84) | On-disk chat persistence: `<dataDir>/history/chats/<uuid>/{chat.json, api.json, <attachmentUUID>.jpg}`. `SavedChat: Codable {id,title,createdAt,updatedAt,app,entries:[Entry{kind:user/assistant/tool, text, attachmentIDs, toolName, toolInput, toolFailed}]}`; `preview` = first assistant entry's text. ISO-8601 Codable; writes `.atomic`; `list()` newest-first, silently skips undecodable folders; `apiMessages(for:)` returns raw `[JSON]` or `[]`; `delete(id)` removes folder. |
| `SlashCommands.swift` (50) | `SlashCommand: CaseIterable {auto, new, clear, history, copy, memory, help}`. `matches(for:)`: only bare `/prefix` input (no space/newline), case-insensitive prefix match for the command menu. `exact(_:)`: full-name match, trimmed+lowercased. `AutoMode`: `UserDefaults` bool key **`autoMode`** — when on, `use_computer` approval is skipped and Codex app-access is auto-answered `.once` (logged as `"auto"`). |

### 1.6 `Sources/DShift/Memory/Memory.swift` (96)

Three concerns in one file:

- `enum Storage`: `memoryDir = <dataDir>/memory` (seeds on first access), `historyDir = <dataDir>/history`.
- `enum Memory`: `maxListedFiles=200`. `overview()` → `"## me.md\n<full me.md>\n\n## Files\n<relative .md paths, sorted, first 200>"` (+ `"(N more)"` suffix). `seedIfNeeded` creates `people/`, `projects/`, seeds `me.md` (`"# About me\n\n- Name:\n- Role:\n- Writing style:\n"`) and `notes.md` (`"# Notes\n\n"`) only if absent. `markdownFiles()` = recursive enumerator, `.md` only, paths relative to memory root, sorted.
- `enum ChatHistory`: append-only JSONL, one file/day `history/YYYY-MM-DD.jsonl` (local tz), entry `{timestamp(ISO-8601), role, text, app, chat(UUID)}`. **Log-only — never read back into the model.**
- `enum MemoryPath.resolve(_:inRoot:)` — exact rules in §3.4.

### 1.7 `Sources/DShift/Tools/` (9 files, 2,863 LOC — the largest area)

| File (LOC) | Purpose — key types / functions / constants |
|---|---|
| `Tools.swift` (98) | The plugin contract. `struct ToolOutput {text, jpeg?}`. `@MainActor protocol Tool`: `name`, `description`, `inputSchema:JSON`, `requiresApproval(for:)`, `isHidden` (default `false`), `maxCallsPerTurn:Int?` (default `nil` = unlimited), `run(_:)`, plus default-forwarding overloads `run(_:progress:)` and `run(_:progress:requestAccess:)`. `enum ToolError {unknownTool, invalidInput, limitReached, failed}` — limit message: *"`<name>` can only be called `<n>` time(s) per question. Answer with what you have."* `ToolRegistry`: `definitions` emit `{name, description, input_schema, eager_input_streaming:true}`; `validate` enforces required fields present + required strings non-empty (because eager streaming skips server validation). |
| `ScreenTools.swift` (94) | `ReadScreenTool` + `ScreenshotTool` — §3. Screenshot: ScreenCaptureKit, `maxLongEdgePixels=1568`, scale `min(2, 1568/max(w,h))`, JPEG (default quality via `NSBitmapImageRep`), window match by pid+layer 0+frame>50×50, title match else largest area; screen scope excludes own windows. |
| `MemoryTools.swift` (77) | `MemorySearchTool` (hidden) + `MemoryWriteTool` (hidden) — §3. |
| `Shell.swift` (74) | `enum ShellPolicy` (§3.3) + `enum ShellRunner`: `/bin/bash -c`, cwd = memory dir, `timeout=20 s` (DispatchWorkItem terminate), `maxOutputChars=30_000` (+`"(output truncated)"`), env `PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, **`ANTHROPIC_API_KEY` removed**, stdin = null device, stdout+stderr merged, appends `"[exit N]"` / `"[killed after 20s timeout]"`. |
| `ComputerUseTool.swift` (399) | `ComputerUseTool` (§3.5), `CodexRunner` (app-server JSON-RPC driver, `timeout=600 s`), `CodexProcessTree` (descendant teardown: `pgrep -P` BFS, SIGTERM → **2 s grace** → SIGKILL; `shutDownAll` on quit), `CodexEventLog` (`maxProgressLines=12`; folds notifications into steps/finalMessage/failure/blockedApps; regex-free string parsing of the two Computer Use refusal formats; `appName(inApprovalPrompt:)` extracts first quoted string). |
| `DiagramTool.swift` (165) | `DiagramTool` (`make_diagram`, cap 4/turn) + `DiagramRenderer` singleton: one offscreen `WKWebView` in a window at (−20000,−20000), `sharingType=.none`, `maxWidth=1400`, loads **Mermaid 11 from `https://cdn.jsdelivr.net`** (`securityLevel:"strict"`, dark theme, `curve:"basis"`), `renderDiagram` JS returns SVG size or `{error}`; snapshot at **2×** (`snapshotWidth = width*2`), JPEG **q=0.9**. Strips ` ```mermaid `/` ``` ` fences from input first. Rendered image is returned to Claude too (self-check loop). |
| `OverlayTool.swift` (536) | `OverlayTool` (`draw_on_screen`, cap 3/turn, `maxOutputTokens=8000`) + `OverlayController` singleton. §3.6. Highlights: preview re-render throttled to **>0.08 s (~12 fps)**; hit-area polling every **200 ms** in-page, mouse-routing timer at **60 Hz**; CSP `default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; …`; panel level = `floating − 1` (below sidebar). |
| `ModelTool.swift` (932) | `ModelTool` (`show_3d_model`, cap 2/turn, `maxOutputTokens=32000`, `maxParts=3000`) + `ModelHistory` (last 4 builds fed back for novelty) + `ModelWindow`/`ModelView`/`ModelPart`/`Mesh`. §3.6. SceneKit: HDR camera (fov 35, bloom intensity 0.9 / threshold 0.75 / blur 10), 3-point studio lights (1400/450/900), labels ≤5, repeats capped 200, polish pass ≤~80 lines, `DSHIFT_MODEL_EFFORT` (default `low`), `DSHIFT_MODEL_POLISH=0` disables polish. |
| `ScratchpadTool.swift` (516) | `ScratchpadTool` (`scratchpad`: write/append/draw/read/clear; draw height clamp **80–600**, default 240) + `Scratchpad` singleton `NSPanel` (400×520 default, min 280×200, level `floating+1`, frame autosave name `dshift.scratchpad`, state persisted to `<dataDir>/scratchpad.json`). Embedded HTML page: hand-rolled Markdown renderer, sandboxed drawing iframes (`sandbox="allow-scripts"`, CSP `default-src 'none'`), type-in animation ~40 steps × 25 ms, edit-in-place textareas, checkbox toggling writes back into source Markdown. |

### 1.8 `Sources/DShift/UI/` (4 files, 2,210 LOC)

| File (LOC) | Purpose — key types / functions |
|---|---|
| `ChatView.swift` (949) | All main SwiftUI. `Theme` tokens (surface radius 12, inner 8, fill black 40%, stroke white 10%). `SidebarView` (tab strip + API-key gate → `APIKeySetupView` vs header+chat; tap-anywhere focuses input). `APIKeySetupView` (SecureField `sk-ant-…`, Save, "Get a key" link). `TabStrip`/`TabButton` (title max width 120, spinner while running, ⌘T new via hidden shortcut button, ⌘W close via `ShortcutKey`). `AppContextHeader` (app icon 18 pt, eye icon, name + middle-truncated window title). `TranscriptView` (pinned-to-bottom logic: bottom marker within **viewport + 40 pt** counts as pinned; sending a user message force-pins; `ScrollSignal.tick` driven). `UsageBar` (§2.6 rendering: context meter 28×4 capsule, orange >80%; cost format 3 fraction digits if < $1 else 2). `ThinkingRow` (3×3 `PixelGrid`, period 0.65 s, delays `[.09,.18,.27, 0,.09,.18, .09,.18,.27]`, resting opacity 0.15; `ShimmerText` period 1.4 s; elapsed `%.1fs`). `TextRow` (user bubble RGB(0, 0.36, 0.82) @ 92%, leading inset 40; assistant = inline-only Markdown via `AttributedString` + streaming caret `" ▍"`; `MessageSegment.split` on ` ``` ` fences → `CodeBlock` monospaced 11.5 pt). `QueueView`/`QueuedRow`. `InputBar` (line limit 1…6, Return send, **Cmd+Return sendNow**, slash-command menu with ↑/↓ highlight + Tab completion, **Shift+Tab / backtab (U+0019) toggles Auto mode**, Cmd+V image-vs-text paste routing, drag-drop + NSOpenPanel image attach, camera = appshot button, drop-target/Auto-mode border states). `SendControls` (idle: round send; running: Queue pill + Send-now pill + Stop). `AttachmentThumbnails/Chip` (appshot chip: 34 pt thumb + 16 pt app-icon badge + name/title; popover preview max 520×420). `MessageSegment` enum lives here (tested). |
| `AgentComponents.swift` (591) | "Beautiful UI" ports. Motion: `Animation.fadeUp` = cubic-bezier(0.23, 1, 0.32, 1) 0.38 s; `.glide` same curve 0.22 s; transition = opacity + y-offset 8. `TranscriptItem.group`: consecutive non-`use_computer` tool entries collapse into one `ToolGroup`; `use_computer` gets a dedicated `TaskRow`. `ToolChip` (status icon: pixel-grid while active, green ✓ / red ✗ / grey ⊘; expandable Input/Output detail **truncated at 2,000 chars, 14 lines**; screenshot/diagram image max height 120 collapsed / 400 expanded). `ApprovalCard` (Allow/Deny, orange 35% border, hover highlight with `matchedGeometryEffect`). `TaskRow` (40 pt header, elapsed timer 0.1 s tick, status pill, Stop button while running, expanded steps = **last 12 output lines**, nested per-app access `ApprovalCard` with Allow once / Always allow / Deny). `MessageActions` (copy, ✓ feedback resets after 1.2 s). `DiagramImage` (click-to-zoom popover ≤900 wide, context menu Copy / Save to Downloads as `diagram-<epoch>.jpg`). |
| `HistoryAndFeedback.swift` (251) | `HistoryButton` (⌘Y, popover 320×380: search field filters title + all entry texts case-insensitively; rows show open-dot, first-assistant preview, app + relative date; hover trash → `ChatArchive.delete`). `FeedbackButton/Composer`: captures display **before** popover opens (`SCShareableContent` including desktop windows, at backing scale) so the sidebar is in the shot; `Feedback.save` writes `<dataDir>/feedback/<ISO-stamp>/{screen.png, note.md}` (note.md embeds focused app, chat title, **last 8 transcript entries**) and appends a checkbox line to `feedback/INBOX.md`. `Feedback.dir = <dataDir>/feedback`; `transcriptTail=8`. |
| `TextZoom.swift` (64) | `TextZoom.levels = [0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0]`, `UserDefaults`/`@AppStorage` key `textZoom`; `step` snaps off-grid values up. Hidden `ShortcutKey`s: Cmd+= / Cmd++ zoom in, Cmd+− out, Cmd+0 reset. `scaledFont(size,weight,design)` view modifier multiplies every font by zoom. `ShortcutKey` = zero-size invisible button carrying a `keyboardShortcut` (the app's general hidden-shortcut mechanism). |

### 1.9 `Tests/DShiftTests/` (10 files, 397 LOC — Swift Testing, `@Test`/`#expect`, `@testable import DShift`)

| File (LOC) | Covers |
|---|---|
| `ShellPolicyTests.swift` (40) | 6 allowed commands; 17 denied (chaining, substitution, absolute/`~`/`..` paths, `-f/etc/passwd`, `--pre`, `find -exec/-delete`, pipe-to-`sh`, trailing pipe, `sed -i`, empty). |
| `MemoryPathTests.swift` (21) | 5 accepted relative `.md` paths (incl. `./people/sam.md`); 8 rejected (empty, absolute, `~`, `../`, nested `../../`, `.txt`, directory, `.sh`). |
| `CodexEventLogTests.swift` (76) | Progress/final-message folding + exact `changes` boolean vector; failure recording; both blocked-app string formats; app-name extraction from approval prompt; noise ignored. |
| `StreamParsingTests.swift` (83) | Claude SSE block/usage/stop-reason parsing, non-data lines ignored, error events + malformed JSON throw; OpenAI delta/usage parsing, noise → nil, failures throw. |
| `ToolUseRepairTests.swift` (42) | Filler `tool_result` prepended before next user message; result message inserted when tool_use is last; answered tool uses untouched. Filler text: `"Cancelled before it ran."` |
| `TokenUsageTests.swift` (33) | Cumulative merge/overwrite semantics; `ChatUsage` context = 10,500 for (1k in, 500 out, 9k cacheRead); cacheHitRate 0.9; cost $0.0158 case. Plus `SolCostTests`: `costSummary(1000,2000) == "1000 in / 2000 out, $0.132"`. |
| `ToolRegistryTests.swift` (49) | Definition shape incl. `eager_input_streaming:true`; lookup/unknown throws; required-field + non-empty-string validation; defaults visible + unlimited. |
| `SlashCommandTests.swift` (18) | Prefix matching (`/c` → `[.clear,.copy]`), spaces/ordinary text ignored, `exact` case-insensitive. |
| `MessageSegmentTests.swift` (18) | Fence splitting, unclosed fence while streaming, plain text. |
| `TextZoomTests.swift` (17) | Step/clamp at both ends, off-grid snapping (`step(3.0,-1)==1.75`). |

**Not tested at all:** AXSnapshot walking, AppTracker, panel/hotkey monitors, ChatModel loop end-to-end, ScreenshotTool, Scratchpad/Overlay/Model rendering (only via manual `--*-test` CLI modes), Keychain, SingleInstance, ChatArchive round-trip.

### 1.10 `docs/` and `scripts/`

| File | Content |
|---|---|
| `docs/architecture.md` | Component table, panel settings, double-shift spec (250 ms / 400 ms — matches code), AX limits (3,000 / 40 / 60k — matches), agent-loop description (12 iterations — matches), streaming-reveal description, usage description. **Drift:** claims panel is *"Visible in user screenshots and recordings"* and (README) *"hidden from screen recordings"* — see §8; claims `read_screen` hidden — code says visible. |
| `docs/memory.md` | Memory layout, overview contract (me.md + first 200 files), ShellPolicy + MemoryPath rules (accurate), history JSONL format. |
| `docs/tools.md` | Tool table (only 5 tools — diagram/scratchpad/overlay/model/web missing), adding-a-tool guide with sample code, rules of thumb (approval for writes/deletes/sends/spends; hidden tools must refuse not escalate; `maxCallsPerTurn`; eager-streaming validation; `@MainActor` + `Task.detached` for blocking work). **Drift:** computer-use command shown as `codex exec --json --ephemeral --skip-git-repo-check --sandbox read-only -C <data dir>/codex "<task>"` — the shipped code does **not** run this (§3.5, §8). Also claims stderr kept at `<data dir>/codex/last-run-stderr.log` — code writes per-run `runs/<stamp>.stderr.log` + `runs/<stamp>.jsonl`. |
| `docs/roadmap-autocomplete.md` | Tabled autocomplete design: AX-first, OCR (Vision `VNRecognizeTextRequest`) only when AX text < ~200 chars / < ~10 text nodes, known-bad bundle-ID list, or image content; never for caret text; OCR cached by frame hash; MLX local 0.5–1.5 B 4-bit (→3–4 B), ~1.5k tokens in / ~30 out, p50 first token < 80 ms, full suggestion < 250 ms, 150 ms typing pause. **This is the author's own admission that the shipped app has no OCR.** |
| `scripts/bundle.sh` | §4.3. |
| `scripts/dev.sh` | Watch-rebuild loop: fingerprint = `stat -f '%m %N'` over Sources+Package.swift piped to `shasum`, polled every **1 s**, 0.5 s settle debounce; failed build keeps old app running; kills lock-holder PID read from `${TMPDIR}/dshift.lock` before relaunch (kept in sync with `SingleInstance`). |
| `scripts/test.sh` | If CLT-only, adds Testing.framework search paths (`-F`/`-rpath` under `xcode-select -p`) then `swift test`. |
| `scripts/format.sh` | `swift format lint --strict` (`--check`, = CI) or in-place format over `Sources Tests Package.swift`. |
| `scripts/make-icon.swift` (38) | Renders AppIcon: blue gradient rounded square (inset 10%, corner 22.5% of tile) + white `shift.fill` symbol at 50% point size; emits iconset PNGs for 16/32/128/256/512 pt @1x/@2x. |

---

## 2. Architecture and data flow

### 2.1 Overall flow

```
Double-Shift ─▶ SidebarController.toggle() ─▶ SidebarPanel (NSPanel, non-activating)
                                                      │ SwiftUI SidebarView → ChatStore → selected ChatModel
User sends ─▶ ChatModel.start() ─▶ apiMessages += [image blocks…, {text: userContent}]
                                                      │ userContent = <context app window/> + <memory>overview</memory> + question
Agent loop (≤12) ─▶ ClaudeClient.stream (SSE) ─▶ AssistantMessage (verbatim blocks)
   stop_reason tool_use ─▶ validate → cap → approve? → Tool.run ─▶ tool_result (+image) ─▶ loop
   pause_turn ─▶ loop │ end_turn ─▶ done │ refusal/max_tokens ─▶ note
Text deltas ─▶ TextEntry.enqueue ─▶ 60 Hz reveal ─▶ TranscriptView (pinned scroll)
Every turn end ─▶ ChatArchive.save (chat.json + api.json + jpgs) + ChatHistory JSONL append
```

Design principles worth noting: (1) **context is pull, not push** — the per-turn payload is one context line + memory overview; screen content costs tokens only when the model asks. (2) **The API transcript is raw JSON** (`[JSON]`), never modelled — thinking blocks and signatures round-trip byte-identical, as Anthropic requires during tool use. (3) **Everything is `@MainActor`**; blocking work (AX walk, shell, screenshot) escapes via `Task.detached`.

### 2.2 Panel & invocation

- **Double-Shift detection** (`DoubleShiftMonitor.swift:5-6,24-47`): listens (global + local) to `.flagsChanged` + `.keyDown`. A *tap* = flags become exactly `.shift` (device-independent mask minus `.capsLock`) then return to empty with **`timestamp − downAt < 0.25 s`**. Two taps with **`timestamp − lastTapAt < 0.4 s`** trigger. **Any** other event — any keyDown, any flagsChanged not L/R-Shift (keyCodes 56/60), any extra modifier — calls `reset()` (clears both timestamps). Note the guard is `event.keyCode == 56 || == 60` evaluated only when `type == .flagsChanged`; non-shift flagsChanged events fall into `reset()`. Typing capitals (Shift held while a key is pressed) therefore cannot trigger: the keyDown resets state.
- **Esc closes**: `SidebarPanel.cancelOperation` → `orderOut`. Overlay/model/scratchpad windows install their own Esc monitors (`EventMonitor.escape`, keyCode 53).
- **Appshot chord** (Ctrl+Shift tap, ≤0.8 s hold): screenshots the tracked window into the current chat as an attachment with source label, reveals panel, focuses input.
- **Panel geometry**: right-docked; width default 400 (min 300), height default = screen max, min 320; persistence keys above. Multi-monitor: follows the **mouse's** screen, not the focused app's screen.
- The panel **never activates the app** (`nonactivatingPanel` + `.accessory` policy), so `AppTracker`'s frontmost app stays the user's app. It *can* become key (for typing) without becoming frontmost.

### 2.3 AX snapshot — algorithm and limits (`AXSnapshot.capture`)

1. `AXUIElementCreateApplication(pid)`; `AXUIElementSetMessagingTimeout(app, 0.5 s)`; set **`AXManualAccessibility = true`** on the app element (forces Chrome/Electron to build their full tree).
2. Window = `kAXFocusedWindowAttribute` ?? `kAXMainWindowAttribute`; none → tree `"(no accessible window)"`.
3. Depth-first `Walker` over `kAXChildrenAttribute`, stopping when **any** of: `visited ≥ 3000`, `outputChars ≥ 60_000`, `depth ≥ 40`, or `Date() ≥ deadline (start + 1.5 s)` — sets `truncated=true`, appends `"\n(truncated)"`.
4. Per node: role (`kAXRole`), texts = `[title, value, description, placeholderValue]` trimmed, empties dropped, **de-duplicated via `NSOrderedSet` preserving order**, each **capped at 500 chars**, newlines → spaces, rendered quoted: line = `indent(2 spaces × emittedDepth) + role-without-"AX"-prefix + " \"text\" …"`. 
5. **Token-saving collapse:** a node whose texts are all empty **and** role ∈ {AXGroup, AXUnknown, AXSplitGroup, AXScrollArea, AXLayoutArea} **and** not focused is *not emitted and does not increase child depth* — children are walked at the same depth.
6. Focused element (from `kAXFocusedUIElementAttribute`, `CFEqual`) gets suffix `"  <- FOCUSED"`.
7. With `includeFrames=true` (overlay tool only): each line also gets `" [x,y wxh]"` in global top-left-origin points, or `" [offscreen]"` when width or height ≤ 1 (web views clamp scrolled-out elements to a 1 pt sliver).
8. After the walk: if the focused element has `kAXSelectedTextAttribute` non-empty, append `"\n\nSelected text:\n"` + **first 2,000 chars** (500×4).
9. Returns `ScreenContext` incl. `windowFrame` from `kAXPosition/kAXSize`.

There is **no caching** of snapshots, no diffing, no per-app quirks table in shipped code. Each `read_screen` re-walks (≤1.5 s budget on a detached task).

### 2.4 Agent loop (`ChatModel.runTurn`, `ChatModel.swift:262-310`)

- **Checkpointing:** `checkpoint = apiMessages.count` before appending the user message. Attachments become leading `image` blocks (base64 JPEG); appshot attachments are preceded by a text label block `Appshot of <App>, window "<title>":`.
- **Loop `for _ in 0..<12`:**
  1. `repairDanglingToolUses(&apiMessages)` runs **before every request** (§2.4.1).
  2. `streamAssistantMessage()` — streams, builds transcript rows live (text entries, visible tool entries, server-tool rows for `web_search`/`web_fetch` only; internal `code_execution` blocks from dynamic filtering get no row), then `usage.record(message.usage)`.
  3. Append assistant message **verbatim** to `apiMessages`.
  4. `stop_reason`: `tool_use` → run all tool_use blocks sequentially, append **one** user message with all `tool_result`s; `pause_turn` → continue silently; `refusal` → note *"Claude declined to answer this request."* and end; `max_tokens` → note *"Response hit the length limit."* and end; anything else → end. Exhausting 12 → note *"Stopped after 12 steps."*
- **Rollback:** on a thrown error, `apiMessages.removeSubrange(checkpoint...)` (the whole turn vanishes from API context) and an error note is appended to the UI transcript — invariant: **the API transcript never contains a `tool_use` without its `tool_result`**. 
- **Cancellation salvage** (`keepInterruptedTurn`): on Stop/takeover, the turn is *not* rolled back to nothing — API history becomes `[user message] + [assistant: partial streamed text + "\n\n(Interrupted by the user.)"]` (or `"(Interrupted by the user before answering.)"`); tool calls from the interrupted turn are dropped entirely. A stream that ends cancelled *without throwing* is caught by `try Task.checkCancellation()` after streaming, and an empty-blocks response throws `ClaudeError.stream("Empty response")` — both exist specifically because a half-streamed `tool_use` persisted as a normal turn would 400 every later request.
- **Tool execution pipeline** (`execute`, :396-445): invalid-JSON-input guard → registry lookup → `validate` (required/non-empty) → **increment `callsThisTurn` then cap check** (so failed/denied calls still consume the cap) → approval (`requiresApproval && !AutoMode.isOn` → `entry.requestApproval()` continuation; denied → status `.denied`, result text `"The user declined this action."`, `is_error=true`) → run in a **child `Task`** so the row's Stop button cancels just that tool (`withTaskCancellationHandler`); cancelled → result *"…Don't retry unless they ask."*; thrown → error text returned as `is_error` result and shown on the card. Success logs `output.text.prefix(300)`.
- **Prompt caching:** top-level `cache_control:{type:"ephemeral"}` on the request body (5-minute TTL pricing assumed in Usage, §2.6) + `fallbacks:"default"` with beta header `server-side-fallback-2026-07-01` (server-side refusal fallback).
- **System prompt** (single static string, `ChatModel.swift:9-52`) instructs: read_screen-first grounding + when to skip it; screenshot only for visual info AX lacks; web search/fetch for current facts with URL citations; **proactive visual explanation** (draw_on_screen default, show_3d_model for spatial, scratchpad for working, make_diagram only on explicit request; never ASCII diagrams); computer-use task-writing rules (self-contained, never just to look); **memory rules** (search before personal answers; save durable facts silently without asking; people→`people/<name>.md`, projects→`projects/<name>.md`, profile→`me.md`, small facts→`notes.md`; never save transient details/secrets; never mention memory unless asked); conciseness for a narrow sidebar.
- **Per-turn user content** (`userContent`): `"<context app=\"…\" window=\"…\" />\n\n<memory>\n\(Memory.overview())\n</memory>\n\n<question>"` — note: docs claim context is sent *"only if it changed"*; **code sends it every turn** (§8).

#### 2.4.1 Dangling-tool-use repair (`repairDanglingToolUses`, :518-546)

Scans every assistant message; collects its `tool_use` IDs; compares against `tool_result` IDs in the immediately following user message; for missing IDs inserts filler `["type":"tool_result","tool_use_id":id,"content":"Cancelled before it ran.","is_error":true]` — **prepended** to the next user message (tool_results must come first) or as a new inserted user message. Runs before each request, so legacy/corrupt saved chats self-heal.

### 2.5 Streaming reveal (`TextEntry`, `Transcript.swift:96-145`)

- Network deltas append to `pending`; a **60 Hz** `Timer` (1/60 s, `.common` runloop mode) reveals **`step = max(1, pending.count / 8)` characters per frame** — i.e. drains ⅛ of the *current* backlog each frame, so it converges exponentially, stays ≈8 frames (~133 ms) behind the network, and never bursts. `flush()` on stream end dumps the remainder.
- Each `TextEntry` is its own `ObservableObject` → only the streaming row re-renders. Each reveal bumps `ScrollSignal.tick`, and `TranscriptView` auto-scrolls only while pinned to the bottom (within 40 pt).

### 2.6 Usage accounting (`Usage.swift`) — exact formulas and prices

- `TokenUsage.merge`: `message_start` and `message_delta` usage both arrive; values are **cumulative, so merge overwrites** field-by-field (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`).
- `ChatUsage.record(u)`: `totals += u`; `requests += 1`; **`contextTokens = u.input + u.cacheRead + u.cacheWrite + u.output`** (last request only).
- `contextFraction = contextTokens / 1_000_000`.
- `cacheHitRate = totals.cacheRead / (totals.input + totals.cacheRead + totals.cacheWrite)` (0 if denominator 0).
- **Prices (hardcoded, "Claude Opus 5.5 list", $/Mtok): input 4.0, output 20.0, cacheRead 0.20, cacheWrite 5.0** (comment: cache write = 5-min TTL = 1.25× input). `estimatedCost = (in×4 + out×20 + cR×0.20 + cW×5.0) / 1_000_000`.
- OpenAI graphics pricing (separate, `OpenAIClient`): **input $12, output $60 /Mtok** ("Ultrafast list"); only rendered as a log/summary string, **not** folded into the chat usage bar — overlay/model spend is invisible in the UI totals.
- Usage is **per-tab, in-memory only** — reset by `/clear`, lost on quit (not persisted with the chat).

### 2.7 Queueing, takeover, tabs, persistence

- **Queue:** `send()` while running appends to `queue`; on turn end `advanceQueue()` starts the next. `stop()` sets `isQueuePaused=true` if queue non-empty (Resume button / any new send unpauses). Queued rows offer send-now (takeover) and remove.
- **Takeover:** `sendNow()`/queued-send-now sets `pendingTakeover`, interrupts the current turn (salvage path §2.4), then starts the takeover message.
- **Persistence (two layers):** (a) `ChatArchive` — on `start()` and at every turn end, `save()` serialises all entries + raw `apiMessages` + attachment JPEGs (§1.5); restored chats rebuild both UI entries and API context. (b) `ChatHistory` JSONL — append-only human audit log, never fed to the model. **Gap:** `ChatStore.init` does not reopen the last session's tabs; history is manual via popover/⌘Y/`/history`.

---

## 3. Tool catalogue — every tool, exactly

Registration is dynamic (`ChatModel.init`, :115-127). Definitions always carry `eager_input_streaming:true`.

| # | Name | Source | Visible? | Approval | `maxCallsPerTurn` | Availability |
|---|---|---|---|---|---|---|
| 1 | `read_screen` | `ScreenTools.swift:4` | **Visible** (see note) | Never | **3** | Always |
| 2 | `take_screenshot` | `ScreenTools.swift:24` | Visible, thumbnail card | Never | **1** | Always (needs Screen Recording TCC) |
| 3 | `search_memory` | `MemoryTools.swift:5` | **Hidden** | Never (refuses instead) | nil (unlimited) | Always |
| 4 | `write_memory` | `MemoryTools.swift:37` | **Hidden** | Never (confined instead) | nil (unlimited) | Always |
| 5 | `make_diagram` | `DiagramTool.swift:6` | Visible, image card | Never | **4** | Always (needs network to jsDelivr on first use) |
| 6 | `scratchpad` | `ScratchpadTool.swift:5` | Visible (its own window; no chat card) | Never | nil | Always |
| 7 | `use_computer` | `ComputerUseTool.swift:7` | Visible, `TaskRow` | **Always** (unless Auto mode) | **3** | Only if Codex CLI found |
| 8 | `draw_on_screen` | `OverlayTool.swift:9` | Visible (on-screen, no card) | Never | **3** | Only if `OPENAI_API_KEY` set **at tab creation** |
| 9 | `show_3d_model` | `ModelTool.swift:7` | Visible (on-screen window) | Never | **2** | Only if `OPENAI_API_KEY` set at tab creation |
| 10 | `web_search` | Anthropic server tool | Visible row | n/a (server-side) | `max_uses: 5` | Always (in `serverTools`, not the registry) |
| 11 | `web_fetch` | Anthropic server tool | Visible row | n/a (server-side) | `max_uses: 5`, `max_content_tokens: 20000` | Always; can only fetch URLs already in conversation |

> **Note on #1:** `docs/tools.md` + `docs/architecture.md` + a `ChatModel` comment all call `read_screen` hidden, but `ReadScreenTool` never sets `isHidden=true` (default `false`, `Tools.swift:34`), so in the shipped code it **does** get a transcript chip (labelled "Read screen" in `AgentComponents`). Only the two memory tools are actually hidden. This is either a one-line bug or stale docs — flagging as drift (§8).

### 3.1 `read_screen`

Input schema: empty object, `additionalProperties:false`. Runs `AXSnapshot.capture` on a detached task; returns `"App: …\nWindow: …\n\n<tree>"`, or `"No app is in focus."`

### 3.2 `take_screenshot`

Input: optional `scope ∈ {window (default), screen}`. Flow: `CGPreflightScreenCaptureAccess()` → if false, `CGRequestScreenCaptureAccess()` and return instructional text (no image). `SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly:true)`; window candidates = own-app pid, `windowLayer==0`, frame > 50×50; pick title-match else largest area. Screen scope: display containing the window origin else first display, **excluding D-Shift's own windows** from the filter. `SCStreamConfiguration`: `scale = min(2, 1568 / max(frame.w, frame.h))`, `showsCursor=false`. JPEG via `NSBitmapImageRep` (no explicit quality → default). Returns text `"<desc>, <W>x<H>."` + JPEG block.

### 3.3 `search_memory` + `ShellPolicy` — exact rules (`Shell.swift:7-35`)

Runs `ShellRunner.run(command, in: memoryDir)` on a detached task **only if** `ShellPolicy.isReadOnlyWithinFolder(command)` passes; otherwise throws `invalidInput` (hidden tool ⇒ no approval escalation possible). A command passes iff **all** hold:

1. Trimmed command non-empty.
2. Contains **none** of the forbidden characters: `` ; & ` $ < > \n \ ( ) { } `` (kills chaining, redirection, substitution, subshells, escapes).
3. Split on `|` (empty segments **not** omitted — a trailing pipe yields an empty segment → fail); **every** segment's first whitespace-token (quotes `"'` stripped) ∈ allowlist: **`rg grep egrep fgrep find ls cat head tail wc tree file stat`**.
4. For every subsequent token: fail if it has prefix `/`, contains `~`, contains `..`, contains `=/`, or (starts with `-` **and** contains `/`) — kills absolute paths, home refs, traversal, `-f/path`, `--file=/x`.
5. Fail if token ∈ **`{-exec, -execdir, -ok, -okdir, -delete, -fprint, -fprintf, -fls}`** or starts with **`--pre`** (rg preprocessor).

Runner (§1.7): 20 s timeout, 30k-char output cap, API key stripped from env. *Residual holes a competitor should note:* allowlisted programs' own flags are only lightly filtered (e.g. `find` without `-exec` is fine, but `tree`/`file`/`stat` argument tricks, `grep` reading via relative symlink inside the folder pointing outside — `MemoryPath` resolves symlinks for *writes*, the shell policy does **not** resolve them for reads; a symlink planted in the folder would let `cat link.md` read outside).

### 3.4 `write_memory` + `MemoryPath` — exact rules (`Memory.swift:82-96`)

Input: `path` (required), `content` (required), `mode ∈ {append (default), replace}`. `MemoryPath.resolve(path, inRoot:)` returns nil unless **all** hold:

1. Trimmed path non-empty, does **not** start with `/` or `~`.
2. `url = root.appendingPathComponent(path).standardizedFileURL`; **`url.pathExtension == "md"`** (case-sensitive).
3. `url.path` has prefix `root.path + "/"` (standardised root).
4. `url.deletingLastPathComponent().resolvingSymlinksInPath().path` has prefix `root.resolvingSymlinksInPath().path` — **the parent directory, symlink-resolved, must stay inside the symlink-resolved root** (note: the final component itself is not symlink-checked — a pre-existing symlinked `.md` *file* inside the folder pointing outside would still be written through; only directory escape is checked).

Write: creates intermediate directories; `replace` (or non-existent file) → atomic write of `content`; `append` → seek-to-end, writes `"\n" + content`. Returns `"Saved <path>."` No size cap, no content filtering, no approval, no notification.

### 3.5 `use_computer` — Codex invocation, in full (`ComputerUseTool.swift`)

**Discovery** (`locateCodex`, :45-59): `DSHIFT_CODEX_PATH` (tilde-expanded, returned **without existence check**) wins; else first executable of:
`/Applications/ChatGPT.app/Contents/Resources/codex`, `~/.bun/bin/codex`, `/opt/homebrew/bin/codex`, `/usr/local/bin/codex`, `~/.npm-global/bin/codex`. If none → tool not registered at all.

**Transport — the important correction:** shipped code runs **`codex app-server`** (no args) as a long-lived subprocess speaking **newline-delimited JSON-RPC 2.0 over stdio**, *not* the `codex exec …` one-shot in `docs/tools.md`. Working dir = `<dataDir>/codex` (created, plus `runs/`). Per-run artefacts: `runs/<ISO8601-stamp>.jsonl` (bidirectional transcript, sent lines prefixed `"> "`) and `runs/<ISO8601-stamp>.stderr.log`. Env: inherits process env **minus `ANTHROPIC_API_KEY`**.

**Handshake / turn:**
1. `initialize` `{clientInfo:{name:"dshift", title:"D-Shift", version:"1"}, capabilities:null}` → on result, send notification `initialized`.
2. `thread/start` `{cwd:<codex dir>, sandbox:"read-only", approvalPolicy:"on-request", ephemeral:true, developerInstructions:<guardrail prompt>}` — read-only sandbox = Codex may not run file-writing shell commands; computer use goes through its own service.
3. `turn/start` `{threadId, input:[{type:"text", text:<task>, text_elements:[]}]}`.
4. Developer prompt (verbatim gist): operate the Mac for D-Shift, background where possible, do only what the task asks, **stop and explain rather than guess on anything ambiguous or that would send/buy/delete/share beyond the task**, end with a short summary.

**Server→client requests** (`answer`, :209-237): only `mcpServer/elicitation/request` is answered substantively — its `message` (e.g. `Allow Computer Use to use "Slack"?`) is parsed for the app name (first quoted substring) and forwarded to the UI approval card (or auto-`.once` in Auto mode): `.once` → `{action:"accept", content:null, _meta:{persist:"session"}}`; `.always` → `persist:"always"`; `.deny` → `{action:"decline", …}`. **Every other server request** (command execution, file edits, etc.) → `{decision:"decline"}`.

**Progress/result** (`CodexEventLog.apply`): `item/started mcpToolCall` → step = `arguments.title ?? tool`; `item/completed mcpToolCall` → blocked-app detection (below) / `"<tool> failed"`; `item/started commandExecution` → `"Running <command>"`; `item/completed agentMessage` → `phase=="final_answer"` sets `finalMessage`, else first line becomes a step; `turn/completed` → `isDone`, error → `failure`, final message back-filled from last `agentMessage` in `turn.items`; `error` → `failure`. UI shows **last 12 steps**. Blocked-app string matching: `"Computer Use was not approved to use "` → `"<App>: not approved"`; `"is not allowed to use the app '"` → `"<bundle-id>: blocked for safety (Codex never controls this app)"` (terminals: Ghostty/Terminal/iTerm are hard-blocked by Codex itself). Blocked list is appended to the returned result text.

**Lifecycle:** **600 s** wall-clock killer (`DispatchWorkItem` → `CodexProcessTree.shutDown`). Cancellation (Stop button / turn cancel / app quit) → same teardown: snapshot descendants via `pgrep -P` BFS (deepest first), SIGTERM all, after **2 s** SIGKILL survivors. Never touches non-descendant processes (i.e. the user's own ChatGPT.app/Codex). Codex's own usage/billing is against the user's Codex/ChatGPT plan, not the Anthropic key.

**Approval UX:** first the D-Shift card *"Let Codex do this?"* with the full task JSON as detail (Allow/Deny); during the run, per-app cards *"Allow Computer Use to use <App>?"* (Allow once / Always allow / Deny). Auto mode (`/auto` or Shift+Tab, persisted `autoMode` bool) skips both layers (per-app → `.once` auto-answer, logged).

### 3.6 The OpenAI graphics tools

**`draw_on_screen` (`OverlayTool`)**: Claude supplies `description` + optional `standalone`. Non-standalone: captures AX snapshot **with frames** + a window screenshot (JPEG, best-effort — proceeds tree-only without Screen Recording permission), builds a prompt with display rect (global top-left-origin points), focused-window frame, and a **pixel→point mapping note** (`point = window.min + px / scale`, `scale = pixelsWide / window.width`, 3-decimal format). Streams GPT (`effort:"low"`, max 8,000 output tokens) HTML into `OverlayController`: a borderless non-activating panel at `floating−1` covering one display, `WKWebView` with the CSP above, streamed-HTML **morphing renderer** (keeps already-final DOM nodes so entrance animations play once; holds back an unclosed trailing `<script>`/tag; runs each script once when its closing tag arrives). Preview commits throttled to ~12 fps; final `commit` on stream end. Hit-testing: page reports interactive rects (`canvas, [data-interactive], button, input, select, textarea` first, then `[data-draggable]` cards; capped at 100 areas) every 200 ms; native side flips `window.ignoresMouseEvents` at 60 Hz based on cursor position, and implements card dragging natively (WebKit never gets drag events in this window). Lifetime: Esc clears; **app-switch clears non-standalone drawings** (observer installed only at commit, to avoid focus bounce during the ask); standalone drawings persist until Esc. Any error → dismiss + throw.

**`show_3d_model` (`ModelTool`)**: Claude supplies `description` + optional `direction`. Streams JSON-Lines from GPT (`effort` = `DSHIFT_MODEL_EFFORT` ?? `low`, max 32,000 tokens): line 1 `{title, concept}`, then materials/groups/parts (`sphere, box, cylinder, capsule, cone, torus, tube (≤200 pts, Catmull-Rom, parallel-transport frames), lathe (≤200-pt profile, 72 segments), extrude (≤300-pt outline)`), `repeat` (≤200 copies, rotate-around-axis or step), groups with `spin` (rps clamped 0–2), labels (≤5 by prompt, text ≤28 chars enforced in renderer). Parts cap **3,000**; invalid lines silently skipped. `ModelWindow`: square, size = max(560, ⅔ × min(display w,h)), cascade offset 40 pt per window, level `floating+1`; SceneKit studio rig (§1.7); drag = move window, Option-drag / two-finger swipe = rotate (0.01 rad/pt, pitch clamped ±π/2), pinch = resize window (200–1800 pt), right-click or Esc (all windows) = close; toolbar (reset view / toggle labels / close) fades in on hover. **Polish pass** (unless `DSHIFT_MODEL_POLISH=0`): after 400 ms, snapshot JPEG → second GPT stream with `instructions + polishInstructions` (≤~80 lines by prompt; `{"remove":"id"}`, same-id replacement, label-set replacement) applied live to the same window. History: last 4 build `"<title>: <concept>"` strings are fed into the next build prompt to force novelty on rebuilds.

**`scratchpad`**: (§1.7) — actions write/append/draw/read/clear; text blocks type-in; user edits are first-class (author flips to "you", `read` prefixes user blocks with `"(written or edited by the user)"`); drawings run in per-block sandboxed iframes and an errored drawing is removed so the model's retry replaces it; all state autosaves to `scratchpad.json` on every change via the `changed` script-message handler.

**`make_diagram`**: (§1.7) — Mermaid → offscreen WebView → 2× snapshot → JPEG q=0.9; the image goes **both** to the user (zoomable card, copy/save) **and back to Claude** as a tool-result image so it can fix layout/syntax (cap 4/turn enables iterate).

### 3.7 Server tools (`ChatModel.serverTools`, :462-465)

```swift
["type": "web_search_20260209", "name": "web_search", "max_uses": 5]
["type": "web_fetch_20260209",  "name": "web_fetch",  "max_uses": 5, "max_content_tokens": 20000]
```

Executed by Anthropic; the client only mirrors progress rows and, on result blocks, formats output (search: `"title\n  url"` lines; fetch: title + URL; error objects carry `error_code` → status failed).

---

## 4. Config, credentials, single-instance, packaging, CI/release

### 4.1 Configuration & env (complete list)

| Variable / key | Read via | Default / effect |
|---|---|---|
| `ANTHROPIC_API_KEY` | `Config.value` (env → `./.env` → `~/.config/dshift/.env` → Keychain acct `ANTHROPIC_API_KEY`, service `com.kylejeong2.dshift`) | Required for chat; absence → setup screen instead of chat UI |
| `OPENAI_API_KEY` | same chain (Keychain acct set from menu) | Gates `draw_on_screen` + `show_3d_model` registration **per tab at init** (existing tabs don't gain the tools until a new tab is opened) |
| `DSHIFT_DATA_DIR` | `Config.value` | `<dir>/{memory,history,logs,feedback,codex}`, `scratchpad.json`; default `~/Library/Application Support/DShift` |
| `DSHIFT_CODEX_PATH` | `Config.value` | Overrides Codex discovery (§3.5) |
| `DSHIFT_MODEL_EFFORT` | `Config.value` | Overrides 3D-model GPT effort (default `low`) |
| `DSHIFT_MODEL_POLISH` | `Config.value` | `=0` disables the model polish pass; any other value/unset enables |
| `UserDefaults: sidebar.width / sidebar.height / sidebar.topInset` | `SidebarController` | Panel geometry |
| `UserDefaults: textZoom` | `@AppStorage` | Zoom level (§1.8) |
| `UserDefaults: autoMode` | `AutoMode` | Computer-use auto-approval |
| `NSWindow frame autosave: dshift.scratchpad` | `Scratchpad` | Scratchpad window frame |
| Hardcoded in code (not configurable) | — | Claude model + effort + `max_tokens` (`ClaudeClient`), OpenAI model/tier/prices, all tool caps, all timeouts. README explicitly tells users to edit `ClaudeClient.swift` to change model/effort. |

Logs: `<dataDir>/logs/dshift.log` (unbounded, no rotation). Codex runs: `<dataDir>/codex/runs/*.{jsonl,stderr.log}` (unbounded).

### 4.2 Single instance (`SingleInstance.swift`)

- Lock path: `FileManager.temporaryDirectory/dshift.lock` (`$TMPDIR/dshift.lock`), opened `O_RDWR|O_CREAT` mode `0600`.
- `flock(fd, LOCK_EX|LOCK_NB) != 0` ⇒ another copy holds it: read up to 31 bytes at offset 0, parse PID, `kill(pid, SIGUSR1)`, print *"D-Shift is already running; showing its sidebar."*, `exit(0)`.
- Winner: truncates file, writes own PID (fd intentionally leaked/open for process life; kernel releases on exit). Installs `DispatchSourceSignal` handlers (after `signal(...,SIG_IGN)`): **SIGUSR1 → `onRelaunch` (show sidebar)**; **SIGTERM → `NSApp.terminate(nil)`** (so `applicationWillTerminate` kills Codex trees instead of the default silent death).
- If the lock file can't be opened at all: log and run **without** the check (fail-open).
- Cross-build identity: the lock is per-user-tempdir, not per-bundle — dev builds and the installed app mutually exclude (by design; `dev.sh` kills the PID from the same file).

### 4.3 Signing / packaging (`scripts/bundle.sh`)

1. `version` arg or latest git tag (strip `v`), fallback `0.0.0`. `rm -rf dist`.
2. `swift build -c release --arch arm64` and `--arch x86_64` separately, `lipo -create` → universal `dist/D-Shift.app/Contents/MacOS/DShift` (works with Command Line Tools only, no Xcode project).
3. `sed s/__VERSION__/<version>/g Packaging/Info.plist` → `Contents/Info.plist`; icon via `make-icon.swift` + `iconutil` → `AppIcon.icns`.
4. Signing: `codesign --force --options runtime --timestamp=none --sign "${CODESIGN_IDENTITY:--}"` — **default `-` = ad-hoc**; `codesign --verify --strict`.
5. `ditto -c -k --keepParent` → `dist/D-Shift-<version>.zip`.
6. Notarization only if `NOTARY_PROFILE` set **and** identity ≠ ad-hoc: `xcrun notarytool submit --wait`, `stapler staple`, re-zip.
7. **No entitlements file, no Hardened-Runtime entitlements beyond `--options runtime`, no DMG, no auto-update mechanism, no launch-at-login.**

### 4.4 CI / release (`.github/workflows/`)

- **`ci.yml`** (push to `main` + all PRs; concurrency group per-ref, cancel-in-progress): two independent jobs on **`macos-15`** — `lint` (select newest Xcode via `xcode-select -s $(ls -d /Applications/Xcode_*.app | sort -V | tail -1)`, `scripts/format.sh --check`) and `build-and-test` (`swift build`, `scripts/test.sh`). No caching, no artefacts.
- **`release.yml`** (push tags `v*`; `permissions: contents: write`): on `macos-15` — test → `scripts/bundle.sh "${GITHUB_REF_NAME#v}"` → extract that version's `CHANGELOG.md` section with an `awk` range script → `gh release create <tag> dist/*.zip --notes-file release-notes.md`. Releases are therefore **ad-hoc signed + unnotarized** (Gatekeeper warning on first launch is documented in README as expected UX).

---

## 5. Data on disk — complete map

```
<DSHIFT_DATA_DIR | ~/Library/Application Support/DShift>/
├── memory/                  # user-editable Markdown (seeded: me.md, notes.md, people/, projects/)
├── history/
│   ├── YYYY-MM-DD.jsonl     # append-only audit log (timestamp, role, text, app, chat UUID)
│   └── chats/<uuid>/        # chat.json + api.json + <attachmentUUID>.jpg  (ChatArchive)
├── logs/dshift.log          # unbounded app log
├── feedback/<ISO-stamp>/    # screen.png + note.md ; plus feedback/INBOX.md index
├── codex/runs/              # <stamp>.jsonl (full JSON-RPC transcript incl. task text) + <stamp>.stderr.log
└── scratchpad.json          # scratchpad blocks (incl. user edits)
$TMPDIR/dshift.lock          # single-instance lock + PID
Keychain (service com.kylejeong2.dshift): ANTHROPIC_API_KEY, OPENAI_API_KEY
UserDefaults: sidebar.width/height/topInset, textZoom, autoMode
```

Nothing is encrypted at rest except the Keychain items. No database anywhere.

---

## 6. Exact constants worth porting (master table)

### 6.1 Invocation & panel

| Constant | Value | Source |
|---|---|---|
| Shift tap max duration | **0.25 s** | `DoubleShiftMonitor.swift:5` |
| Max gap between taps | **0.4 s** | `DoubleShiftMonitor.swift:6` |
| Shift keyCodes (L/R) | **56 / 60** | `DoubleShiftMonitor.swift:7-8` |
| Ctrl+Shift appshot max hold | **0.8 s** | `ModifierChordMonitor.swift:6` |
| Esc keyCode | **53** | `EventMonitor.swift:22` |
| Panel default width / default height | **400 pt / full visible height** | `SidebarController.swift:14,41` |
| Panel min size | **300 × 320 pt** | `SidebarController.swift:15` |
| Panel edge inset (dock) | **8 pt** | `SidebarController.swift:16` |
| Backdrop opacity / material | **0.85 / `.hudWindow`, behind-window** | `SidebarController.swift:21` |
| Corner radius / border | **20 pt continuous / 1 pt white 12%** | `SidebarController.swift:19` |
| Resize handle thickness / corner size | **6 pt / 24 pt** | `SidebarController.swift:17,24` |
| Handle hit-fill alpha | **0.01** | `ResizeHandle.swift:38` |
| Scratchpad default / min size; level | **400×520 / 280×200; floating+1** | `ScratchpadTool.swift:96,105` |
| Overlay level / model level | **floating−1 / floating+1** | `OverlayTool.swift:342`, `ModelTool.swift:266` |
| Text zoom levels | **0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0** | `TextZoom.swift:6` |

### 6.2 Context / AX

| Constant | Value | Source |
|---|---|---|
| Max nodes visited | **3,000** | `AXSnapshot.swift:14` |
| Max output chars | **60,000** | `AXSnapshot.swift:15` |
| Max chars per attribute value | **500** (selected text: **2,000**) | `AXSnapshot.swift:16,40` |
| Max depth | **40** | `AXSnapshot.swift:17` |
| Walk time budget | **1.5 s** | `AXSnapshot.swift:19` |
| AX messaging timeout (snapshot / tracker) | **0.5 s / 0.25 s** | `AXSnapshot.swift:28`, `AppTracker.swift:62` |
| Normal-window filter | **layer 0, alpha > 0, ≥200×150 pt** | `AppTracker.swift:48-49` |
| Screenshot / attachment max long edge | **1,568 px** | `ScreenTools.swift:25`, `Transcript.swift:9` |
| Screenshot scale cap | **min(2, 1568/long edge)** | `ScreenTools.swift:76` |
| Attachment JPEG quality | **0.8** (on white bg) | `Transcript.swift:32` |
| Memory overview file list cap | **200 files** | `Memory.swift:13` |

### 6.3 Agent loop & models

| Constant | Value | Source |
|---|---|---|
| Max agent iterations / turn | **12** | `ChatModel.swift:6` |
| Claude model / effort / max_tokens | **`claude-opus-5-5` / `low` / 64,000** | `ClaudeClient.swift:33,35,58` |
| Anthropic API version / beta | **`2023-06-01` / `server-side-fallback-2026-07-01`** | `ClaudeClient.swift:51-52` |
| Prompt cache | **top-level ephemeral `cache_control`, `fallbacks:"default"`** | `ClaudeClient.swift:64-65` |
| Context window assumed | **1,000,000 tokens** | `Usage.swift:28` |
| Prices Claude ($/Mtok) | **in 4.0, out 20.0, cacheRead 0.20, cacheWrite 5.0** | `Usage.swift:30-33` |
| OpenAI model / tier / effort (chat graphics) | **`gpt-6.1-sol` / `ultrafast` / overlay `low`, client default `medium`** | `OpenAIClient.swift:16-17`, `OverlayTool.swift:88` |
| Prices OpenAI ($/Mtok) | **in 12.0, out 60.0** | `OpenAIClient.swift:19-20` |
| Overlay max output tokens | **8,000** | `OverlayTool.swift:11` |
| Model max output tokens / max parts | **32,000 / 3,000** (repeat ≤200 copies; tube ≤200 pts; extrude ≤300 pts; lathe profile ≤200) | `ModelTool.swift:8-9` + passim |
| Polish snapshot delay / polish line budget | **400 ms / ~80 lines (prompt)** | `ModelTool.swift:82` |
| Diagram max width / snapshot scale / JPEG q | **1,400 px / 2× / 0.9** | `DiagramTool.swift:37,84,89` |
| Web search / fetch caps | **5 uses each; fetch ≤20,000 content tokens** | `ChatModel.swift:463-464` |
| Chat title truncation | **first 28 chars of first question** | `ChatModel.swift:225` |

### 6.4 Tools, shell, memory, Codex

| Constant | Value | Source |
|---|---|---|
| Per-turn caps | screenshot **1**, read_screen **3**, use_computer **3**, draw_on_screen **3**, make_diagram **4**, show_3d_model **2**, memory tools **∞** | §3 table |
| Shell timeout / output cap | **20 s / 30,000 chars** | `Shell.swift:44-45` |
| Shell allowlist | **rg grep egrep fgrep find ls cat head tail wc tree file stat** | `Shell.swift:9-11` |
| Shell forbidden chars | **`; & \` $ < > \n \\ ( ) { }`** | `Shell.swift:12-14` |
| Shell forbidden args | **`-exec -execdir -ok -okdir -delete -fprint -fprintf -fls`, prefix `--pre`** | `Shell.swift:15-17` |
| Codex timeout | **600 s** | `ComputerUseTool.swift:76` |
| Codex process-tree SIGKILL grace | **2 s** | `ComputerUseTool.swift:266` |
| Codex sandbox / approval policy | **`read-only` / `on-request`, ephemeral thread** | `ComputerUseTool.swift:163-165` |
| Codex progress lines kept | **12** | `ComputerUseTool.swift:330` |
| Scratchpad draw height | **default 240, clamp 80–600 pt** | `ScratchpadTool.swift:⁵⁷` |
| Feedback transcript tail | **8 entries** | `HistoryAndFeedback.swift:139` |

### 6.5 Streaming & UI motion

| Constant | Value | Source |
|---|---|---|
| Reveal frame interval | **1/60 s** | `Transcript.swift:⁹⁹` |
| Reveal drain per frame | **max(1, backlog / 8)** (≈133 ms lag) | `Transcript.swift:100,131` |
| Overlay preview throttle | **0.08 s (~12 fps)** | `OverlayTool.swift:97` |
| Overlay hit-area poll / mouse routing | **200 ms / 60 Hz** | `OverlayTool.swift` page JS, `:439` |
| Fade-up animation | **cubic-bezier(0.23, 1, 0.32, 1), 0.38 s** (glide 0.22 s) | `AgentComponents.swift:11-12` |
| Thinking pixel-grid period | **0.65 s**, delays `[.09 .18 .27; 0 .09 .18; .09 .18 .27]` | `ChatView.swift` |
| Shimmer period | **1.4 s** | `ChatView.swift` |
| Tool detail truncation | **2,000 chars / 14 lines** | `AgentComponents.swift` |
| Task-row expanded steps | **last 12 lines** | `AgentComponents.swift` |
| Pinned-scroll threshold | **bottom within viewport + 40 pt** | `ChatView.swift` |
| Copy-feedback reset | **1.2 s** | `AgentComponents.swift` |

---

## 7. Weaknesses & gaps — where a Windows competitor beats it

### 7.1 Platform & distribution
1. **macOS-only, end to end.** AX APIs, `NSPanel`, ScreenCaptureKit, Keychain, `flock`/signals, `/bin/bash`, `pgrep` — nothing is abstracted behind a platform layer (no protocol for "screen context" or "hotkey" — `AXSnapshot`/`AppTracker` types leak `NSRunningApplication`/`AXUIElement` into tools and UI). A Windows port is a rewrite, and *our* build can be cross-platform-ready from day one (UI Automation tree ≙ AX tree is a direct conceptual map).
2. **Ad-hoc signed, unnotarized releases** — Gatekeeper warning, "Open Anyway"/`xattr` dance, and Accessibility permission breaks on every update (README admits users must remove/re-add the app). No auto-update, no launch-at-login (both on its own roadmap). Windows equivalent win: signed installer + auto-update + login startup.
3. **Requires macOS 14+** and a paid Anthropic key; no free/local tier in the shipped app (local MLX inference exists only in the tabled autocomplete roadmap).

### 7.2 Screen understanding
4. **No OCR — by the author's own roadmap admission.** Canvas apps (Figma), games, RDP/VNC, image-rendered PDFs, video: AX tree is thin/empty and the *only* fallback is a full screenshot sent to the cloud model (1/question cap). No Vision-framework OCR, no region/crop capture, no multi-window or multi-display capture (screenshot = focused window or its single display), no scroll/long-page capture.
5. **AX snapshot is one-shot and uncached**: every `read_screen` re-walks up to 3,000 nodes / 1.5 s; no incremental diff, no "what changed" — the model pays up to 60k chars repeatedly in long sessions. No redaction of password/secure fields beyond whatever AX exposes (secure text fields' values can appear via `kAXValueAttribute` in principle; no explicit filtering in code).
6. **Screenshot policy is brittle:** exactly 1 per question, enforced even when the first shot is of the wrong window (title-match heuristic → largest-window fallback can pick wrong); screenshot JPEG quality is the platform default (attachments/diagrams specify 0.8/0.9, screenshots don't).
7. **Context line is resent every turn** and the full `me.md` + file list is resent every turn — prompt caching mitigates cost, but there's no change detection despite docs claiming there is.

### 7.3 Models & providers
8. **Hard model lock-in:** chat model `claude-opus-5-5`, effort `low`, `max_tokens` 64k are compile-time constants; changing them means editing source (README literally instructs this). No model picker, no provider abstraction (the OpenAI client is a separate one-off, graphics-only), no Ollama/local, no fallback if Anthropic is down (server-side `fallbacks:"default"` only covers refusals), no per-chat model choice despite per-chat sessions.
9. **Prices are hardcoded and will rot** (Opus in $4/out $20, cache rates, GPT "Ultrafast" $12/$60) — cost display silently becomes wrong; no price fetch, no budget caps/alerts, no spend tracking for the OpenAI tools in the UI at all, and **usage is not persisted** (resets on quit/`/clear`).
10. **Effort `low` for everything** — no way to ask for a deeper answer; no thinking-budget control surfaced.

### 7.4 Memory
11. **Search is literal `grep`/`rg` only** — no embeddings, no ranking, no synonyms; quality depends entirely on the model guessing search terms. `me.md` is sent in full every turn (unbounded — a bloated `me.md` taxes every request; no size guard anywhere).
12. **Silent writes are a prompt-injection sink** (README acknowledges): screen content can induce `write_memory` calls; writes are confined to `.md` in-folder, but there is **no write log, no diff/undo, no user notification** — poisoned "facts" persist invisibly and are re-sent as trusted context. The read path additionally doesn't resolve symlinks (§3.3), and `MemoryPath` doesn't check the final-component symlink on writes (§3.4).
13. **No memory UI** beyond "open the folder": no in-app viewer/editor, no per-file provenance (which chat/screen produced a fact), no dedup/merge tooling, no export/import, no sync story.

### 7.5 Agent loop & tools
14. **12-iteration cap with sequential tool execution** — multi-tool blocks run one-by-one on the main actor path; no parallelism, no background/for later tasks, no scheduling, no retries on transient HTTP errors (a single SSE failure rolls back the whole turn), no mid-stream recovery (partial text is salvaged only on user-cancel, not on network failure — network failure = rollback + error note).
15. **Tool set is narrow for "doing" work:** no general shell (only memory-folder read-only), no file read/write outside memory, no calendar/mail/notes integration, no browser control of its own — real action is entirely outsourced to Codex, which itself is **sandboxed read-only** (can't edit files) and **hard-refuses terminals**. If Codex isn't installed, the app is read-only Q&A + drawing.
16. **Codex dependency is fragile:** discovery is a hardcoded path list; `DSHIFT_CODEX_PATH` is trusted without an existence/executability check; the app-server JSON-RPC protocol is undocumented/internal — any Codex update can break the handshake silently (failure surfaces only as a generic tool error + stderr tail of **800 chars**). Per-run logs grow unboundedly and contain full task text.
17. **Auto mode is a footgun:** one persisted boolean disables *both* approval layers for computer use indefinitely (no per-session scope, no timeout, no audit beyond log lines).
18. **Hidden-tool refusal model wastes turns:** a `search_memory` command that fails ShellPolicy returns an error the model must retry against; common legit patterns (quoted paths with spaces hit the forbidden-char/arg heuristics, `sort`/`uniq`/`awk`/`sed` not allowlisted at all) are simply impossible.

### 7.6 Chat / UX / persistence
19. **Tabs don't survive restart** (roadmap admits): `ChatStore` always boots to one blank tab; saved chats require manual reopening from History; open-tab set, scroll state, queue, and usage are session-only. **No conversation branching, no rename UI** (title = first 28 chars, immutable), no export/share of a chat, no global search across history except the History popover's substring filter, no pinning.
20. **No voice input, no dictation, no file attachments other than images** (no PDF/text/doc attach), no drag-in of text, input capped at 6 visible lines.
21. **Single-user, single-machine, no sync** of memory/history/settings; no import from other assistants.
22. **Accessibility/i18n:** forced dark appearance regardless of system, no localisation, zoom is the only a11y accommodation; the panel docks only to the **right edge of the mouse's screen** (no left/top docking, no free-float, no per-display memory).
23. **Feedback system is developer-centric** (writes Markdown for "a coding agent"), not a user-facing support channel.

### 7.7 Security & privacy notes (for our threat model, not moralising)
24. **Everything on screen the model asks for goes to a third-party cloud** (AX text incl. other apps' content, screenshots, `me.md`) — no on-device redaction, no per-app denylist (e.g. "never read my password manager/banking app"), no indicator when a screenshot vs text read occurred beyond a card thumbnail.
25. **Logs leak content:** `Log.info` writes Codex task text in full, tool outputs (300-char prefixes), overlay prompts (incl. full AX tree) to `logs/dshift.log` and Codex `runs/*.jsonl` — plaintext, unbounded, in the data dir. Scratchpad/feedback also persist content by design.
26. **Diagram + overlay renderers load/execute remote + model-generated code:** Mermaid from jsDelivr CDN (supply-chain + offline failure), overlay HTML runs model-written JS with `'unsafe-inline'` (CSP otherwise tight, and navigation is locked down — credit where due), scratchpad drawings run in sandboxed iframes. The overlay's 200 ms hit-area channel accepts up to 100 rects from page JS.
27. **Keychain items have no access control** (no biometric/`SecAccessControl`) and `.env` plaintext is a first-class config source; `OPENAI_API_KEY` is **not** stripped from the Codex subprocess env or the shell-runner env (only `ANTHROPIC_API_KEY` is) — a subtle asymmetry.
28. **No audit trail for approvals** (who approved what, when) beyond ephemeral card state and logs.

### 7.8 Engineering gaps
29. **Test coverage is thin and lopsided** (397 LOC): excellent for pure policies (Shell/MemoryPath/repair/SSE parsing) but zero automated coverage of AX walking, hotkeys, panel, ChatModel loop, archive round-trip, screenshot, Keychain, single-instance. Rendering tools are verified only by manual CLI modes.
30. **Docs drift from code in at least 5 places** (§8) — including the flagship computer-use invocation — suggesting no doc-vs-code check in CI (CI is lint + build + test only; no coverage gate, no release-notes automation beyond changelog extraction).
31. **No telemetry/crash reporting** (a plus for privacy, a gap for iteration), no feature flags, no remote config — every tuning change is a new binary.

---

## 8. Doc-vs-code drift register (verified)

| # | Doc claim | Code reality |
|---|---|---|
| 1 | `docs/tools.md`: computer use runs `codex exec --json --ephemeral --skip-git-repo-check --sandbox read-only -C <data dir>/codex "<task>"`; stderr at `codex/last-run-stderr.log` | `CodexRunner` runs long-lived `codex app-server` JSON-RPC; sandbox/approval are `thread/start` params; artefacts are `codex/runs/<stamp>.{jsonl,stderr.log}` (`ComputerUseTool.swift:91-176`) |
| 2 | `docs/architecture.md` + `ChatModel` comment: `read_screen` is hidden (no transcript row) | `ReadScreenTool` never sets `isHidden`; it renders a chip (§3 note) |
| 3 | `docs/architecture.md`: user turn sends `<screen>` *"only if it changed since the last send"* | No screen block is ever sent proactively; `userContent` sends the one-line `<context/>` tag **every** turn (`ChatModel.swift:550-558`) |
| 4 | README: sidebar *"hidden from screen recordings"*; architecture.md: *"Visible in user screenshots and recordings"* (self-contradictory) | `SidebarPanel` never sets `sharingType=.none`; only `take_screenshot`'s screen-scope filter excludes own windows, and the Feedback capture deliberately **includes** the sidebar. Ordinary macOS screen recording **does** capture the panel |
| 5 | README roadmap: *"Persist chat tabs across restarts"* (future) vs README feature list implying saved chats | Chats **are** archived per-turn (`ChatArchive`) and reopenable manually, but the open-tab set is never restored — both statements are half-true |
| 6 | README config table: model settings "live in `ClaudeClient.swift`: the model (`claude-opus-5-5`)" | Accurate — but the same README/tool docs omit `DSHIFT_MODEL_EFFORT`, `DSHIFT_MODEL_POLISH`, the OpenAI graphics tools, diagram, and scratchpad entirely |

---

## 9. Windows mapping — what ports 1:1, what needs a Windows-native answer

| macOS piece | Windows equivalent | Porting note |
|---|---|---|
| `NSPanel .nonactivatingPanel`, floating, all Spaces | WinUI/WPF window with `WS_EX_NOACTIVATE`, `WS_EX_TOPMOST`, virtual-desktop pinning (`IVirtualDesktopPinnedApps`) | Keep: never steal foreground; Esc = `orderOut` |
| Double-Shift via `NSEvent` global monitor | Low-level keyboard hook (`WH_KEYBOARD_LL`) watching `VK_LSHIFT/VK_RSHIFT` keyup/keydown timing | Thresholds port verbatim (250 ms tap, 400 ms gap, any-other-key reset) |
| AX tree (`AXSnapshot`) | **UI Automation** (`IUIAutomation`, TreeWalker, ControlView/ContenView) + `MSAA`/UIA properties (Name, Value, HelpText ≙ title/value/description/placeholder) | Same caps are sane defaults (3,000 nodes / 60k chars / depth 40 / 1.5 s); Windows needs an explicit secure-field (Password) filter macOS lacks |
| `AppTracker` + `AXObserver` | `SetWinEventHook` (`EVENT_SYSTEM_FOREGROUND`, `EVENT_OBJECT_NAMECHANGE`) | Keep the "has a real window ≥200×150" heuristic |
| ScreenCaptureKit screenshot | Windows Graphics Capture (`GraphicsCaptureItem` for window/display) / DXGI | Keep 1,568 px long-edge + 1-per-question policy as v1 default, add region capture |
| Keychain | Windows Credential Manager / DPAPI | Same "env → .env → vault" precedence works |
| `flock` + SIGUSR1 single-instance | Named mutex + named pipe / `WM_COPYDATA` "show yourself" message | Keep fail-open + PID-in-lockfile pattern |
| Markdown memory + allow-listed search shell | Same folder design; search via bundled `rg.exe` with an equivalent argv-policy (**no shell at all** is safer than macOS's `bash -c` + char blacklist) | Port `ShellPolicy`/`MemoryPath` *semantics*, reimplement on argv arrays, resolve reparse points/symlinks on **both** read and write paths (fixing §7.4 holes) |
| Codex `app-server` JSON-RPC | Identical — Codex CLI is cross-platform; discovery paths differ (`%LOCALAPPDATA%`, npm/bun shims, ChatGPT app bundle equivalent) | Keep elicitation forwarding + process-tree teardown (Job Objects on Windows ≙ `pgrep` tree kill, and are strictly better) |
| Menu-bar status item | System-tray icon (`Shell_NotifyIcon`) with the same 5-item menu | — |
| Ad-hoc signing warning | Unsigned SmartScreen warning is the Windows twin | Beat it: signed MSIX/installer + auto-update from v1 |

**Differentiation checklist (from §7):** OCR fallback (Windows OCR / WinML) for thin UIA trees · model picker + multi-provider (Claude/OpenAI/local) · persisted tabs/session restore · per-app privacy denylist + redaction · memory write audit log with undo · persisted usage + budgets · parallel tool execution + transient-error retry · region/multi-display screenshots · voice input · non-image attachments · left/right docking · signed auto-updating installer.

---

*End of report. Original repo was not modified. All constants verified against source at `85a6cbe`; re-verify line numbers if the upstream repo moves.*
