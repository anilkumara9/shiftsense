# D-Shift — Exact UI Specification (extracted from the original macOS Swift source)

Source of truth: `recon/original/Sources/DShift/` — `UI/ChatView.swift` (949), `UI/AgentComponents.swift` (591), `UI/HistoryAndFeedback.swift` (251), `UI/TextZoom.swift` (64), `App/SidebarController.swift` (181), `App/AppDelegate.swift` (104), `App/ResizeHandle.swift` (108), `Chat/ChatModel.swift` / `Chat/Transcript.swift` / `Chat/Usage.swift` / `Chat/SlashCommands.swift`. Every string in "quotes" is copied verbatim from code. Font sizes are **pre-zoom base sizes** — everything uses `scaledFont(size)` = size × text-zoom factor (§10).

---

## 0. Shared theme tokens (`ChatView.swift`, `Theme`)

| Token | Value |
|---|---|
| `surfaceShape` | RoundedRectangle, **corner radius 12**, continuous curve — "one radius for bubbles, cards, and the input" |
| `innerShape` | RoundedRectangle, **corner radius 8**, continuous — "a smaller one for tabs and nested media" |
| `surfaceFill` | `Color.black.opacity(0.4)` |
| `stroke` | `Color.white.opacity(0.1)` (1-pt `strokeBorder` overlays) |
| User bubble color | `Color(red: 0.0, green: 0.36, blue: 0.82).opacity(0.92)` (a saturated blue) |
| Task-card shape | RoundedRectangle **radius 18**, continuous (AgentComponents `TaskRow.shape`) |
| Code-block fill | `.black.opacity(0.3)` in `innerShape` |

**Motion tokens** (`AgentComponents.swift`): signature ease `Animation.timingCurve(0.23, 1, 0.32, 1, duration: 0.38)` named **fadeUp**; **glide** = same curve, **0.22 s**. Transition `.fadeUp` = opacity + offset(y: 8). Stated intent: ports of "Beautiful UI (beautifului.dev) primitives".

---

## 1. Window / panel (`SidebarController.swift`, `ResizeHandle.swift`)

| Property | Exact value |
|---|---|
| Class | `SidebarPanel: NSPanel`, styleMask `[.borderless, .nonactivatingPanel]`, `canBecomeKey = true` (takes keyboard input "without stealing frontmost status from the app being asked about") |
| Level / behavior | `level = .floating`; `collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]` (all Spaces + over fullscreen apps); `hidesOnDeactivate = false`; shadow **on** |
| Appearance | Forced dark: `NSAppearance(named: .darkAqua)` |
| Backdrop | `NSVisualEffectView`, material **`.hudWindow`**, blending `.behindWindow`, state `.active`, **alpha 0.85** — "Lower is more see-through. Only the backdrop fades; text and controls stay fully opaque." Backdrop gets a rounded **mask image** (radius 20) because behind-window blur ignores layer corner masks |
| Container | Layer corner radius **20 pt, continuous curve**, `masksToBounds`, border **1 pt white @ 12% alpha** |
| Default size | Width **400 pt**; height = full visible height on first show (initial contentRect 400×600, replaced by `show()` frame) |
| Min size | **300 × 320 pt**; max size = screen visible frame − 16 pt each dimension |
| Docking | **Right edge** of the screen **under the mouse** (`NSScreen.underMouse.visibleFrame`), inset **8 pt** from right/top; panel "always re-docks to the right edge" |
| Persistence | Width, height, and **top inset** (distance from screen top) saved to UserDefaults keys `sidebar.width`, `sidebar.height`, `sidebar.topInset`; restored clamped to screen |
| Toggle | `orderOut` when visible, else `show()` = `makeKeyAndOrderFront` + `focusRequest += 1` (focuses composer) |
| Esc | `cancelOperation` (NSPanel Esc) → `orderOut(nil)` — hides the panel |
| Single instance | Relaunching the app calls `showSidebar()` on the running instance instead of starting a second copy |

**Resize** (`ResizeHandle.swift`): invisible handles on **left edge (6 pt thick), top edge (6 pt), bottom edge (6 pt), top-left and bottom-left corners (24 × 24 pt)** — right edge is never draggable (docked). Opposite edges stay pinned while dragging (left drag pins right edge; bottom drag pins top). Handles are filled with **black @ 1% alpha** (any fainter and macOS passes clicks through; any pixel outside the rounded shape would square off the shadow). Cursors tracked manually (`activeAlways` tracking areas, because cursor rects only apply in the active app): left = `resizeLeftRight`, top/bottom = `resizeUpDown`, corners = macOS 15 `frameResize(topLeft/bottomLeft, .all)` else `crosshair`. Frame is saved on mouse-up only.

