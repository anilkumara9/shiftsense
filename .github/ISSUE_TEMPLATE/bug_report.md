---
name: Bug report
about: Something broke or behaved dangerously
labels: bug
---

**What happened**

**What you expected**

**Steps to reproduce**
1.
2.

**Environment**
- Windows version:
- ShiftSense version (Settings shows data paths; version is in package.json / the installer name):
- Provider (Anthropic / OpenAI / Ollama) and model:

**Logs**
- If the app recovered state from a backup, say so — recovery is logged at startup and mentioned in Settings.
- Codex tasks: the audit trail lives in `~/DShift/codex/audit.jsonl` (task text is hashed, never stored raw).

**Screenshots**
The in-app feedback button (💬 in the tab strip) saves a note + screenshot + the current chat to `~/DShift/feedback/` — attaching that file helps a lot.
