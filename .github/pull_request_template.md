## What changed

## Why

## Verification
- [ ] `npm run check` passes
- [ ] `npm test` passes (all suites, not just the touched one)
- [ ] `npm run preflight` passes if packaging/config changed
- [ ] New behaviour has a test that failed before this change
- [ ] No secrets, `.env` files, or user data in the diff

## Safety checklist (tick what applies)
- [ ] Approvals still resolve on every path (allow / deny / timeout / stop)
- [ ] Memory writes still confined to the memory folder (symlink-safe) and audit-chained
- [ ] Budget gate still checked before spend, with reservation accounting intact
- [ ] Nothing new is sent off-device beyond the provider calls the user initiates