---

## 2. Sidebar layout — full vertical order (`SidebarView` in `ChatView.swift`)

Root is a `VStack(spacing: 0)`. Clicking any non-control area focuses the composer (`.onTapGesture { focusRequest += 1 }` — "Clicking anywhere that isn't a control puts the cursor in the input. Child buttons and tabs win").

1. **Tab strip** (§3) — always present, even on the API-key screen.
2. **Then one of:**
   - **If an API key exists:** App-context header (§4) → `Divider().opacity(0.25)` → **Chat view** (keyed `.id(store.selectedID)`, rebuilt per tab).
   - **If no key:** API-key setup screen (§8) replaces header + chat entirely.
3. **Chat view** (`ChatView`, `VStack(spacing: 0)`), top to bottom:
   1. **Transcript** (fills remaining space, §5)
   2. **Queue panel** — only when the queue is non-empty (§7)
   3. **Usage bar** (§6) — always shown
   4. **Composer / input bar** (§7)

Hidden zero-size views inject global shortcuts into the hierarchy: `TextZoomShortcuts` in the root background (§10), Cmd+W close-tab and Cmd+T new-tab in the tab strip, Cmd+Return send-now and Cmd+V paste in the composer.

---

## 3. Tab strip (`TabStrip`, `TabButton`)

- Container: `HStack(spacing: 6)`, padding **horizontal 10, top 10** (no bottom padding).
- Inside: horizontally scrolling (indicators hidden) `HStack(spacing: 4)` of tab buttons + a **"+" new-tab** icon button.
- Right side, in order: **History** button, **Feedback** button, **✕ close** button.
- **Tab button anatomy:** `HStack(spacing: 5)`, padding **9 × 5**, background in `innerShape` (radius 8): selected = white @ **13%**, hover = white @ **7%**, else clear.
  - If the chat is running: a **mini `ProgressView` spinner** at the left.
  - Title text: **11 pt**, semibold when selected / regular otherwise, 1 line, **max width 120**.
  - Close **"xmark"** (8 pt, bold, secondary): shown **only on hover or when selected**; tooltip "Close chat".
  - Tap selects; the strip's invisible **Cmd+W** closes the selected tab.
- Icon buttons (`IconButton`): SF Symbol at **11 pt semibold**, **22 × 22** hit frame, plain style, `.secondary` foreground.

| Button | SF Symbol | Tooltip (exact) | Shortcut |
|---|---|---|---|
| New chat | `plus` | "New chat (Cmd+T)" | **Cmd+T** |
| History | `clock.arrow.circlepath` | "Chat history (Cmd+Y)" | **Cmd+Y** |
| Feedback | `exclamationmark.bubble` | "Send feedback on the sidebar" | — |
| Close sidebar | `xmark` | "Hide sidebar" | (Esc also hides) |

Closing the **last** tab hides the panel (`store.onLastChatClosed` → `orderOut`). New tab title starts as **"New chat"**; on first send it becomes the **first 28 characters** of the question (`String(question.prefix(28))`).

---

## 4. Header row — current app context (`AppContextHeader`)

- `HStack(spacing: 8)`, padding **horizontal 16, vertical 9**; a `Divider` at 25% opacity sits under it.
- Left to right:
  1. **The frontmost app's own icon** (`tracker.app?.icon`), resizable, **18 × 18**.
  2. SF Symbol **`eye`** at 10 pt, secondary.
  3. **App name** (`localizedName`, fallback **"No app"**): **12 pt semibold**.
  4. **Window title** (only if non-empty): **11 pt**, secondary, 1 line, **middle truncation**.
  5. `Spacer`.
- Live-updates as the frontmost app / focused window changes (AppTracker). This header is what tells the user which app the next question is about.

---

## 5. Transcript (`TranscriptView`, `TextRow`, `AgentComponents.swift`)

- `ScrollView` with content `VStack(alignment: .leading, spacing: 12)`, **padding 14** on all sides; `defaultScrollAnchor(.bottom)`.
- **Scroll pinning:** auto-scroll follows new output **only while pinned** to the bottom; pinned = bottom marker within **viewport height + 40 pt**. Sending a message force-pins and jumps to bottom. Scrolls are deferred one runloop turn after layout.

### 5.1 Empty state (`EmptyState`)
Shown when there are no entries, top padding 4, `VStack(spacing: 6)`, 13 pt:
> **"Ask about what's on your screen."**
> "Tap Ctrl+Shift anywhere to attach the window you're on. /clear resets the chat." — 11 pt, secondary

(Yes — the string really says "Tap" for a keyboard chord; quoted as-is.)

