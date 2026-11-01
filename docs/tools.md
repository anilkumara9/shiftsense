# Tools

The agent has five tools. Caps are per question and enforced in `src/agent.js` — the model is told when a cap is hit and must answer with what it has.

| Tool | Cap | What it does | Safety |
|---|---|---|---|
| `read_screen` | 3 | Reads the tracked foreground app again via UI Automation (`docs/architecture.md` has the pipeline) | Password values never emitted; denylisted apps return instructions text instead of content |
| `take_screenshot` | 1 | Captures the foreground app's window (or full screen on request) | The D Shift window itself is excluded from capture sources; the source is matched to the tracked window title |
| `search_memory` | — | Ranked search over the markdown memory | Read only |
| `write_memory` | — | Appends to or replaces a memory file (creating `people/`/`projects/` entries as needed) | Confined to the memory folder, audit chained, undoable (see `docs/memory.md`) |
| `use_computer` | 3 | Hands a task to the Codex CLI for computer use | **Approval for each task**, expires after 2 minutes, serialized approval queue, read only sandbox, scrubbed environment, hash chained audit log; auto mode lasts for the session only and never persists |

## Slash commands

`/auto` toggles session auto mode · `/new` new tab · `/clear` clear chat · `/history` reopen a past chat · `/copy` copy the last reply · `/memory` open the memory folder · `/help` list commands. These mirror the reference app's command set.

## Deliberate absences

- **No shell tool.** The reference app briefly considered a read only shell; a dormant, allowlisted policy ships in `src/shellPolicy.js` as defence in depth, but no shell tool is exposed to the model.
- **No persistent "always allow" for computer use.** Approvals are the product. Auto mode exists for a single session's convenience and dies with the app.
- **No web tools in v1.** Screen + memory + computer use cover the sidebar's job; web access arrives only through the apps already on your screen.
