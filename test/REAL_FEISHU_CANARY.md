# Real Feishu Canary Checklist

Run this checklist before a release when Feishu/Lark behavior or routing code
changed. These checks require real bot credentials and a real Feishu client, so
they are intentionally not part of `npm test`.

## Preconditions

- Use a non-production test chat when possible.
- Confirm the target instance is loaded and idle:

```bash
node ~/.codex/skills/feishu-bridge/scripts/bridge-instance.mjs status --name <instance>
```

- Confirm `FTB_ALLOWED_SENDERS` and `FTB_ADMIN_USERS` include the tester's
  current app-scoped `open_id`.

## Canary Cases

Use exact pass/fail evidence. Do not mark pass from exit codes alone.

| ID | Case | Expected Evidence |
| --- | --- | --- |
| FEISHU-CANARY-001 | Send `/ping` in p2p chat | Bot replies `pong`; `router.log` has one `received message` and one `replied`. |
| FEISHU-CANARY-002 | Send normal text | Codex replies in the same Feishu thread/message; no duplicate replies. |
| FEISHU-CANARY-003 | Send a file attachment | Inbox entry has `message.json`, `content.md`, `manifest.json`; `manifest.downloads` includes the attachment or `downloadErrors` has actionable permission text. |
| FEISHU-CANARY-004 | Send image/video attachment | Attachment key is hydrated if absent from event content; download plan is created before Codex prompt. |
| FEISHU-CANARY-005 | Send merge-forward card | Codex can summarize child messages; `router.log` only shows `[merge_forward] status=parsed ...`, not child message text. |
| FEISHU-CANARY-006 | Send from non-allowed user/chat | Bot does not reply; `router.log` records `ignored event by policy` with redacted IDs and remediation. |
| FEISHU-CANARY-007 | Run `/interrupt` during a long turn | Interrupt is processed before the long turn naturally completes; no tmux fallback is started. |
| FEISHU-CANARY-008 | Run `/stop main`, then send normal text | Bot reports the session is stopped; after `/restart main`, normal text works again. |
| FEISHU-CANARY-009 | Run `allowlist-capture` while service is loaded | Command refuses and tells operator to stop the matching service first. |
| FEISHU-CANARY-010 | Inspect local privacy artifacts | `data/`, `logs/`, and `inbox/` are private; merge-forward child text is not in `router.log`, `audit.jsonl`, or `active-turn.json`. |

## Recording

Record:

- instance name
- bot app id
- test chat id
- tester sender open_id
- timestamp with timezone
- pass/fail per ID
- relevant log path and inbox path

Do not paste app secrets or full access tokens into reports.