### 5.2 User rows (`TextRow`, role `.user`)
- Right-aligned column (`padding(.leading, 40)`, frame max-width trailing), `VStack(spacing: 6)`:
  - Attachment thumbnails **first** (72-pt chips, §5.7) if any.
  - Bubble: text **13 pt, white**, `textSelection(.enabled)`, padding **11 horizontal / 7 vertical**, background = the blue user-bubble color (§0) in `surfaceShape` (radius 12). **No stroke** on user bubbles.

### 5.3 Assistant rows (`TextRow`, role `.assistant`)
- `VStack(spacing: 4)`: bubble card + (when finished) actions row.
- Bubble: padding **11 horizontal / 8 vertical**, full-width leading, background `surfaceFill` (black 40%) in `surfaceShape` **with** the white-10% stroke overlay.
- Content is split on ` ``` ` fences (`MessageSegment.split`): **prose** segments render inline markdown only (`AttributedString` `.inlineOnlyPreservingWhitespace`), **13 pt, lineSpacing 2**; **code** segments render as `CodeBlock`: horizontally scrolling, **11.5 pt monospaced**, padding 10, fill black @ 30% in `innerShape`, language tag line dropped.
- **Streaming caret:** while streaming, the last prose segment gets a trailing **" ▍"** in `.secondary`. Streaming text animates in with `.easeOut(duration: 0.4)` on the `isStreaming` change.
- **System notes / errors** are assistant `TextEntry`s whose text is wrapped in underscores by the model layer (`appendNote("_\(text)_")` → renders italic), e.g.:
  - "**Error:** \(error.localizedDescription)" — appended as "_**Error:** …_"
  - "Claude declined to answer this request." (on `refusal`)
  - "Response hit the length limit." (on `max_tokens`)
  - "Stopped after \(maxAgentIterations) steps."
  - "Unknown command \(text). Type /help for the list."
  - "Nothing to copy yet." / "Copied the last reply."
  - "Auto mode on: computer use runs without asking. Shift+Tab or /auto to turn it off." / "Auto mode off: computer use asks first."
  - Interrupted turns salvage partial text + "(Interrupted by the user.)", or "(Interrupted by the user before answering.)"

### 5.4 Streaming reveal (`Transcript.swift`, `TextEntry`)
- Incoming chunks go to a pending buffer; a **60 fps timer** (1/60 s) reveals **max(1, backlog / 8) characters per frame** — "output stays smooth and never lags far behind the network" (~133 ms behind). Each frame bumps `ScrollSignal.tick`, which keeps a pinned transcript glued to the bottom. `flush()` dumps the remainder and ends streaming.

### 5.5 Thinking indicator (`ThinkingRow`)
Shown only while running **and** not streaming text **and** no tool is active. `HStack(spacing: 10)`:
- **PixelGrid** — a 3×3 grid of **4 × 4 pt** rounded squares (corner radius 1), spacing **1.5 pt**. Each pixel pulses opacity with period **0.65 s**: `opacity = 0.15 + 0.85 × (1 − cos(phase·2π))/2`. Per-pixel delays (row-major, seconds): **[0.09, 0.18, 0.27, 0, 0.09, 0.18, 0.09, 0.18, 0.27]** — a diagonal sweep. Described in code as a "Port of Beautiful UI's loading state".
- **ShimmerText "Thinking"** — 13 pt medium; a linear gradient (white @ 40% → white → white @ 40%, stops 0.35 / 0.5 / 0.65) sweeps across with period **1.4 s**.
- **Elapsed timer** — `"%.1fs"` since turn start, **12 pt monospaced**, monospaced digits, `.tertiary`.
- Accessibility label is exactly "Thinking".

### 5.6 Tool chips and tool groups (`ToolGroup`, `ToolChip`)
Consecutive non-Codex tool calls **collapse into one group** (`TranscriptItem.group`); `use_computer` always gets its own task row (§5.8); text entries stay separate.

- **Single chip:** a capsule (`Capsule()` + surface fill + stroke), height **24**, padding leading 6 / trailing 9, `HStack(spacing: 6)`:
  - **Status icon** (14 × 14 frame, 9 pt bold): preparing/running/awaitingApproval → the PixelGrid scaled **0.75×**; succeeded → `checkmark` **green**; failed → `xmark` **red**; denied/cancelled → `nosign` secondary.
  - **Label** 12 pt medium when finished; while unfinished the label is a **LiveShimmerText**. Exact label map:
    | tool name | label (running → finished) |
    |---|---|
    | `read_screen` | "Read screen" |
    | `take_screenshot` | "Screenshot" |
    | `search_memory` | "Searched memory" |
    | `write_memory` | "Saved to memory" |
    | `make_diagram` | "Drawing diagram" → "Diagram" |
    | `web_search` | "Searching the web" → "Searched the web" |
    | `web_fetch` | "Reading page" → "Read page" |
    | anything else | the raw tool name |
  - **Summary** (if any): first present of input keys `title ?? query ?? url ?? command ?? path ?? scope`, **11 pt monospaced**, tertiary, 1 line, middle truncation.
  - Tooltip "Show details" / "Hide details"; tap toggles expansion.
- **Group header** (2+ calls): `wrench.and.screwdriver` 11 pt + **"\(count) tool calls"** 12 pt + `chevron.down` 9 pt semibold tertiary (rotated **−90°** when collapsed). Collapsed groups still surface the currently-active call as a chip beneath. Expanded chips indent **12 pt** behind a 1-pt vertical rule (`Theme.stroke`) at leading 5.
- **Expanded detail** (`ToolDetail`): two blocks — label **"Input"** then **"Output"** (10 pt semibold secondary), body = the raw JSON `inputSummary` (sorted-keys JSON) / output text **truncated to 2,000 characters** (`.prefix(2000)`), **11 pt monospaced, lineLimit 14**, text-selectable, padding 8, surface fill in `innerShape`.
- **Tool images:** a screenshot result renders under its chip: resizable, scaled-to-fit, **max height 120 collapsed / 400 expanded**, clipped to `innerShape` with stroke. `make_diagram` images instead use the full-width diagram view (click → popover up to 900 wide; context menu "Copy Image" / "Save to Downloads"; help "Click to enlarge, right-click to copy or save").
- Chips/groups expand-collapse with `.fadeUp`; status changes animate with `.fadeUp`.

### 5.7 Attachment chips (composer + user rows) (`AttachmentChip`)
- **Appshot chips** (from Ctrl+Shift / camera button): horizontal chip, `innerShape` + surface fill + stroke, padding leading 5 / trailing 10 / vertical 5: **34 × 34** thumbnail (corner radius 6) with the **source app's 16 × 16 icon badged bottom-trailing** (offset +4,+4), then app name (12 pt medium, 1 line) over window title (11 pt secondary, 1 line), text column max width 150.
- **Plain images:** bare thumbnail at the given side (72 in sent user rows, 48 in the composer).
- Hover reveals a remove button `xmark.circle.fill` (palette white / black-75%, 13 pt, offset +5,−5, help "Remove"); hover animation `.easeOut(0.12)`. Click → preview popover (image scaled-to-fit, max **520 × 420**, padding 8). Help text: "\(appName) \(windowTitle)" for appshots, else "Image". Chips appear/disappear with scale 0.85 + opacity.

### 5.8 Codex task row (`TaskRow`) and approval cards (`ApprovalCard`)

**Where approvals appear:** * inline in the transcript*, replacing the tool chip / task row for that call while status is `.awaitingApproval`. They are not sheets or system dialogs.

**Approval card anatomy** (`ApprovalCard`): `VStack(spacing: 8)`, **padding 12**, `surfaceFill` in `surfaceShape` with stroke **orange @ 35%** (the only orange-stroked element):
- Header row: title **13 pt medium** + spacer + `xmark` IconButton with help **"Deny"** (dismissing = deny).
- Detail (if non-empty): **12 pt, secondary, lineLimit 6**, text-selectable. For tools the detail is the tool's `inputSummary` JSON; for Codex it is the full task text.
- Choice rows (`VStack(spacing: 2)`): each is a full-width row, `HStack(spacing: 6)`, **13 pt**, padding **6 horizontal / 5 vertical**: SF Symbol icon in the choice tint + label (secondary → primary on hover). Hover draws a **white @ 8%** `innerShape` highlight that **glides between rows** (`matchedGeometryEffect`, `.glide` 0.22 s animation).
- **Generic tool approval** title is composed as **"Allow \(label.lowercased())?"** with exactly two choices:
  - **"Allow"** — `checkmark.circle`, tint **green**
  - **"Deny"** — `xmark.circle`, tint secondary
- **Codex task approval:** title exactly **"Let Codex do this?"**, same Allow/Deny choices.
- **Codex per-app access** (raised mid-run, inside the task row): title **"Allow Computer Use to use \(app)?"**, detail exactly **"Codex needs permission to control this app to finish the task."**, three choices:
  - **"Allow once"** — `checkmark.circle`, green
  - **"Always allow \(app)"** — `checkmark.seal`, green
  - **"Deny"** — `xmark.circle`
- **Auto mode:** if `AutoMode.isOn`, none of these cards appear for computer use ("Auto mode: always allow computer use"); Codex's own per-app questions are auto-answered "allow for this task". Codex still hard-refuses terminal apps.

**Task row** (after approval, while running/done): card in **radius-18** shape, surface fill + stroke:
- Header (height **40**, padding horizontal 10, `HStack(spacing: 8)`), tap to expand:
  - **Status badge** (20 × 20 slot): running/preparing/waiting → PixelGrid; else an 18 × 18 colored circle with a 9 pt bold white glyph — succeeded `checkmark` green, failed `xmark` red, denied/cancelled `nosign` gray.
  - **Task text** (`input["task"]`, fallback "Computer task"): 13 pt medium, 1 line.
  - **Elapsed** `"%.1fs"`, 11 pt monospaced, tertiary, ticking every **0.1 s**, freezes at finish time.
  - **Status pill** (height 20, padding horizontal 7, 11 pt medium, label color on color @ 15% capsule):
    | status | label | color |
    |---|---|---|
    | preparing / running | "Running" | blue |
    | awaitingApproval | "Waiting" | orange |
    | succeeded | "Completed" | green |
    | failed | "Failed" | red |
    | denied | "Denied" | gray |
    | cancelled | "Cancelled" | gray |
  - `chevron.down` 9 pt semibold tertiary, rotates **0° → 180°** on expand.
  - **Stop button** (only while running): `stop.fill` 9 pt in a 24 × 24 circle filled white @ 12%, help "Stop this computer task", transition scale 0.5 + opacity.
- **Expanded steps:** the **last 12 lines** of the tool output, 12 pt secondary, selectable, `VStack(spacing: 4)`, indented behind a 1-pt rule (padding leading 20, rule at 9); if no output lines yet, the task text itself is shown.

### 5.9 Message actions (`MessageActions`)
Under a **finished, non-empty, non-note** assistant reply (hidden while streaming and for "_…_" note rows): a copy button — SF Symbol `doc.on.doc` (11 pt, 22 × 22, hover-fill style) → on copy flips to `checkmark` in **green** for exactly **1.2 s** (symbol `.replace` transition). Help "Copy". Animation on streaming end: `.easeOut(duration: 0.4)`.

---

## 6. Usage bar (`UsageBar` + `ContextMeter` in `ChatView.swift`; data in `Chat/Usage.swift`)

Always visible directly **above the composer**. One line, `HStack(spacing: 10)`, **10 pt**, monospaced digits, secondary, 1 line; padding **horizontal 18, top 4** (no bottom padding — the composer supplies it).

Left → right, in exact order:
1. **Context meter + label:** a **28 × 4 pt capsule** track (white @ 12%) with a fill capsule of width `max(2, 28 × fraction)`; fill is `Color.accentColor`, turning **orange when fraction > 0.8**. Label format: **"\(percent) context"** where percent = `"<0.1%"` if 0 < f < 0.001, else percent with **1 fraction digit if f < 0.1, else 0**. Tooltip: **"\(contextTokens) of 1,000,000 tokens in the last request"** (locale-formatted numbers).
   - `contextTokens` = last request's **input + cacheRead + cacheWrite + output**; window = **1,000,000**.
2. **"\(compact) in"** — compact = session totals **input + cacheRead + cacheWrite**, compact-number notation, 0–1 fraction digits (e.g. "12.3K in").
3. **"\(compact) out"** — session total output tokens.
4. **"\(percent) cached"** — only when `requests > 0`. Cache hit rate = totals.cacheRead / (input + cacheRead + cacheWrite), same percent format. Tooltip: **"Cache reads \(…), writes \(…)"**.
5. `Spacer`.
6. **Estimated cost**, right-aligned: USD currency format, **3 fraction digits when cost < $1, else 2** (e.g. `$0.042`). Tooltip: **"Estimated at Opus 5.5 list prices over \(requests) requests"**.
   - Prices baked into `ChatUsage` ($/Mtok): **input 4.0, output 20.0, cache read 0.20, cache write 5.0** ("Claude Opus 5.5 list prices… Cache writes are the 5-minute TTL rate (1.25x input)"). Usage is per-tab, totals accumulate per API request (`message_start`/`message_delta` usage merged by overwrite), and reset on `/clear`.

---

## 7. Composer (`InputBar`, `QueueView`, `SendControls`) and queueing

- Outer container padding **12**; drop target for images/file URLs — while a drag hovers, the composer stroke turns **accentColor**. Layout: slash-command menu (if open) → composer card → auto-mode hint.
- **Composer card:** `VStack(spacing: 8)`, **padding 10**, `surfaceFill` in `surfaceShape` + stroke. Stroke becomes **orange @ 50%** while auto mode is on.
  - Attachment strip on top when attachments exist (48-pt chips §5.7, removable).
  - Field row: `HStack(spacing: 8)`:
    1. **Text field** — plain style, **13 pt**, vertical axis, **line limit 1…6 lines** (grows to 6, then scrolls). Placeholders (exact):
       - Idle: **"Ask about your screen..."**
       - While running: **"Queue a message, or Cmd+Return to send now"**
    2. **Camera button** — `camera`, help **"Appshot: attach the current window (Ctrl+Shift)"**.
    3. **Photo button** — `photo`, help **"Attach an image (or paste / drop one)"**; opens an `NSOpenPanel` (images only, multi-select).
    4. **Send controls** (below).
- **Send controls** (state machine; transitions `.fadeUp` on `isRunning`/`hasDraft`):
  - **Idle + draft:** round 24 × 24 button, `arrow.up` 10 pt bold white on a circle tinted **accentColor**, help "Send (Return)". **Idle + no draft:** same button tinted white @ 12%, disabled.
  - **Running + no draft:** only the **stop** button: round `stop.fill`, tint white @ 18%, help "Stop".
  - **Running + draft:** two pills (height 24, white @ 10% capsule, 11 pt medium, icon + label) + stop:
    - **"Queue"** — `text.append`, help "Send after the current reply (Return)"
    - **"Send now"** — `bolt.fill`, help "Interrupt and send this now (Cmd+Return)"
  - Pill appearance transition: scale 0.85 + opacity.
- **Send semantics** (`ChatModel`): **Return** = `send()` — sends immediately when idle, otherwise **appends to the queue**. **Cmd+Return** = `sendNow()` — "skips the queue, interrupting the running turn": the running turn is cancelled, partial text is salvaged as "(Interrupted by the user.)", and the new message takes over. **Stop** cancels the turn; if the queue is non-empty it becomes **paused** (does not drain). Sending with empty text but attachments asks the default question **"What do you make of this screenshot?"**.
- **Paste:** Cmd+V attaches the pasteboard image when it has no text; otherwise normal text paste (the Edit menu's Paste item deliberately has **no** key equivalent so the input bar owns Cmd+V). Images also attach via drag-and-drop and the photo picker.
- **Auto-mode hint** (directly under the composer card, a borderless button): `HStack(spacing: 4)`, 11 pt, padding horizontal 4:
  - Off: icon `hand.raised` (9 pt) + **"asks before computer use"** + "(shift+tab to cycle)" in tertiary; secondary color. Help: "Click or /auto to always allow computer use."
  - On: icon `forward.fill` + **"auto mode on"** + "(shift+tab to cycle)"; **orange**. Help: "Computer use runs without asking. Click or /auto to turn off."
  - Toggle via click, **Shift+Tab** (including the backtab U+0019 form), or **/auto**. Persisted (`UserDefaults` key `autoMode`).
- **Queue panel** (between transcript and usage bar, only when non-empty): card padding 10, surface fill + stroke, outer padding horizontal 12 / top 6, `VStack(spacing: 4)`:
  - Header: **"Queued"** or **"Queued, paused"** (11 pt semibold secondary) + Spacer + **"Resume"** button (11 pt medium, accent) shown only when paused.
  - Each queued row: text **12 pt**, 1 line, tail truncation + **"arrow.up"** icon button (help **"Send now (interrupts the current reply)"**) + **"xmark"** icon button (help **"Remove from queue"**).

### Slash commands (`SlashCommands.swift`, `CommandMenu`)
Typing `/…` (no space/newline) opens a menu **above the composer card**: card padding 4, surface fill + stroke; rows `HStack(spacing: 10)`, padding 8 × 5, highlighted row = white @ 10% in `innerShape`: command name **12 pt semibold monospaced**, fixed width **80**, + summary 12 pt secondary 1 line. **↑/↓** move the highlight (wraps); **Tab** completes the highlighted command name; **Return** runs the highlighted command. Commands (name → exact summary; `/auto`'s summary is state-dependent):
| command | summary |
|---|---|
| `/auto` | "Turn off auto mode (ask before computer use)" when on; "Auto mode: always allow computer use" when off |
| `/new` | "Start a new chat tab" |
| `/clear` | "Clear this chat" |
| `/history` | "Reopen a past chat" |
| `/copy` | "Copy the last reply" |
| `/memory` | "Open the memory folder" |
| `/help` | "List commands" |

---

## 8. API-key setup screen + settings surfaces

### 8.1 First-run setup (`APIKeySetupView`) — replaces header+chat when no key
`VStack(alignment: .leading, spacing: 12)`, **padding 16**:
1. Title: **"Add your Anthropic API key"** — 15 pt semibold.
2. Body: **"D-Shift sends your questions and screen context to Claude using your own key. The key is stored in your macOS Keychain."** — 12 pt, secondary, wraps.
3. `SecureField` placeholder exactly **"sk-ant-..."** — plain style, 13 pt, padding 10, surface fill in `surfaceShape` + stroke; Return submits.
4. Error line (only after a failed save): **"Couldn't save the key to the Keychain. Try again."** — 11 pt, red.
5. Row: Link **"Get a key"** (12 pt) → `https://console.anthropic.com/settings/keys`; Spacer; **"Save"** button, `.borderedProminent`, disabled while the trimmed field is empty. Successful save clears the field and swaps in the normal header+chat UI.

