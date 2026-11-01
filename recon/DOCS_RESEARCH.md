# D Shift — Current Docs Research

> Researched: 2026-11-01 (Asia/Calcutta) — pages crawled 2026-11-01 16:42 UTC unless noted.
> Purpose: Ground truth for building a Windows-first D Shift that beats the original: double-tap Shift to summon, translucent floating sidebar, no focus steal, Esc to dismiss, accessibility-first screen reading, screenshot only as fallback, local markdown memory, multi-tab chat, token/cost stats, tray/settings app, optional approval-gated Codex handoff.
> Rule: Every factual claim below carries its official source URL. Where the official docs have moved (OpenAI, Anthropic), both the entry URL and the resolving URL are noted.

---

## 0. Executive decisions for D Shift (read this first)

| Problem in the brief | Correct primitive | Why not the naive one |
|---|---|---|
| Double-tap **Shift alone** to summon | Low-level keyboard hook via `uiohook-napi` (libuiohook) in main process, OR a tiny native helper using `WH_KEYBOARD_LL` | `globalShortcut` **cannot** register a modifier-only accelerator — an Accelerator is "multiple modifier keys and a **single key code**" — Shift alone has no key code, and there is no keydown/keyup or double-tap timing. See §1.5. |
| Float without stealing focus | `focusable: false` + `win.showInactive()`; for a truly non-activating native window add `WS_EX_NOACTIVATE` via native code if Electron alone leaks focus | `win.show()` "Shows **and gives focus** to the window" — the opposite of the requirement. `showInactive()` "Shows the window but doesn't focus on it." See §1.2. |
| Translucent / lightweight look on Windows | `frame: false` + `transparent: true` **or** Windows 11 material `backgroundMaterial: 'acrylic'` (transient) / `'mica'` (long-lived) | On Windows `transparent` "does not work unless the window is frameless." Acrylic/Mica are DWM-drawn and cheaper/more native than full alpha + CSS blur. See §1.1. |
| Read screen accessibility-first | Persistent PowerShell 5.1 host + .NET `UIAutomationClient`/`UIAutomationTypes`, `AutomationElement.FromHandle(GetForegroundWindow())`, walk with `TreeWalker` / `FindAll`, read `Current.*` + `ValuePattern`/`TextPattern` | One `powershell.exe` spawn per query is 300–800 ms cold start; a long-lived host keeps tree reads in tens of ms. Screenshot is the fallback for canvas/custom-drawn UIs that expose no tree. See §2. |
| Screenshot fallback | Electron `desktopCapturer.getSources({ types: ['window','screen'], thumbnailSize })` in **main process only**, exposed to renderer via IPC | Since Electron 17 `getSources` in the renderer is removed; main-only is the supported pattern. `thumbnailSize: {0,0}` avoids paying for thumbnails you don't need. See §1.6. |
| Store API keys | `safeStorage.encryptStringAsync()` / `decryptStringAsync()` — **not** the sync API | Sync API is deprecated in Electron 45 and "will be removed in Electron 46." On Windows the key is DPAPI-protected (same-user only). See §1.7. |
| Codex handoff | Spawn `codex exec --json --sandbox read-only` (default) or `workspace-write` only after explicit user approval; never `--dangerously-bypass-approvals-and-sandbox` from the sidebar | `codex exec` defaults to read-only; Computer Use itself is **not** a CLI flag — it is a ChatGPT desktop-app plugin with its own per-app approval. Two different handoffs, two different gates. See §3. |
| Chat / cost stats | Anthropic Messages API `POST /v1/messages` with `stream: true` (SSE); cost from the response `usage` object (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`) × the pricing table in §4.3 | Don't estimate tokens client-side for billing display — the API returns cumulative usage in `message_start` / `message_delta`. See §4.1–4.3. |

User-brief contradictions to resolve in the build (not in this doc): the brief says "Windows app" and also "keep a local memory **on my Mac** in plain markdown" + "menu bar app." On Windows the equivalent is a **system-tray app** (notification area), not a menu bar. Memory location should be a user-visible folder (e.g. `%USERPROFILE%\DShift\memory\` or a folder the user picks) with the same plain-markdown design. Flag this in the product spec — do not silently ship macOS paths on Windows.

---

## 1. Electron — window, tray, shortcuts, capture, secrets

Current docs home: https://www.electronjs.org/docs/latest/ — `BrowserWindow` constructor options now live on `BaseWindowConstructorOptions` (BrowserWindow extends BaseWindow).

### 1.1 Transparent, frameless, translucent

- `transparent: boolean` — "Makes the window transparent. Default is `false`. **On Windows, does not work unless the window is frameless.** When you add a `View` to a `BaseWindow`, you'll need to call `view.setBackgroundColor` with a transparent background color on that view to make its background transparent as well."
  Source: https://www.electronjs.org/docs/latest/api/structures/base-window-options
- `frame: boolean` — "Specify `false` to create a frameless window. Default is `true`."
  Source: https://www.electronjs.org/docs/latest/api/structures/base-window-options
- `backgroundColor: string` — Hex/RGB/RGBA/HSL/HSLA/named; "Alpha in #AARRGGBB format is supported if `transparent` is set to `true`. Default is `#FFF`."
  Source: https://www.electronjs.org/docs/latest/api/structures/base-window-options
- `opacity: number` *macOS/Windows* — "Set the initial opacity of the window, between 0.0 (fully transparent) and 1.0 (fully opaque)."
  Source: https://www.electronjs.org/docs/latest/api/structures/base-window-options
- Windows 11 materials (prefer these for the "translucent and lightweight" ask):
  - `backgroundMaterial: string` *Windows* — "Set the window's system-drawn background material, including behind the non-client area. Can be `auto`, `none`, `mica`, `acrylic` or `tabbed`."
  - Runtime: `win.setBackgroundMaterial(material)` — `mica` = "backdrop material effect corresponding to a long-lived window", `acrylic` = "corresponding to a transient window", `tabbed` = tabbed title bar.
  Source: https://www.electronjs.org/docs/latest/api/structures/base-window-options and https://www.electronjs.org/docs/latest/api/base-window
- macOS equivalent (if a Mac build is ever kept): `vibrancy: string` *macOS only* (`sidebar`, `hud`, `popover`, `under-window`, etc.) + `visualEffectState`. Do **not** use `backgroundMaterial` for macOS vibrancy — it is Windows-only.
  Source: https://www.electronjs.org/docs/latest/api/structures/base-window-options
- Frameless/transparent tutorial limitations (older mirror, still accurate): cannot click through the transparent area without `win.setIgnoreMouseEvents(true)`; transparent windows are not resizable on some platforms (setting `resizable: true` may break them); the CSS `blur` filter blurs only the web page, not content below the window; on Windows transparent windows don't work when DWM is disabled.
  Source: https://www.electronjs.org/docs/latest/tutorial/keyboard-shortcuts/ (tutorial index) — frameless details via BaseWindow options above; click-through via `setIgnoreMouseEvents` in BrowserWindow docs: https://www.electronjs.org/docs/latest/api/browser-window

**D Shift recipe (Windows sidebar):**
```js
new BrowserWindow({
  frame: false,
  transparent: true,            // OR backgroundMaterial: 'acrylic' — pick ONE translucency strategy, test both
  backgroundMaterial: 'acrylic', // Windows 11 transient material; remove if using pure transparent:true
  hasShadow: true,
  resizable: false,             // avoids transparent-window resize breakage
  skipTaskbar: true,
  alwaysOnTop: true,
  focusable: false,             // see §1.2 — pair with showInactive(); add an explicit "focus on demand" path for typing (see caveat)
  show: false,
  webPreferences: { contextIsolation: true, sandbox: true, preload: '<abs path>' }
})
```
Caveat — focusable tradeoff: a `focusable: false` window cannot receive keyboard input. The original's pattern (and the correct one) is two states: **peek state** = `focusable:false` + `showInactive()` (answers render, host app keeps focus, UIA still reads the *previous* foreground window); **interact state** = when the user clicks/types in D Shift, call `win.setFocusable(true)` + `win.focus()` deliberately, and restore on Esc/hide. Document this state machine — a single static `focusable:false` window cannot host a chat input.

### 1.2 Always-on-top + non-focus-stealing

- `alwaysOnTop: boolean` — "Whether the window should always stay on top of other windows. Default is `false`. Not supported on Wayland (Linux)."
  Source: https://www.electronjs.org/docs/latest/api/structures/base-window-options
- Runtime control: `win.setAlwaysOnTop(flag[, level][, relativeLevel])`, `win.isAlwaysOnTop()`, event `'always-on-top-changed'`. Levels include `normal`, `floating`, `modal-panel`, `status`, `pop-up-menu`, `screen-saver`, `dock` — use `screen-saver`/`pop-up-menu` level only if the sidebar must stay above full-screen apps, and expect more OS pushback.
  Source: https://www.electronjs.org/docs/latest/api/browser-window
- `focusable: boolean` — "Whether the window can be focused. Default is `true`. **On Windows setting `focusable: false` also implies setting `skipTaskbar: true`.** On Linux setting `focusable: false` makes the window stop interacting with wm, so the window will always stay on top in all workspaces."
  Source: https://www.electronjs.org/docs/latest/api/structures/base-window-options
- Runtime: `win.focusable` property (*Windows/macOS*), `win.setFocusable(focusable)` (*macOS/Windows*), `win.isFocusable()`.
  Source: https://www.electronjs.org/docs/latest/api/browser-window
- Show methods — the distinction that matters:
  - `win.show()` — "Shows **and gives focus** to the window."
  - `win.showInactive()` — "Shows the window but **doesn't focus on it**. Not supported on Wayland (Linux)."
  - `win.hide()`, `win.isVisible()`
  Source: https://www.electronjs.org/docs/latest/api/browser-window
- Graceful first paint: create with `show: false`, show on `'ready-to-show'` to avoid a visual flash.
  Source: https://www.electronjs.org/docs/latest/api/browser-window

**Win32 truth underneath (`WS_EX_NOACTIVATE`):** Electron does not expose this style by name. The native semantic is:
- `WS_EX_NOACTIVATE 0x08000000L` — "A top-level window created with this style **does not become the foreground window when the user clicks it**. The system does not bring this window to the foreground when the user minimizes or closes the foreground window. The window should not be activated through programmatic access or via keyboard navigation by accessible technology, such as Narrator. To activate the window, use the `SetActiveWindow` or `SetForegroundWindow` function. The window does not appear on the taskbar by default."
- Related: `WS_EX_TOPMOST 0x00000008L` (stay above non-topmost even when deactivated; toggle via `SetWindowPos`), `WS_EX_TOOLWINDOW 0x00000080L` (floating toolbar, no taskbar / no Alt+Tab entry).
  Source: https://learn.microsoft.com/en-gb/windows/win32/winmsg/extended-window-styles
- `CreateWindowEx` remarks: "`WS_EX_NOACTIVATE` prevents foreground activation by the system. To prevent queue activation when the user clicks on the window, you must process the `WM_MOUSEACTIVATE` message appropriately."
  Source: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-createwindowexa

Implication: if `focusable:false` + `showInactive()` still steals foreground in testing (some Electron/Windows builds do on click), the escalation is a small native addon / helper that sets `GWL_EXSTYLE |= WS_EX_NOACTIVATE` on the Electron HWND (`win.getNativeWindowHandle()`) and handles `WM_MOUSEACTIVATE -> MA_NOACTIVATE`. Budget for this helper — do not promise pure-JS no-activate on click without testing it.

### 1.3 Esc to close / hide

- `Escape` (alias `Esc`) is a valid Accelerator key code, alongside `Return/Enter`, `Tab`, `Space`, `F1–F24`, etc.
  Source: https://www.electronjs.org/docs/latest/tutorial/keyboard-shortcuts/
- For an already-focused sidebar, prefer renderer `keydown`/`keyup` via `addEventListener` or main-process `webContents.on('before-input-event', (event, input) => ...)` interception (the docs' pattern for Ctrl+I generalises to Esc) over a global Esc registration — a global Esc would swallow Esc from every other app.
  Source: https://www.electronjs.org/docs/latest/tutorial/keyboard-shortcuts/
- Hide, don't destroy, on Esc: `win.hide()` keeps the summon latency low; destroy only on quit from the tray.

### 1.4 System tray / menu-bar equivalent (Windows notification area)

- `Tray` — "Add icons and context menus to the system's notification area." Process: Main. `Tray` is an `EventEmitter`; construct only after `app.whenReady()`.
  Pattern: `tray = new Tray(icon)` (NativeImage or path; **ICO recommended on Windows**), `Menu.buildFromTemplate([...])`, `tray.setContextMenu(contextMenu)`, `tray.setToolTip('...')`.
  Source: Tray tutorial https://www.electronjs.org/docs/latest/tutorial/tray and API notes via https://www.electronjs.org/docs/latest/api/structures/base-window-options (cross-refs) — full API: `tray.setImage`, `tray.setPressedImage` (macOS), `tray.setToolTip(toolTip)`, `tray.setTitle` (macOS), `tray.popUpContextMenu([menu, position])`, `tray.setContextMenu(menu)`, `tray.displayBalloon` (Windows).
- Tray tutorial specifics: on Windows the icon lives "in the notification area at the end of the taskbar"; on macOS in menu-bar extras. To keep the app + tray alive when all windows close, handle `app.on('window-all-closed')` and do **not** quit on Windows/Linux. Tray context menus do not need manual `menu.popup` instrumentation — the Tray object handles clicks.
  Source: https://electronjs.org/fr/docs/latest/tutorial/tray (tutorial, FR locale URL returned by search; EN canonical: https://www.electronjs.org/docs/latest/tutorial/tray)
- Platform caution from the API docs: don't rely on the Tray `click` event for identical cross-platform behaviour — always attach a context menu. On Linux, re-call `setContextMenu` after mutating items.
  Source: Tray API (mirrored at https://ayakael.net/mirrors/electron/src/commit/90410e0419d71d854e5982a219fa6789765980a7/docs/api/tray.md — cite the electronjs.org canonical in code comments).

**D Shift tray menu (minimum):** Show/Hide Sidebar · Settings… (API keys, model, hotkey, memory folder) · Open Memory Folder (`shell.openPath`) · Pause/Resume Screen Reading · Quit. Keep a module-level `let tray` reference — a GC'd Tray disappears.

### 1.5 Global shortcuts — limits, and the double-tap-Shift workaround

`globalShortcut` (Main process only, after `ready`):
- "Detect keyboard events when the application does not have keyboard focus." `globalShortcut.register(accelerator, callback) -> boolean`, `registerAll`, `isRegistered`, `unregister`, `unregisterAll`, `setSuspended`. "The shortcut is global; it will work even if the app does not have the keyboard focus. This module cannot be used before the `ready` event." If the accelerator is already taken, registration "will silently fail." Always `unregisterAll()` on `will-quit`.
  Source: https://az.electronjs.org/docs/latest/api/global-shortcut (electronjs.org mirror) — canonical: https://www.electronjs.org/docs/latest/api/global-shortcut
- Tutorial form: `globalShortcut.register('CommandOrControl+Alt+R', () => {...})`, `globalShortcut.unregister('...')`.
  Source: https://www.electronjs.org/docs/latest/tutorial/keyboard-shortcuts/

**Why it cannot do the brief's trigger:**
- Accelerator grammar: "These strings can contain **multiple modifier keys and a single key code** joined by the `+` character." Modifiers: `Command/Cmd`, `Control/Ctrl`, `CommandOrControl/CmdOrCtrl`, `Alt`, `Option`, `AltGr`, `Shift`, `Super/Meta`. Key codes are non-modifier keys (`A–Z`, `0–9`, `F1–F24`, punctuation, `Space`, `Tab`, `Return`, `Escape`, `PrintScreen`, numpad, media keys…).
  Source: https://www.electronjs.org/docs/latest/tutorial/keyboard-shortcuts/
- Therefore: there is **no** Accelerator for "Shift alone", no keyup event, no press-count / double-tap timing, and no left-vs-right Shift distinction. `Shift+Shift`, `Shift` alone, and double-tap are all inexpressible. Any design that starts with `globalShortcut.register('Shift', ...)` is dead on arrival.
- Fallback global shortcut still worth registering as an accessibility alternative: e.g. `CommandOrControl+Shift+Space` or `Alt+Space` — a real modifier+keycode combo — for users/keyboards where the hook fails.

**Workaround A (recommended, pure Electron/Node): `uiohook-napi`**
- "N-API C-bindings for libuiohook." API: `uIOhook.on('keydown'|'keyup'|'input'|...)`, `uIOhook.start()`, `keyTap(key, modifiers?)`, `keyToggle(key, 'down'|'up')`. Keyboard event shape: `{ altKey, ctrlKey, metaKey, shiftKey, keycode }`, with a `UiohookKey` enum (incl. `Escape`, `Shift`, etc.).
  Source: https://socket.dev/npm/package/uiohook-napi (npm package readme/API) — package: `uiohook-napi` on npm.
- Implementation sketch: listen to Shift keydown/keyup; a "tap" = keydown+keyup with no other key in between and duration < ~300 ms; two taps within ~350–400 ms = summon. Debounce auto-repeat (keydown repeats while held — ignore repeats where the key was already down). Run the hook in the main process; stop it on quit. Risks to test: native-module rebuild per Electron ABI (`electron-rebuild`), Windows Defender / AV suspicion of global hooks, and that the hook sees **all** keystrokes — the handler must inspect only Shift timing and discard everything else immediately (privacy + store nothing).

**Workaround B (most robust on Windows, more code): native helper with `WH_KEYBOARD_LL`**
- `SetWindowsHookEx(WH_KEYBOARD_LL, ...)` installs a system-wide low-level keyboard hook that sees events regardless of focus; pair with `GetAsyncKeyState(VK_SHIFT / VK_LSHIFT / VK_RSHIFT)` for modifier state and `CallNextHookEx` to pass events on. This is the mechanism libuiohook itself wraps on Windows.
  Source (mechanism overview): https://deepwiki.com/wh152/Keylogger/2.1-keyboard-hook-system — treat as secondary; primary Win32 refs are `SetWindowsHookEx` / `WH_KEYBOARD_LL` on Microsoft Learn (search at build time for the exact Learn URLs and pin them in code comments).
- Ship B only if A fails the ABI/packaging tests. Either way, the double-tap detector is your code — neither API offers "double-tap" as a primitive.

### 1.6 Screenshot fallback — `desktopCapturer`

- "`desktopCapturer` — Access information about media sources that can be used to capture audio and video from the desktop using the `navigator.mediaDevices.getUserMedia` API. **Process: Main**."
  Source: https://www.electronjs.org/docs/latest/api/desktop-capturer
- Only method: `desktopCapturer.getSources(options) -> Promise<DesktopCapturerSource[]>`:
  - `options.types: string[]` — `screen` and/or `window`.
  - `options.thumbnailSize: Size` (optional) — default `150 x 150`. "Set width or height to 0 when you do not need the thumbnails. This will save the processing time."
  - `options.fetchWindowIcons: boolean` (optional) — default `false`; `appIcon` is `null` for `screen` sources.
  Each source has `id`, `name` (window title or `Entire Screen`/`Screen <index>`), `thumbnail` (NativeImage), `display_id`, `appIcon`.
  Source: https://www.electronjs.org/docs/latest/api/desktop-capturer
- Modern capture flow: main process installs `session.defaultSession.setDisplayMediaRequestHandler((request, callback) => { desktopCapturer.getSources({ types: ['screen'] }).then(sources => callback({ video: sources[0], audio: 'loopback' })) }, { useSystemPicker: true })`; the renderer then calls `navigator.mediaDevices.getDisplayMedia(...)`. `getDisplayMedia` does not permit `deviceId` source selection.
  Source: https://www.electronjs.org/docs/latest/api/desktop-capturer
- Breaking-change history: "`desktopCapturer.getSources` in the renderer" was deprecated (15.0) and **removed (17.0)** — "now only available in the main process… replaced as follows: `ipcMain.handle('DESKTOP_CAPTURER_GET_SOURCES', (event, opts) => desktopCapturer.getSources(opts))`" with a warning to restrict what you return to the renderer (e.g. return only the user-selected source).
  Source: https://github.com/classicvalues/electronjs.org-new/blob/HEAD/docs/latest/breaking-changes.md
- Still-image shortcut for D Shift: for a one-shot screenshot you don't need a video stream — call `getSources({ types: ['window'], thumbnailSize: { width: 1920, height: 1080 } })` (size = target window's scaled size) and use `source.thumbnail.toPNG()/toDataURL()`. Match the source by `name`/window id to the UIA foreground window; if no match, fall back to `types: ['screen']`.
- Consent: "Capturing the screen contents requires user consent on macOS 10.15 Catalina or higher, which can [be] detected by `systemPreferences.getMediaAccessStatus`." (Windows has no equivalent Electron consent gate — your own in-app toggle is the gate.)
  Source: https://www.electronjs.org/docs/latest/api/desktop-capturer

Policy for D Shift: screenshot **only** when (a) UIA returned an empty/sparse tree, (b) the focused element is canvas/custom-drawn, or (c) the user's question is explicitly visual ("what does this chart show?"). Log which path answered each question — that's the "accessibility-first" proof.

### 1.7 API-key storage — `safeStorage`

- "`safeStorage` — Allows access to simple encryption and decryption of strings for storage on the local machine… by using OS-provided cryptography systems. Process: Main."
  Source: https://www.electronjs.org/docs/latest/api/safe-storage
- **Deprecation (critical, current):** "The synchronous API (`isEncryptionAvailable`/`encryptString`/`decryptString`) is **deprecated and will be removed in Electron 46**. Use the asynchronous API (`isAsyncEncryptionAvailable`/`encryptStringAsync`/`decryptStringAsync`), which is non-blocking, supports key rotation, and handles temporary unavailability gracefully." Deprecated since >= 45.0.0. Data encrypted with the sync method can be decrypted with `decryptStringAsync`.
  Source: https://www.electronjs.org/docs/latest/api/safe-storage and release note https://www.electronjs.org/blog/electron-45-0
- Async API:
  - `safeStorage.isAsyncEncryptionAvailable() -> Promise<boolean>` (encryptor initialises lazily on first async call after `ready`).
  - `safeStorage.encryptStringAsync(plainText) -> Promise<Buffer>`
  - `safeStorage.decryptStringAsync(encrypted) -> Promise<{ result: string, shouldReEncrypt: boolean, ... }>` — note it resolves to an **object**, not a string; honour `shouldReEncrypt` (key rotated / better key available).
  Source: https://www.electronjs.org/docs/latest/api/safe-storage
- Platform semantics:
  - **Windows:** keys "generated via DPAPI… only a user with the same logon credential… can typically decrypt the data. Therefore, content is protected from **other users** on the same machine, **but not from other apps running in the same userspace**."
  - **macOS:** keys in Keychain, protected from other users and other apps (user can override); app should be code-signed or Keychain may re-prompt on every update.
  - **Linux:** keys in `kwallet`/`kwallet5`/`kwallet6`/`gnome-libsecret` or, for the async API, the freedesktop Portal Secret / Secret Service; **if no secret store is available, data is encrypted via a hardcoded plaintext password** — detect via `safeStorage.getSelectedStorageBackend() === 'basic_text'` (*Linux only*) and warn/refuse.
  Source: https://www.electronjs.org/docs/latest/api/safe-storage
- Usage rule for D Shift: encrypt in the main process only; store only the ciphertext Buffer (base64) in settings JSON under `userData`; never send decrypted keys to the renderer except over a narrow IPC call at request time, and never log them. Check `isAsyncEncryptionAvailable()` before the first save.

---

## 2. Windows UI Automation (UIA) — accessibility-first screen reading

Managed API: `System.Windows.Automation` (`UIAutomationClient` + `UIAutomationTypes` assemblies, .NET Framework — ships with Windows; no SDK/VS install needed for PowerShell 5.1 use). Native equivalent: `IUIAutomation` COM (UIA3 via FlaUI if the project later moves to a compiled helper).

### 2.1 Core model

- "`AutomationElement` — Represents a UI Automation element in the UI Automation tree… An `AutomationElement` corresponds to a piece of user interface (UI), **regardless of underlying implementation** (such as WPF or Win32)."
  Source: https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.automationelement?view=windowsdesktop-5.0
- Entry points on `AutomationElement`:
  - `RootElement` — "Gets the root AutomationElement for the current desktop."
  - `FocusedElement` — "Gets the AutomationElement that currently has focus."
  - `FromHandle(IntPtr)` — "Retrieves a new AutomationElement object for the UI item referenced by the specified window handle."
  - `FromPoint(Point)`, `FindFirst(TreeScope, Condition)`, `FindAll(TreeScope, Condition)`.
  Source: https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.automationelement?view=windowsdesktop-5.0 (methods/properties lists; FormHandle row via search index of the same page)
- Traversal: `TreeWalker` (`ControlViewWalker`, `ContentViewWalker`, `RawViewWalker`) — `GetParent`, `GetFirstChild`, `GetNextSibling`, etc. Use ControlView for the user-meaningful tree; RawView is bigger and noisier.
  Source: pattern in §2.4 refs; class docs on Microsoft Learn under `System.Windows.Automation.TreeWalker` (pin exact URL at build time).

### 2.2 Element properties to extract (per element)

Via `element.Current` (live values) or `element.Cached` (bulk-cached snapshot — prefer Cached + a `CacheRequest` for whole-tree walks, it is far fewer cross-process calls). The property struct is `AutomationElement.AutomationElementInformation`: "The properties can be accessed directly from Cached and Current… [or] by using `GetCurrentPropertyValue` and `GetCachedPropertyValue`, using the corresponding identifiers from `AutomationElement`."
Source: https://learn.microsoft.com/hu-hu/dotnet/api/system.windows.automation.automationelement.automationelementinformation?view=netframework-4.5.2 (EN canonical: https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.automationelement.automationelementinformation)

| Property (Current.*) | Identifier | Use in D Shift |
|---|---|---|
| `Name` | `NameProperty` | Visible label/text of the control — primary context string. |
| `ControlType` | `ControlTypeProperty` | `Button`, `Edit`, `Document`, `Text`, `ListItem`, `TabItem`, `Window`, … — serialise as `ControlType.ProgrammaticName` (e.g. `ControlType.Edit`) or `LocalizedControlType`. |
| `LocalizedControlType` | `LocalizedControlTypeProperty` | Human-readable type in the user's locale. |
| `BoundingRectangle` | `BoundingRectangleProperty` | "Gets the coordinates of the rectangle that completely encloses the element." Physical pixels (see DPI warning §2.5). Its centre = click point if action is ever needed. |
| `ClassName` | `ClassNameProperty` | Framework class (e.g. `Chrome_RenderWidgetHostHWND`) — useful for detecting web content. |
| `AutomationId` | `AutomationIdProperty` | Stable id within the app, when present. |
| `FrameworkId` | (on the info struct) | `WPF`, `Win32`, `WinForm`, `XAML`, `Chrome`… — tells you how much to trust the tree. |
| `IsEnabled`, `IsOffscreen`, `HasKeyboardFocus`, `IsKeyboardFocusable` | corresponding properties | Filter: drop `IsOffscreen == true` nodes for the "what's on screen" summary; keep the `HasKeyboardFocus` chain as the user's current locus. |
| `NativeWindowHandle` | (info struct) | Bridge back to Win32 HWND. |
| `ProcessId` | (info struct) | Attribute the tree to an app (`Get-Process -Id`). |

Source for the property names/descriptions: https://learn.microsoft.com/hu-hu/dotnet/api/system.windows.automation.automationelement.automationelementinformation?view=netframework-4.5.2 and https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.automationelement?view=windowsdesktop-5.0

**Value / text content (patterns, not properties):**
- Control patterns overview: "UI Automation uses control patterns to represent common control behaviors… you use the Invoke control pattern for controls that can be invoked (such as buttons) and the Scroll control pattern for controls that have scroll bars." Key patterns for reading:
  - `ValuePattern` (`IValueProvider`) — "Allows clients to get or set a value on controls that do not support a range of values." Read via `TryGetCurrentPattern(ValuePattern.Pattern, out obj)` → `((ValuePattern)obj).Current.Value`. This is the text of most `Edit`/combo controls.
  - `TextPattern` (`ITextProvider`) — "Used for edit controls and documents that expose textual information." Use `DocumentRange.GetText(-1)` for document bodies and `GetSelection()` for the user's current selection.
  - `RangeValuePattern`, `TogglePattern`, `SelectionItemPattern`, `WindowPattern` (`Current.WindowVisualState` — Normal/Minimized/Maximized), `InvokePattern` (act, only if D Shift ever clicks by name).
  Source: https://learn.microsoft.com/en-gb/dotnet/framework/ui-automation/ui-automation-control-patterns-overview
- Mutual-exclusion gotcha (from Microsoft's own sample docs): elements that support `TextPattern` generally do **not** support `ValuePattern`, and `TextPattern` cannot set multi-line/document text — try Value first, fall back to Text, fall back to `Name`. Password fields: never emit their Value (check `Current.IsPassword`).
  Source: https://learn.microsoft.com/ko-kr/dotnet/framework/ui-automation/add-content-to-a-text-box-using-ui-automation (sample discussion; EN page: Add content to a text box using UI Automation on Microsoft Learn)

### 2.3 Foreground / focused window — the read pipeline

1. **Foreground HWND (Win32):** P/Invoke `user32!GetForegroundWindow()` → `IntPtr hwnd`. (No managed UIA equivalent for "foreground" itself; UIA gives you FocusedElement and RootElement, Win32 gives you the foreground HWND.)
2. **Window element:** `AutomationElement.FromHandle(hwnd)`.
3. **Focused element:** `AutomationElement.FocusedElement` (system-wide focus) — walk its ancestor chain to confirm it lives inside the foreground window; the focused element + its siblings/ancestors are the highest-value context.
4. **Tree walk:** bounded DFS from the window element using `TreeWalker.ControlViewWalker` or `FindAll(TreeScope.Descendants, Condition.TrueCondition)` with a `CacheRequest`. Bound it: max depth (~12–20), max nodes (~300–800), skip `IsOffscreen`, collapse duplicate `Name`s. A full unbounded walk of a browser/IDE can return tens of thousands of nodes and will blow the LLM context — the cap + summarisation **is** the product advantage over a screenshot (a window should serialise to a few hundred tokens of role/name/value lines).
5. **Serialise** each kept node as one line: `[index] ControlType "Name" value="…" rect=x,y,w,h focused?` — the index doubles as a stable handle if the user later asks to act on it.

### 2.4 PowerShell host pattern (no compiled code required)

```powershell
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
# + a tiny C# Add-Type for GetForegroundWindow / DPI awareness (user32 P/Invoke)

$hwnd = [Win32]::GetForegroundWindow()
$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
$focused = [System.Windows.Automation.AutomationElement]::FocusedElement
# $el.Current.Name / .ControlType.ProgrammaticName / .BoundingRectangle
# $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)
```
- `Add-Type -AssemblyName @('UIAutomationClient','UIAutomationTypes')`, `AutomationElement.RootElement`, `PropertyCondition(AutomationElement.NameProperty, "…")`, `FindFirst(TreeScope.Descendants, $condition)` — the canonical PowerShell shape.
  Source: https://github-wiki-see.page/m/auto-mate/CheatSheetWiki/wiki/Powershell (community wiki — the API surface it demonstrates is the Microsoft Learn surface above)
- `AutomationElement.FromHandle($process.MainWindowHandle)` + `WindowPattern` for window state is the standard PowerShell idiom.
  Source: http://vcloud-lab.com/entries/powershell/powershell-find-application-window-state-minimized-or-maximized (community; pattern class is Microsoft Learn's `WindowPattern`)
- **Keep one PowerShell host alive:** spawn `powershell.exe -NoProfile -NoExit` once from Electron, speak line-delimited JSON over stdin/stdout. Cold start per call is the difference between "instant sidebar" and a spinner. Use Windows PowerShell 5.1 (`powershell.exe`), not `pwsh` — the Framework UIA assemblies + WinRT helpers in this space target 5.1.
- Keep the `.ps1` **pure ASCII**: PowerShell 5.1 reads a BOM-less script as the system ANSI code page; non-ASCII literals corrupt parsing. All user text arrives as runtime JSON data (UTF-8), never as source literals. (Field lesson from existing Windows UIA tooling; verify with a non-ASCII window title in tests.)

### 2.5 DPI, integrity, and other traps

- **DPI awareness first:** declare Per-Monitor-Aware V2 in the host process **before** any UIA/screenshot/mouse call. UIA returns physical pixels; an unaware process gets virtualised coordinates and every rect/click is wrong on scaled displays — silently.
- **UIPI / integrity levels:** a medium-integrity reader cannot read elevated (admin) windows' trees in full. Detect empty trees on elevated foreground windows and say so, don't hallucinate from a screenshot of a UAC-isolated app.
- **Minimised windows:** the UIA tree survives minimisation but rects go far off-screen / clicks are meaningless. Check `WindowPattern.Current.WindowVisualState` and treat minimised ≠ on-screen.
- **Empty-tree apps:** games, canvas apps, some custom-drawn UIs, and un-woken Chromium (next section) expose nothing. That emptiness is the screenshot trigger — by design.

### 2.6 Waking Chromium / Electron accessibility (Chrome, Edge, VS Code, Slack, Discord…)

Chromium builds its web accessibility tree **lazily** — only when it believes assistive technology is present. Until then UIA sees a shell with almost no children.

- Chromium design doc: "For performance reasons Chromium waits until it detects the presence of assistive technology before enabling full support for accessibility APIs. Windows: Chrome calls `NotifyWinEvent` with `EVENT_SYSTEM_ALERT` and the custom object id of 1. If it subsequently receives a `WM_GETOBJECT` call for that custom object id, it assumes that assistive technology is running." Overrides: "(1) Start Chrome with this flag: `--force-renderer-accessibility` (2) Or, visit `chrome://accessibility` to turn it on."
  Source: https://chromium.googlesource.com/experimental/website/+/816bdcef00b192b2e7de9ea5a3c8072beddcd2e5/site/developers/design-documents/accessibility/index.md
- Chromium accessibility overview: "`--force-renderer-accessibility=[basic|form-controls|complete]` — Force accessibility to be enabled, with optional parameter to force the AXMode… If the optional parameter is missing, then the AXMode will initially default to `complete`… `--disable-renderer-accessibility` — Disable accessibility." Windows API support: MSAA/IAccessible (complete), IAccessible2 (mostly complete), UIA via the browser-process cache of the renderer AX tree.
  Source: https://chromium.googlesource.com/chromium/src/+/dbe988530fa28e2f425a03c28624dabe8571a076/docs/accessibility/overview.md
- Practical waking without relaunching: a genuine UIA client querying the Chrome window (especially requesting the full tree / listening for focus events) usually **is** the AT signal and wakes the tree after a short delay — retry the walk once after ~300–800 ms before declaring "empty" and screenshotting. Relaunching the user's browser with `--force-renderer-accessibility` is **not** acceptable UX for D Shift; treat the flag as documentation of the mechanism, and as an opt-in for apps D Shift itself launches.
- Electron apps specifically: an Electron app's own renderer accessibility follows the same Chromium rule; an app can force it for **itself** with `app.setAccessibilitySupportEnabled(true)` / the `--force-renderer-accessibility` command-line switch. D Shift should set this on **its own** windows so other AT (and its own tests) can read the sidebar.
- Cost of waking: the browser keeps the AX tree alive while a client is attached (extra memory/CPU for that browser). That's the accepted price of tree-first reading; release UIA event handlers when the sidebar hides for a long idle period if profiling shows it matters.

---

## 3. OpenAI Codex CLI — non-interactive handoff + Computer Use

Docs have moved: `developers.openai.com/codex/*` is the stable entry; pages now resolve under ChatGPT Learn (`learn.chatgpt.com/docs/*`). Cited below by their `developers.openai.com` entry URLs as returned 2026-11-01.

### 3.1 `codex exec` — the scriptable entry point

- "Non-interactive mode lets you run Codex from scripts (for example, CI jobs) without opening the interactive TUI. You invoke it with `codex exec`." Alias: `codex e`. Stable.
  Source: https://developers.openai.com/codex/autofix-ci/ (Non-interactive mode) and Developer commands https://developers.openai.com/codex/cli/slash-commands/
- Invocation forms:
  - `codex exec "<prompt>"` — prompt as argument.
  - Piped stdin + prompt arg — prompt = instruction, piped content = additional context (`<stdin>` block).
  - `codex exec -` — stdin **is** the full prompt. (No `--prompt-file` flag — use stdin.)
  - `codex exec resume --last "<follow-up>"` / `codex exec resume <SESSION_ID> "<...>"` — continue a session.
  Source: https://developers.openai.com/codex/autofix-ci/
- Output contract: "While `codex exec` runs, Codex streams progress to `stderr` and prints only the final agent message to `stdout`." — pipe-friendly by design.
  Source: https://developers.openai.com/codex/autofix-ci/
- Key flags (flag-level detail lives on the linked `codex exec` reference from that page):
  | Flag | Meaning |
  |---|---|
  | `-s, --sandbox <mode>` | `read-only` (default for `exec`) \| `workspace-write` \| `danger-full-access` |
  | `--json` | stdout becomes JSON Lines (see §3.2) |
  | `-o, --output-last-message <path>` | Also write the final message to a file (still prints to stdout) |
  | `--output-schema <path>` | Final response must conform to this JSON Schema |
  | `--ephemeral` | Don't persist session rollout files to disk |
  | `--skip-git-repo-check` | Allow running outside a Git repo (Codex otherwise requires one) |
  | `--ignore-user-config` | Don't load `$CODEX_HOME/config.toml` |
  | `--ignore-rules` | Skip user/project execpolicy `.rules` files |
  | `-c key=value` / `--model <id>` | Per-run config / model override (config is `~/.codex/config.toml`, `$CODEX_HOME` relocatable) |
  | `--dangerously-bypass-approvals-and-sandbox` (`--yolo`) | No approvals, no sandbox — "only use inside an externally hardened environment." **Never expose this in D Shift.** |
  | `--full-auto` | **Removed / no longer supported** in current docs — "Update scripts to use `--sandbox workspace-write`, or use `--approve-for-me` to route approval requests through automatic review." (Older third-party write-ups call it "deprecated compatibility flag" — treat it as gone and do not emit it.) |
  Source: https://developers.openai.com/codex/autofix-ci/
- Auth for automation: `codex exec` reuses saved CLI auth by default. Per-invocation key: set `CODEX_API_KEY` **only for that invocation's environment** (`CODEX_API_KEY=<key> codex exec …`); never as a job-level env var in workflows that run repo-controlled code. `~/.codex/auth.json` "contains access tokens — treat it like a password."
  Source: https://developers.openai.com/codex/autofix-ci/
- MCP failure semantics: if an enabled MCP server has `required = true` and fails to initialise, `codex exec` exits with an error instead of continuing without it.
  Source: https://developers.openai.com/codex/autofix-ci/

**D Shift handoff recipe (approval-gated by construction):**
```bash
codex exec --json --sandbox read-only --ephemeral "<task>"        # default: inspect/plan only
codex exec --json --sandbox workspace-write "<task>"              # only after the user approves THIS task in the sidebar
# never: danger-full-access, never --dangerously-bypass-approvals-and-sandbox
```
Show the exact command + working directory + sandbox mode in the approval card. Default the working directory to the project the user picked, not the foreground app's folder.

### 3.2 JSON Lines output (`--json`)

- "`codex exec --json "summarize the repo structure" | jq` — When you enable `--json`, `stdout` becomes a JSON Lines (JSONL) stream so you can capture every event Codex emits while it's running. Event types include `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`, and `error`. Item types include agent messages, reasoning, command executions, file changes, MCP tool calls, web searches, and plan updates."
  Source: https://developers.openai.com/codex/autofix-ci/
- Sample stream (verbatim shape):
  ```json
  {"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}
  {"type":"turn.started"}
  {"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}
  {"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Repo contains docs, sdk, and examples directories."}}
  {"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":0}}
  ```
  Source: https://developers.openai.com/codex/autofix-ci/
- Note for D Shift stats: `turn.completed.usage` gives Codex-side token counts (`input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`) — surface them separately from Anthropic usage; they are different providers' meters.

### 3.3 Sandbox modes + approval policy (two independent controls)

- "Sandbox mode: What Codex can do technically (for example, where it can write and whether it can reach the network)… Approval policy: When Codex must ask you before it executes an action (for example, leaving the sandbox, using the network, or running commands outside a trusted set)."
  Source: https://developers.openai.com/codex/sandbox/ (Agent approvals & security)
- Defaults: "By default, the agent runs with **network access turned off**. Locally, Codex uses an OS-enforced sandbox that limits what it can touch (typically to the current workspace)." CLI/IDE default sandbox for local work is `workspace-write` with network off unless enabled (`[sandbox_workspace_write] network_access = true`).
  Source: https://developers.openai.com/codex/sandbox/
- Modes: `read-only` (inspect only) · `workspace-write` ("can read files, make edits, and run commands in the working directory automatically" in the Auto preset `--sandbox workspace-write --ask-for-approval on-request`; asks to edit outside the workspace or use the network) · `danger-full-access` (no filesystem/network boundaries — controlled environments only).
  Source: https://developers.openai.com/codex/sandbox/ and https://developers.openai.com/codex/autofix-ci/
- Approval policies (current): `on-request` (pause when crossing the sandbox / for untrusted commands), `never` (never prompt; failures return to the model), and granular / automatic-review forms (`--approve-for-me` routes requests through automatic review). **`approval_policy = "untrusted"` is retired** — "Codex and ChatGPT Work no longer support `approval_policy = "untrusted"`. The retired setting can prevent either client from starting." For strict per-command approval, omit `approval_policy` and mark the project `trust_level = "untrusted"` in `~/.codex/config.toml` instead.
  Source: https://developers.openai.com/codex/sandbox/
- Interactive preset example: `codex --sandbox read-only --ask-for-approval on-request`.
  Source: https://developers.openai.com/codex/sandbox/
- Windows sandbox (native, no WSL required): two modes configured in `config.toml` — `[windows] sandbox = "elevated"` (preferred: dedicated lower-privilege sandbox users, filesystem permission boundaries, firewall rules) or `"unelevated"` (fallback: restricted token from the current user, ACL boundaries, environment-level offline controls — weaker). Both use a private desktop by default (`windows.sandbox_private_desktop = false` restores `Winsta0\Default` for compatibility). Diagnostics: `$CODEX_HOME/.sandbox/sandbox.log`; never share `$CODEX_HOME/.sandbox-secrets/`.
  Source: https://developers.openai.com/codex/windows.md
- Sandbox concept page: sandboxing is OS-enforced per platform (macOS/Linux/WSL2/native Windows differ in mechanism, same idea); it applies to **spawned commands** too (git, package managers, test runners inherit the boundaries); approvals and sandbox are separate — the sandbox reduces approval fatigue for in-bounds work.
  Source: https://developers.openai.com/codex/concepts/sandboxing/

In `codex exec` there is no interactive prompting — approval is expressed **by the sandbox choice you pass**. That is exactly why D Shift's own approval card (before spawning) is the human gate, and why the default must be `read-only`.

### 3.4 Computer Use — availability + approval (separate from the CLI)

Do not conflate the two: **Computer Use is not a `codex exec` flag.** It is a capability of the ChatGPT desktop app (Work / Codex surfaces).

- "In supported regions, Computer Use in the ChatGPT desktop app is available on **macOS and Windows** with ChatGPT Work and Codex. Install the Computer Use plugin. On macOS, grant Screen Recording and Accessibility permissions when prompted." Invoke by mentioning `@Computer` or `@<AppName>` (e.g. `@Chrome`) in the prompt. Setup: Plugins > Computer Use > Install/Enable, turn on the server + skill toggles, then Settings > Computer use to review app access.
  Source: https://learn.chatgpt.com/docs/computer-use
- What it does: "ChatGPT can see and operate graphical user interfaces… view screen content, take screenshots, and [interact with] windows, menus, pointer, keyboard, and clipboard" in the apps you allow. Intended for GUI-only / multi-app tasks where no structured plugin or CLI exists.
  Source: https://learn.chatgpt.com/docs/computer-use
- **Approval model (the part D Shift must mirror):** "System permissions for Computer Use are separate from app approvals in ChatGPT… During a task, ChatGPT **asks for your permission before it can use an app** on your computer. You can choose **Always allow** so ChatGPT can use that app in the future without asking again." Saved apps appear under Settings > Computer Use > **Always-allowed apps** and can be revoked there. "File reads, file edits, and shell commands still follow the sandbox and approval settings for the task." Workspace admins can restrict allowed apps and whether approvals can be saved.
  Source: https://learn.chatgpt.com/docs/computer-use
- Windows specifics: "On Windows, Computer Use works in the **foreground**" — "keep the target app visible on the active desktop while the task runs" (no background/locked use; locked use is macOS-only). Persistent decisions on Windows are stored in `$CODEX_HOME/config.toml`:
  ```toml
  [computer_use.windows]
  always_allowed_app_ids = ["mspaint.exe"]
  ```
  Identifiers are executable names (desktop apps) or App User Model IDs (packaged apps). Admins can disable the feature entirely via `requirements.toml` `[features].computer_use = false`.
  Source: https://learn.chatgpt.com/docs/computer-use
- Hard limits: Computer Use cannot automate terminal apps or ChatGPT itself, cannot authenticate as administrator, and cannot approve OS security/privacy prompts — the human handles those.
  Source: https://learn.chatgpt.com/docs/computer-use (limits summarised in the mirrored reference https://github.com/mehmetbaykar/codex-docs-skill/blob/HEAD/skills/codex-docs/references/computer-use.md — verify against the Learn page at build time)
- Use-case framing: "Use Computer Use when a task moves across desktop apps, windows, or local files… with permission prompts and a final result you can review. For a website or signed-in browser session, start a separate browser task with `@Chrome`." Computer Use **requires the ChatGPT desktop app**; web/mobile cloud tasks cannot reach local apps (mobile can only steer a connected desktop host via Remote).
  Source: https://learn.chatgpt.com/use-cases/use-your-computer-with-codex

**Implication for D Shift's "optional Codex handoff":** there are two honest implementations —
1. **CLI handoff (build this):** spawn `codex exec` as in §3.1 with D Shift's own approval card. Full control, JSON progress, works headless from the sidebar.
2. **Computer Use handoff (deep-link only):** D Shift cannot programmatically drive the desktop app's Computer Use plugin via a documented CLI/API. The honest version is: prepare the task text, ask the user, and hand them to the ChatGPT desktop app to run it with `@Computer` — with D Shift stating that Computer Use's own per-app approval will still fire there. Do not fake a direct integration.

---

## 4. Anthropic Messages API — streaming, tool use, models & pricing

Docs home has moved from `docs.anthropic.com` to the Claude Platform docs: https://platform.claude.com/docs/ (pricing page itself says "For the most current pricing information, visit claude.com/pricing").

### 4.1 Basics + streaming

- Endpoint: `POST https://api.anthropic.com/v1/messages`. Headers: `x-api-key: <key>`, `anthropic-version: 2023-06-01`, `content-type: application/json`. Required body fields: `model`, `max_tokens`, `messages` (alternating `user`/`assistant`; system prompt is the top-level `system` field, **not** a message). Optional: `system`, `tools`, `tool_choice`, `temperature`/`top_p`/`top_k`, `stop_sequences`, `stream`.
  Source: Messages reference via https://platform.claude.com/docs/en/api/messages/create.md (mirrored summary at https://github.com/xiaolai/anthropic-docs/blob/HEAD/skills/anthropic-api/SKILL-messages.md)
- Streaming: set `"stream": true` to "incrementally stream the response using server-sent events (SSE)." SDKs: Python/TypeScript `client.messages.stream(...)` (Python context manager with `.text_stream`; TS event-emitter `.stream(...)`); raw cURL against `/v1/messages` with `accept: text/event-stream`. SDKs also offer a "stream under the hood, return the final `Message`" helper — recommended for large `max_tokens` to avoid HTTP timeouts.
  Source: https://platform.claude.com/docs/en/api/streaming (via local mirror https://github.com/sullivan-street-projects/anthropic-docs-local/blob/HEAD/api/streaming.md, which records that source_url)
- SSE event sequence (implement exactly this state machine):
  `message_start` (Message with empty content + initial usage) → per block: `content_block_start` (index + block type: `text`/`tool_use`/`thinking`/…) → `content_block_delta` ×n → `content_block_stop` → … → `message_delta` (top-level updates: `stop_reason`, cumulative `usage`) → `message_stop`. Plus `ping` keep-alives and `error` events.
  Delta types: `text_delta` (visible text), `input_json_delta` (tool arguments as `partial_json` fragments — **not valid JSON until accumulated to `content_block_stop`**), `thinking_delta`, `signature_delta`.
  Source: https://github.com/xiaolai/anthropic-docs/blob/HEAD/skills/anthropic-api/SKILL-messages.md (source: platform.claude.com streaming/messages docs) and https://platform.claude.com/docs/en/api/streaming
- Usage accounting for D Shift stats: every response carries `usage: { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, cache_creation: { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }, service_tier, server_tool_use }`. In streaming, `message_delta` usage is **cumulative** — the last one is the billable total. Thinking tokens bill as output tokens.
  Source: https://github.com/xiaolai/anthropic-docs/blob/HEAD/skills/anthropic-api/SKILL-messages.md and Messages response shape via https://platform.claude.com/docs/en/api/messages/create.md
- Cost formula per turn:
  `cost = input_tokens×input_rate + output_tokens×output_rate + cache_creation_5m×(1.25×input_rate) + cache_creation_1h×(2×input_rate) + cache_read×cache_read_rate` — all rates per MTok from §4.3. Batch API is 50% off (irrelevant for interactive chat; note it and move on).

### 4.2 Tool use

- Contract: "Tool use is a contract between your application and the model. You specify what operations are available and what shape their inputs and outputs take; Claude determines when and how to call them. **The model never runs anything on its own.** It emits a structured request, your code (or Anthropic's servers) runs the operation, and the result flows back into the conversation."
  Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works
- Three buckets:
  - **User-defined (client) tools** — you write the schema (`name`, `description`, `input_schema`), you execute. Response contains a `tool_use` block (name + JSON args); you reply with a `tool_result` block on the next request.
  - **Anthropic-schema (client) tools** — Anthropic publishes the schema, you execute: `memory`, `bash`, `text_editor`, `computer`, `browser`. Trained-in schemas → more reliable calling/error recovery than a hand-rolled equivalent. (D Shift note: Anthropic's `memory` tool pattern validates the plain-file memory design; D Shift's markdown folder is the same idea, user-owned.)
  - **Server tools** — Anthropic executes: `web_search`, `web_fetch`, `code_execution`, `tool_search`. You never build a `tool_result`; responses contain `server_tool_use` blocks. Server-side loop can return `stop_reason: "pause_turn"` — re-send the conversation to continue.
  Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works
- Agentic loop (client tools): while `stop_reason == "tool_use"`: (1) send request with `tools` + message, (2) read `tool_use` blocks, (3) run tools, format `tool_result` blocks, (4) send new request with full history + assistant response + user message carrying the results. Loop exits on `end_turn` / `max_tokens` / `stop_sequence` / `refusal`.
  Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works
- Tool-use overview: "Tool use lets Claude call functions that you define or that Anthropic provides. Claude determines when to call a tool based on the user's request and the tool's description." Client tools vs server tools (`web_search_20260209`, `web_fetch_20260209`, `code_execution_20260120` version strings as of the mirror date — pin versions from the live Tool reference at build time).
  Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview (via https://github.com/sullivan-street-projects/anthropic-docs-local/blob/HEAD/api/tool-use.md)
- Fine-grained tool streaming: enable per-tool `eager_input_streaming` to stream parameter values earlier; otherwise `input_json_delta`s arrive in coarse chunks. Only relevant if D Shift renders tool calls live.
  Source: https://platform.claude.com/docs/en/api/streaming
- Tool pricing note: "Tool use requests are priced based on: (1) total input tokens sent (including in the `tools` parameter), (2) output tokens generated, (3) for server-side tools, additional usage-based pricing (e.g. web search per search)." Tool definitions/schemas, `tool_use` and `tool_result` blocks all consume tokens — keep D Shift's tool schemas tight.
  Source: https://platform.claude.com/docs/en/about-claude/pricing

For D Shift v1, the highest-value tools are local and client-executed: `read_screen` (UIA), `screenshot` (fallback), `memory_search` / `memory_write` (markdown folder), and `handoff_to_codex` (the §3 approval flow modelled as a tool the model may *propose* but only the user can *confirm*).

### 4.3 Current models + pricing (for cost estimation)

Models overview guidance: "If you're unsure which model to use, **start with Claude Opus 5.5** for most workloads. Use Claude Fable 5.1 for demanding reasoning and long-horizon agentic work…" All current models support text + image input, text output, multilingual, vision, and tool use; all have a **1M-token context window** and **128K max output**.
Source: https://platform.claude.com/docs/en/models/overview

| Model (display) | Model ID* | Positioning (Anthropic's words) | Input $/MTok | Output $/MTok | Cache write 5m | Cache write 1h | Cache read |
|---|---|---|---:|---:|---:|---:|---:|
| Claude Fable 5.1 | `claude-fable-5-1` | Demanding reasoning and long-horizon agentic work | $10 | $50 | $12.50 | $20 | $0.25 † |
| Claude Opus 5.5 | `claude-opus-5-5` | Long-running agentic coding and knowledge work | $4 | $20 | $5 | $8 | $0.20 † |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | The best combination of speed and intelligence | $2 | $10 | $2.50 | $4 | $0.10 † |
| Claude Haiku 5.5 (prompt ≤ 100K tokens) | `claude-haiku-5-5` | High-volume, latency-sensitive tasks (classification, extraction, routing) | $0.10 | $0.50 | $0.125 | $0.20 | $0.01 |
| Claude Haiku 5.5 (prompt > 100K tokens) | `claude-haiku-5-5` | Same model, length-tiered price — **every token in the request reprices** | $0.50 | $2.50 | $0.625 | $1 | $0.05 |
| Claude Opus 5 / 4.8 / 4.7 / 4.6 / 4.5 (legacy) | `claude-opus-5`, `claude-opus-4-8`, … | Prior Opus line | $5 | $25 | $6.25 | $10 | $0.50 |
| Claude Sonnet 5 (legacy) | `claude-sonnet-5` | Prior Sonnet | $2 ‡ | $10 ‡ | $2.50 | $4 | $0.20 |
| Claude Sonnet 4.6 / 4.5 / 4 (legacy) | `claude-sonnet-4-6`, … | Prior Sonnet | $3 | $15 | $3.75 | $6 | $0.30 |
| Claude Haiku 4.5 (legacy) | `claude-haiku-4-5` | Prior Haiku (200K context) | $1 | $5 | $1.25 | $2 | $0.10 |

Sources: https://platform.claude.com/docs/en/about-claude/pricing (full table, crawled 2026-11-01) and https://platform.claude.com/docs/en/models/overview (positioning, context, output limits). Cross-check display prices: https://claude.com/platform/api
\* Model IDs are the conventional `claude-<family>-<version>` form corroborated by multiple secondary trackers citing the same Anthropic pages (e.g. https://saurabhbhayana.com/claude-ai-models-guide-2026 lists `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`). **Verify each ID against the live Models API (`GET /v1/models`) at build time** — the Models API returns `max_input_tokens`, `max_tokens`, and a `capabilities` object per model and is the authoritative ID source. Source: https://platform.claude.com/docs/en/models/overview
† Cache-read nuance: the generic rule is "cache read = 0.1× base input", **but** Fable 5.1/Mythos 5.1 read at 0.025× ($0.25) and Opus 5.5 / Sonnet 5.5 read at 0.05× ($0.20 / $0.10) — the table's per-model read column wins over the generic multiplier. Cache writes: 5-minute = 1.25× input, 1-hour = 2× input. "Caching pays off after one cache read for the 5-minute duration, or after two for the 1-hour duration." Source: https://platform.claude.com/docs/en/about-claude/pricing
‡ Sonnet 5 input/output cells rendered blank in the crawled pricing table; $2/$10 is corroborated by the secondary trackers above and by Sonnet 5.5 launching at the same $2/$10. Treat as verify-at-build-time.

More pricing rules that affect D Shift's estimator:
- **Long context:** "Claude 4.6 and later models (except Claude Haiku 5.5)… include the full 1M token context window at standard pricing. (A 900k-token request is billed at the same per-token rate as a 9k-token request.)" Haiku 5.5 is the sole exception (100K threshold above; prompt length counts **all** input tokens including cache reads/writes, per-request). Source: https://platform.claude.com/docs/en/about-claude/pricing
- **Tokenizer change:** "Claude 4.7 and later models… use a newer tokenizer… [producing] approximately 30% more tokens for the same text." Any chars→tokens heuristic in D Shift must be calibrated per generation; prefer the API's `usage` and the `count_tokens` endpoint over heuristics. Source: https://platform.claude.com/docs/en/about-claude/pricing
- **Fast mode (Opus):** Opus 5.5 fast mode $8/$40 per MTok (2× standard); Opus 5 / 4.8 fast mode $10/$50. Stacks with caching + data-residency multipliers; not available with Batch. Source: https://platform.claude.com/docs/en/about-claude/pricing
- **Data residency:** `inference_geo: "us"` = 1.1× on all token categories (4.6+ models); `"global"` (default) = standard. Source: https://platform.claude.com/docs/en/about-claude/pricing
- **Prompt caching mechanics:** automatic caching = one top-level `cache_control` field (system manages breakpoints — recommended starting point); explicit breakpoints = `cache_control` on individual blocks (max 4 per request; hierarchy system → tools → messages). For D Shift, cache the system prompt + memory summary + tool schemas — they repeat every turn. Source: https://platform.claude.com/docs/en/about-claude/pricing (and Prompt caching guide linked there)
- **Default-model recommendation for D Shift:** Sonnet 5.5 ($2/$10) as the everyday sidebar model (speed + price), Haiku 5.5 for routing/extraction/summarising UIA trees, Opus 5.5 as the user-selectable "deep" mode. Show per-tab and per-session cost using §4.1's formula — never a single blended "credits" number.

---

## 5. Source index (official first)

**Electron — https://www.electronjs.org/docs/latest/**
- BaseWindow constructor options: https://www.electronjs.org/docs/latest/api/structures/base-window-options
- BrowserWindow: https://www.electronjs.org/docs/latest/api/browser-window
- BaseWindow: https://www.electronjs.org/docs/latest/api/base-window
- Keyboard shortcuts / Accelerators: https://www.electronjs.org/docs/latest/tutorial/keyboard-shortcuts/
- globalShortcut: https://www.electronjs.org/docs/latest/api/global-shortcut (mirror read: https://az.electronjs.org/docs/latest/api/global-shortcut)
- Tray tutorial: https://www.electronjs.org/docs/latest/tutorial/tray
- desktopCapturer: https://www.electronjs.org/docs/latest/api/desktop-capturer
- safeStorage: https://www.electronjs.org/docs/latest/api/safe-storage · Electron 45 deprecation note: https://www.electronjs.org/blog/electron-45-0
- uiohook-napi (third-party, npm): https://socket.dev/npm/package/uiohook-napi

**Microsoft / Chromium**
- Extended Window Styles (`WS_EX_NOACTIVATE` etc.): https://learn.microsoft.com/en-gb/windows/win32/winmsg/extended-window-styles
- CreateWindowEx: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-createwindowexa
- AutomationElement: https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.automationelement?view=windowsdesktop-5.0
- AutomationElementInformation (Current/Cached properties): https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.automationelement.automationelementinformation
- Control Patterns Overview: https://learn.microsoft.com/en-gb/dotnet/framework/ui-automation/ui-automation-control-patterns-overview
- Chromium accessibility (AT detection, `--force-renderer-accessibility`, `chrome://accessibility`): https://chromium.googlesource.com/experimental/website/+/816bdcef00b192b2e7de9ea5a3c8072beddcd2e5/site/developers/design-documents/accessibility/index.md
- Chromium accessibility overview (AXMode flags): https://chromium.googlesource.com/chromium/src/+/dbe988530fa28e2f425a03c28624dabe8571a076/docs/accessibility/overview.md

**OpenAI Codex — entry https://developers.openai.com/codex/ (resolves to ChatGPT Learn)**
- Non-interactive mode (`codex exec`): https://developers.openai.com/codex/autofix-ci/
- Developer commands: https://developers.openai.com/codex/cli/slash-commands/
- Agent approvals & security: https://developers.openai.com/codex/sandbox/
- Sandboxing concept: https://developers.openai.com/codex/concepts/sandboxing/
- Windows sandbox: https://developers.openai.com/codex/windows.md
- Computer Use: https://learn.chatgpt.com/docs/computer-use · Use case: https://learn.chatgpt.com/use-cases/use-your-computer-with-codex

**Anthropic — https://platform.claude.com/docs/**
- Pricing: https://platform.claude.com/docs/en/about-claude/pricing · Display pricing: https://claude.com/pricing / https://claude.com/platform/api
- Models overview: https://platform.claude.com/docs/en/models/overview
- Streaming: https://platform.claude.com/docs/en/api/streaming
- Messages create: https://platform.claude.com/docs/en/api/messages/create.md
- Tool use — how it works: https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works · Overview: https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview

## 6. Open verification items for the build's first day

1. `focusable:false` + click: does clicking the sidebar steal foreground on the target Windows 11 build? If yes, implement the `WS_EX_NOACTIVATE` HWND patch (§1.2) before any UI polish.
2. Electron version pin: confirm the shipped Electron major (45+ behaviour assumed for `safeStorage` async deprecation + `desktopCapturer` handler shape). Re-check the breaking-changes page for that major.
3. Claude model IDs + Sonnet 5 base rates: confirm via `GET /v1/models` and the live pricing page on build day (§4.3 ‡/*).
4. Codex: confirm installed `codex --version` + `codex exec --help` on the dev machine against §3.1 — the CLI ships fast and flag details live on the linked reference page, not the overview.
5. UIA wake test matrix: Chrome, Edge, VS Code, Slack, Notepad, Word, File Explorer — record nodes returned cold vs after the wake-retry (§2.6), and the screenshot-fallback rate. That matrix is D Shift's core quality metric vs the original.
