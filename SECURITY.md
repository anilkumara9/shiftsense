# Security policy

## Reporting

Found a vulnerability? Please open a GitHub issue with the label `security` for low-severity items, or contact the maintainer privately (GitHub profile) for anything involving key exposure, approval bypass, or arbitrary code execution. You'll get an acknowledgement within a few days.

## Security model

ShiftSense is a local-first desktop app. The trust boundaries that matter:

- **API keys** are resolved in this order: environment → `./.env` → `~/.config/dshift/.env` → the in-app key, which is stored only as Windows DPAPI ciphertext (`safeStorage`). Keys are never logged, never committed (preflight fails the build if a key-like file would be packaged), and are stripped from the Codex subprocess environment along with generic secret-suffixed variables.
- **Screen data** is read via UI Automation with password values never emitted, a per-app no-read list, and hard caps; a screenshot (max 1 per question) is taken only when the tree is insufficient or the model explicitly asks. Screen content goes only to the provider the user configured, only when the user asks a question.
- **Computer use** is never ambient: every Codex task needs a per-task approval (2-minute expiry), approvals are serialized and always resolve, there is no persistent "always allow" (the in-app auto mode is session-only), and Codex runs read-only with an audit trail that stores task *hashes*, not task text.
- **Memory** is plain markdown the user owns. Writes are confined to the memory folder with symlink-safe resolution, size caps, versioned undo, and a hash-chained audit log (`verifyAudit()` detects tampering).
- **Persistence** is crash-safe (atomic rename, backups, mirrors) so a corrupt state file can never silently reset the budget ledger or the chat store.

The two independent audit rounds and the security lane's findings are documented in `recon/AUDIT_V1.md` and `CHANGELOG.md`.

## Supported versions

Only the latest release is supported with security fixes.