### 8.2 Changing keys later (menu bar, §9)
- **"Change API Key..."** — wipes the stored key (`APIKeyStore.shared.reset()`) and reveals the sidebar, landing the user back on the §8.1 setup screen. There is no dedicated change-key form.
- **"Set OpenAI API Key..."** — an `NSAlert`:
  - messageText: **"OpenAI API Key"**
  - informativeText: **"Used only for drawing on your screen (GPT-6.1 Sol Ultrafast). Open a new chat tab after saving. Leave empty to remove."**
  - Accessory: a 300 × 24 `NSSecureTextField`; buttons **"Save"** / **"Cancel"**; saving an empty field deletes the stored key.

### 8.3 Hidden Edit menu (never visible; exists for key equivalents)
"Undo" (Cmd+Z), "Redo" (Cmd+Shift+Z), separator, "Cut" (Cmd+X), "Copy" (Cmd+C), "Paste" (**no** shortcut — see §7), "Select All" (Cmd+A). Without it, text in replies couldn't be copied because the app is an accessory app with no menu bar.

---

## 9. Menu-bar (status item) menu (`AppDelegate.setUpStatusItem`)

Status item icon: SF Symbol **`shift`**, variable length, accessibility description "D-Shift". Menu items **in exact order**:

| # | Label (exact) | Action |
|---|---|---|
| 1 | "Toggle Sidebar (Shift Shift)" | toggle panel |
| 2 | "Open Memory Folder" | opens the memory folder in Finder |
| 3 | "Open Feedback Folder" | opens the feedback folder in Finder |
| 4 | "Change API Key..." | reset key + reveal sidebar (§8.2) |
| 5 | "Set OpenAI API Key..." | NSAlert key form (§8.2) |
| 6 | — separator — | |
| 7 | "Quit D-Shift" | Cmd+Q |

