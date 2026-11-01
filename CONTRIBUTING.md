# Contributing to ShiftSense

## Setup

```powershell
npm install
npm start          # launches the sidebar (tray icon; double-tap Shift)
npm test           # 99 tests — must be green before and after your change
npm run check      # syntax check across main, preload, renderer and src
npm run preflight  # packaging gate (required if you touch build config)
```

No API key is needed to develop: switch the provider to **Ollama** for local models, or work against the scripted providers in the test suites.

## Ground rules

These are load-bearing design decisions, not style preferences. PRs that break them will be asked to change:

1. **Approvals always resolve.** Any new user-approval path must resolve on allow, deny, timeout, and Stop — a hung approval is a release blocker (see `src/approvalQueue.js`).
2. **The sidebar never reads itself.** Screen context comes from the tracked last *external* window.
3. **Memory writes stay in the memory folder** — symlink-safe resolution, size-capped, audit-chained, undoable (`src/memory.js`).
4. **State files are crash-safe.** Anything persisted goes through atomic write + backup/mirror rotation (`src/chatStore.js`, `src/spend.js`).
5. **The budget gate runs before spend**, with reservation accounting for concurrent turns.
6. **No demo material.** No placeholder features, no fake data, no stubbed integrations. If it can't be verified, it doesn't ship; limitations are written down in the README instead.

## Tests

- New behaviour needs a test that fails without it. The suites live in `tests/` and are organised by concern: `core`, `agent`, `audit*` (regressions from the two production audits), `security`, `reliability`, `aiengine`, `uia`, `parity`, `e2e` (the hostile end-to-end suite).
- Platform-specific behaviour (UIA, hooks) is developed against injectable seams so the logic is testable anywhere; the physical Windows pass is tracked in `recon/DOCS_RESEARCH.md` §6.

## Commits

Present-tense, scoped messages (`fix(memory): …`, `feat(agent): …`). One concern per commit where practical.
