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
| FEISHU-CANARY-004 | Send image/video/media attachment | Attachment key is hydrated if absent from event content; download plan is created before Codex prompt. |
| FEISHU-CANARY-005 | Send merge-forward card | Codex can summarize child messages; `router.log` only shows `[merge_forward] status=parsed ...`, not child message text. |
| FEISHU-CANARY-006 | Send from non-allowed user/chat | Bot does not reply; `router.log` records `ignored event by policy` with redacted IDs and remediation. |
| FEISHU-CANARY-007 | Run `/interrupt` during a long turn | Interrupt is processed before the long turn naturally completes; no tmux fallback is started. |
| FEISHU-CANARY-008 | Run `/stop main`, then send normal text | Bot reports the session is stopped; after `/restart main`, normal text works again. |
| FEISHU-CANARY-009 | Run `allowlist-capture` while service is loaded | Command refuses and tells operator to stop the matching service first. |
| FEISHU-CANARY-010 | Inspect local privacy artifacts | `data/`, `logs/`, and `inbox/` are private; merge-forward child text is not in `router.log`, `audit.jsonl`, or `active-turn.json`. |
| FEISHU-CANARY-011 | Send audio message | Audio is downloaded; transcript appears in private inbox/Codex response when a local engine is available, or a safe skipped diagnostic appears when unavailable. Transcript text is not in `router.log`, `audit.jsonl`, or `active-turn.json`. |
| FEISHU-CANARY-012 | Send sticker/gif | Sticker resource is downloaded when a key is available; otherwise `[表情]` placeholder and actionable manifest reason are recorded. |
| FEISHU-CANARY-013 | Send merge-forward containing video/audio/sticker | Child media generates download plans; child audio has transcript/skipped/failed diagnostic; logs remain structural only. |
| FEISHU-CANARY-014 | Send an interactive business card with visible text and buttons | Inbox `manifest.businessCards[0]` has `cardKind=interactive`; Codex prompt/content shows visible text and button labels; `router.log`, `audit.jsonl`, and `active-turn.json` show only `[business_card] ...`. |
| FEISHU-CANARY-015 | Send an interactive card with a URL containing query/fragment | `content.md`, `manifest.json`, and Codex prompt contain only sanitized URL text; original query/fragment appears only in private `message.json`. |
| FEISHU-CANARY-016 | Send contact, group, and location cards | `share_user`, `share_chat`, and `location` produce structured `businessCards[]`; location coordinates are absent from logs/audit/active-turn and present only in private inbox files. |
| FEISHU-CANARY-017 | Send a system message if the client/test hook can produce one | Router writes inbox and structural audit/log entries; the system message is not delivered to Codex as a user instruction by default. |
| FEISHU-CANARY-018 | Send merge-forward containing an interactive card | Parent manifest has a child `businessCards[]` entry with child index/message id/sender; logs remain structural and do not include card visible text or URLs. |
| FEISHU-CANARY-019 | Start with only `FTB_ALLOWED_CHATS` and no sender allowlist | Bridge refuses normal execution unless `FTB_ALLOW_UNRESTRICTED=true`; chat allowlist alone does not authorize group members. |
| FEISHU-CANARY-020 | Send ordinary text containing a fake token/URL secret | Codex receives the text, but `router.log`, `audit.jsonl`, and `active-turn.json` contain only structural length/hash previews. |
| FEISHU-CANARY-021 | Run audio canary with `FTB_AUDIO_DOWNLOAD=false` and then with `FTB_AUDIO_TRANSCRIBE_SEND_TO_CODEX=false` | First run records `download_disabled` and performs no resource download; second run stores transcript in private file but does not include transcript text in `content.md`/Codex prompt. |

## Recording

Record:

- instance name
- bot app id
- test chat id
- tester sender open_id
- timestamp with timezone
- pass/fail per ID
- relevant log path and inbox path
- manifest schema/version if present
- artifact paths checked
- redaction assertions checked
- failure reason code for failed cases

Do not paste app secrets or full access tokens into reports.