There is **no in-sidebar Settings screen** — all settings live in this menu, the auto-mode hint, slash commands, and text zoom. (First launch also triggers the system Accessibility prompt; the console fallback line is "Grant Accessibility access (System Settings > Privacy & Security > Accessibility), then relaunch.")

---

## 10. History popover + feedback UI (`HistoryAndFeedback.swift`)

### 10.1 History (`HistoryButton` → popover, arrow edge `.bottom`)
Popover content **320 × 380**, padding 10, `VStack(spacing: 8)`:
- Search field: placeholder **"Search chats"**, plain, 13 pt, padding 8, surface fill in `innerShape`. Filters by title **or any entry's text**, case-insensitive.
- Empty states: **"No saved chats yet."** (no chats) / **"No matches."** (filter) — 12 pt secondary, padding 8.
- Rows (`HistoryRow`, padding 8, hover fill white @ 7% in `innerShape`): `VStack(spacing: 2)` —
  - Title **13 pt medium**, 1 line; if the chat is currently open in a tab, a **5 × 5 accentColor dot** follows it.
  - Preview (first user text) **11 pt** secondary, 1 line.
  - Meta line **10 pt** tertiary: **"\(app) · \(relative date)"** — app name of the chat's frontmost app (omitted if nil) + `.relative(presentation: .named)` date (e.g. "2 hours ago").
  - On hover only: **trash** icon button, help "Delete chat" (deletes the archive file, animates out with `.fadeUp`).
