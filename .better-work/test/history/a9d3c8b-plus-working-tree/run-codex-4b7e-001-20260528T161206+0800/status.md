# Test Status

## Summary

PASS with caveat: real Feishu canary checklist was not executed.

## Results

| ID | Group | Command / Check | Result | Evidence |
| --- | --- | --- | --- | --- |
| AUTO-001 | full-regression | `npm test` | pass | 86 tests, 86 pass, 0 fail |
| AUTO-002 | syntax | `npm run check` | pass | all `node --check` targets exited 0 |
| AUTO-003 | git-whitespace | `git diff --check` | pass | exit 0 |
| STATIC-001 | half-implementation scan | `rg` scan for known stale patterns | pass | no active `/perm`, callbackData, genericDownloadFallback, old env defaults, or content-bearing allowlist capture found |
| RUNTIME-001 | bridge status | `bridge-instance status` for default and rsopend-tester | pass | both services running, `active_turn: none` |
| MANUAL-001 | real Feishu canary | `test/REAL_FEISHU_CANARY.md` | skip | requires real Feishu client and bot credentials; checklist exists but was not executed |

## Active Findings

None from automated local testing.

## Residual Risk

- Real Feishu canary remains unexecuted in this run.
- Current report covers the working tree state, including uncommitted coverage additions, not only commit `a9d3c8b`.

