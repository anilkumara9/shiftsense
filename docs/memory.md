# Memory

ShiftSense remembers in **plain markdown files you own** — no database, no cloud, nothing you can't open in Notepad.

## Layout

```
~/DShift/memory/
├── me.md            who you are — read into every conversation (keep it under ~8,000 chars)
├── notes.md         free form notes
├── people/          one file per person
├── projects/        one file per project
├── .audit.jsonl     every write, hash chained (tampering is detectable)
└── .versions/       snapshots for undo (newest 20 per file)
```

Override the root with `DSHIFT_DATA_DIR`. Open the folder any time from the tray, the 🧠 button, or `/memory`.

## How it's used

- `me.md` and the file list ride along with every question, so answers know your context.
- The model can `search_memory` (ranked search over headings and content, running inside the app) and `write_memory` when it learns something worth keeping.
- You can edit any file yourself, in any editor, at any time — the app reads them again on demand.

## Guarantees

- **Confined:** writes resolve inside the memory folder in a symlink safe way; escaping paths, dangling symlinks, and internal dot directories are refused.
- **Audited:** every write (model or user) is appended to `.audit.jsonl` with the SHA-256 of the resulting content, chained to the previous entry. `verifyAudit()` in `src/memory.js` checks the chain.
- **Undoable:** the previous content of every write is snapshotted; Memory → *Undo last model write* restores it.
- **Capped:** a single write can't exceed 1,000,000 chars, and `me.md` carries a soft guard at 8,000 chars (the UI warns past it) because it is sent again with every request and directly costs tokens.
- **Private:** memory never leaves the machine except the `me.md` excerpt included in a question you send to your configured provider.