- Tap a row: reopens that chat as a tab and closes the popover.

### 10.2 Feedback (`FeedbackButton` → popover, arrow edge `.bottom`)
Clicking first **captures a screenshot of the display the sidebar is on (sidebar included)** via ScreenCaptureKit, *then* opens the composer (width **320**, padding 12, `VStack(spacing: 8)`):
- Heading: **"What should change?"** — 13 pt medium.
- Note field: placeholder **"Describe the bug or idea..."**, plain, 13 pt, **4…10 lines**, auto-focused, padding 8, surface fill in `innerShape`.
- Screenshot toggle (only if a capture succeeded): a checkbox whose label *is* the screenshot thumbnail (height **80**, `innerShape` clip); unchecking dims it to **opacity 0.35** but keeps it visible.
- Footer row: left, **"Saved to \(path)"** with `~` substituted for the home directory — 10 pt tertiary, 1 line, **head truncation**; right, **"Save"** button, **Cmd+Return**, disabled while the note is empty/whitespace.
- Saving writes a timestamped folder under the feedback dir containing `screen.png` (if included) and `note.md` (note + "Focused app", "Chat", "Screenshot" context lines + the **last 8 transcript entries** formatted as "**User**/**Assistant**/**Tool**" lines), and appends a checkbox line to `INBOX.md`. It is a developer-facing bug-report pipe, not a support channel.

