# Strategy Plan

## Scope

Full local regression for `feishu-agent-router` after hardening and coverage additions.

## Test Groups

1. Full unit/integration suite: `npm test`
2. Syntax/check suite: `npm run check`
3. Git whitespace check: `git diff --check`
4. Static gap scan for known half-implemented patterns
5. Runtime status inspection for loaded bridge instances

## Out Of Scope

- Real Feishu client canary execution. Checklist created at `test/REAL_FEISHU_CANARY.md`, but not executed in this run.