---

## 11. Keyboard shortcuts — complete table

| Shortcut | Where | Action |
|---|---|---|
| **Double-tap Shift** (tap < 250 ms, gap < 400 ms; any other key/modifier resets) | global | Toggle sidebar |
| **Ctrl+Shift** (hold; chord monitor, max hold 0.8 s) | global | Appshot: screenshot the focused window into the current chat + reveal sidebar + focus composer |
| **Esc** | panel | Hide sidebar (`cancelOperation` → orderOut) |
| **Return** | composer | Send (idle) / queue (running); run highlighted slash command if menu open |
| **Cmd+Return** | composer | Send now — interrupt current reply and take over |
| **Shift+Tab** (or backtab) | composer | Toggle auto mode |
| **Tab** | composer, command menu open | Complete highlighted command name |
| **↑ / ↓** | composer, command menu open | Move command highlight (wraps) |
| **Cmd+T** | sidebar | New chat tab |
| **Cmd+W** | sidebar | Close selected tab |
| **Cmd+Y** | sidebar | Toggle history popover |
| **Cmd+V** | composer | Paste text, or attach pasteboard image if no text |
| **Cmd+= / Cmd++** | sidebar | Text zoom in (one step) |
| **Cmd+−** | sidebar | Text zoom out (one step) |
| **Cmd+0** | sidebar | Reset text zoom to 1.0 |
| **Cmd+Return** | feedback composer | Save feedback |
| **Cmd+Q** | menu bar | Quit D-Shift |
| Cmd+Z / Cmd+Shift+Z / Cmd+X / Cmd+C / Cmd+A | hidden Edit menu | Undo / Redo / Cut / Copy / Select All (sidebar-wide text fields) |

---

## 12. Animations, zoom, and misc exact values

| Thing | Value |
|---|---|
| `.fadeUp` animation | timingCurve **(0.23, 1, 0.32, 1)**, **0.38 s** — used for entry appearance, expand/collapse, queue/send-control state changes, history row deletion |
| `.fadeUp` transition | opacity + **offset y 8** |
| `.glide` animation | same curve, **0.22 s** — approval-card hover highlight |
| Transcript list animations | `.animation(.fadeUp, value: entries.count)` and `value: isRunning` |
| Assistant bubble streaming-end animation | `.easeOut(duration: 0.4)` |
| HoverFill buttons | `.easeOut(duration: 0.1)` on hover; fills white 0% → **7%** hover → **12%** pressed |
| Attachment chip hover | `.easeOut(duration: 0.12)` |
| Thinking pixel grid | period **0.65 s**, resting opacity **0.15**, 4 pt pixels, 1.5 pt gaps, delays **[.09 .18 .27; 0 .09 .18; .09 .18 .27]** |
| Shimmer text | period **1.4 s**, gradient stops white 0.4 @0.35 → white @0.5 → white 0.4 @0.65 |
| Task-row elapsed refresh | every **0.1 s**, format `"%.1fs"` |
| Copy-button checkmark reset | **1.2 s** |
| Streaming reveal | **60 fps**, drain **backlog / 8** per frame (min 1 char) |
| **Text zoom levels** | fixed steps **[0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0]**, Cmd+= / Cmd+− step, Cmd+0 resets; persisted in UserDefaults key `textZoom`; every font in the sidebar is `base × zoom` |
| Tool detail truncation | output/input text **2,000 chars**, **14 lines** |
| Codex task expanded steps | last **12 lines** of output |
| Screenshot/attachment encode | max long edge **1568 px**, JPEG quality **0.8** on a white background; in-chip image maxHeight **120 / 400** (collapsed/expanded) |
| Forced appearance | Dark (`.darkAqua`) regardless of system; accent color = system accent (`Color.accentColor`) |

### Deliberate absences (things the original UI does *not* have)
No settings/preferences window; no model picker anywhere in the UI (model is a compile-time constant); no rename UI for tabs (title = first 28 chars of the first question); no left/top docking (right edge only, on the mouse's screen); no voice input; composer caps at 6 visible lines; the sidebar *is* included in its own feedback screenshots but its `take_screenshot` tool excludes D-Shift windows.
