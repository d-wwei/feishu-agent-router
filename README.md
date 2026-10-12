# Feishu Agent Router

Feishu Agent Router turns Feishu into a mobile office control surface while keeping the actual agent/runtime outside the Feishu connection process.

```text
Feishu official events/messages/files
-> local router daemon
-> session registry and route table
-> backend adapter
-> Codex app-server, or explicitly configured tmux terminal agents
```

The router daemon is intentionally not an agent. It listens, checks permissions, parses commands, stores incoming materials, routes messages to sessions, captures output, and replies in Feishu.

## Install And Run

```bash
cp .env.example .env
npm run doctor
npm start
```

The router uses an explicit local `lark-cli` profile for the Feishu bot/app. No
Feishu app secret is stored in this repo.

Create one `lark-cli` profile per Feishu bot/app:

```bash
printf '%s' "$FEISHU_APP_SECRET" \
  | lark-cli profile add --name sales-bot --app-id cli_xxx --app-secret-stdin
```

Then pin the router env to that profile:

```text
FTB_LARK_AS=bot
FTB_LARK_PROFILE=sales-bot
FTB_LARK_APP_ID=cli_xxx
```

The router takes a global lock per `FTB_LARK_APP_ID` at startup. A second router
for the same Feishu bot/app fails fast instead of consuming the same event stream
from two local processes.

`FTB_ALLOWED_SENDERS` must contain the `sender_id` from
`im.message.receive_v1`. This value is a Feishu `open_id`, and `open_id` is
app-scoped: the same human user can have a different `open_id` after you switch
to a new bot/app. After changing bots, recapture the IDs before expecting the
new bot to reply:

```bash
farctl --name sales --env .env.sales --home ~/.feishu-agent-router-sales \
  allowlist-capture --timeout 120s
```

`allowlist-capture` prints full `sender_id` and `chat_id` only to local stdout;
the router log keeps policy blocks scoped to redacted IDs and remediation text.
The router fails closed when `FTB_ALLOWED_SENDERS` is empty. `FTB_ALLOWED_CHATS`
is an additional scope constraint, not a replacement for sender allowlisting.
Set `FTB_ALLOW_UNRESTRICTED=true` only for an intentionally public bridge.
Admin commands require `FTB_ADMIN_USERS`; set `FTB_ALLOW_ADMIN_ALL=true` only
when every allowed sender should be treated as an admin.
Because it consumes the same Feishu event stream as the router, `farctl
allowlist-capture` refuses while the matching launchd service is loaded. Stop
that instance first, capture the IDs, then start it again.
If you run raw `lark-cli event consume` from an agent subprocess, keep stdin open
or it may exit on EOF:

```bash
lark-cli --profile sales-bot event consume im.message.receive_v1 \
  --as bot \
  --jq '{message_id,chat_id,chat_type,sender_id}' \
  --timeout 120s \
  < <(tail -f /dev/null)
```

For real daily use, install it as a user launchd service:

```bash
cd /Users/admin/Documents/AI/feishu-agent-router
npm link
npm run service -- install
npm run service -- status
```

Service commands:

```bash
farctl start
farctl stop
farctl restart
farctl status
farctl logs
farctl logs -f
farctl logs err
farctl allowlist-capture --timeout 120s
farctl uninstall
```

`farctl status` also reports the current active Feishu turn when one exists.
This is the lightweight completion signal used by operators and monitors:
`active_turn: none` means the router is not currently processing an inbound
message in that instance.

`farctl start` and `farctl restart` rewrite the matching launchd plist whenever
the passed `--env` or `--home` changes, so the plist cannot silently keep an
older env/home while the CLI reports a newer one.

Multiple bot instances can run side-by-side by giving each one its own
Feishu app/profile, instance name, env file, and runtime home:

```bash
cp .env .env.sales
# edit .env.sales: set FTB_LARK_PROFILE, FTB_LARK_APP_ID,
# FTB_ALLOWED_SENDERS/CHATS, etc.
farctl --name sales --env .env.sales --home ~/.feishu-agent-router-sales install
farctl --name sales status
farctl --name sales logs -f
farctl --name sales uninstall
```

The default instance keeps the legacy service label `com.feishu-agent-router`.
Named instances use labels such as `com.feishu-agent-router.sales`, so installing
one will not overwrite another. Instance names do not create new Feishu bots by
themselves; `FTB_LARK_PROFILE` and `FTB_LARK_APP_ID` select the bot identity.

The `skills/feishu-bridge/scripts/bridge-instance.mjs` helper records successful
`init` paths in `~/.feishu-agent-router/instances.json`. After `init`, later
helper commands with the same `--name` reuse the registered env/home from any
working directory unless `--env` or `--home` is passed explicitly.

The launchd plist is installed to:

```text
~/Library/LaunchAgents/com.feishu-agent-router.plist
~/Library/LaunchAgents/com.feishu-agent-router.<name>.plist
```

Runtime logs are written to:

```text
~/.feishu-agent-router/logs/router.log
~/.feishu-agent-router/logs/launchd.out.log
~/.feishu-agent-router/logs/launchd.err.log
```

## Files

By default, state can live under `FTB_HOME`:

```text
~/.feishu-agent-router/
  data/
    sessions.json
    routes.json
    user-context.json
    seen.json
  inbox/
    YYYY-MM-DD/
      om_xxx/
        message.json
        content.md
        manifest.json
        attachments/
  logs/
    router.log
    audit.jsonl
```

For real Feishu release checks that cannot run in `npm test`, use
[test/REAL_FEISHU_CANARY.md](test/REAL_FEISHU_CANARY.md).

## Routing Model

Resolution order:

```text
thread route
-> current user session from /use
-> chat route from /bind
-> user route
-> auto-created group session
-> FTB_DEFAULT_SESSION
```

A Feishu group can therefore map to one persistent local work context, while a different group can map to another session and another agent.

When `FTB_AUTO_CREATE_GROUP_SESSIONS=true`, the first plain message received in
a new group automatically creates a dedicated session and binds that group to
it. Manual `/new` and `/bind` are still available when you want explicit names
or non-default backend settings.

`/new --agent script` is for explicit shell commands only and requires
`--cmd <command>`; without it the router rejects the command instead of
starting a session whose command is just the word `script`.

## Commands

```text
/ping
/sessions
/routes
/whereami
/bind <session>
/unbind
/use <session>
/send [session] <text>
/capture [session]
/status [session]
/interrupt [session]
/new <name> [--agent codex|claude|gemini] [--cwd path] [--cmd command]
/new <name> --agent script --cmd <command>
/stop [session]
/restart [session]
/file --message-id <message_id> [session] [note]
```

Admin-only commands:

```text
/bind
/unbind
/use
/new
/stop
/restart
/file
```

For non-admin users, `/send`, `/capture`, `/status`, and `/interrupt` can only
target the session resolved from the current Feishu chat/thread/user context.
Supplying an explicit session name is admin-only.

`/interrupt` and `/status` bypass the normal per-turn delivery queue so they
can still respond while a long Codex turn is running. `/stop` marks a
`codex-app-server` session as manually stopped; ordinary messages and `/send`
are rejected until `/restart` clears the stop marker and starts a fresh thread.

## Session Examples

`data/sessions.json`:

```json
{
  "main": {
    "backend": "codex-app-server",
    "agent": "codex",
    "threadId": null,
    "tmuxSession": "far-main",
    "cwd": "/Users/admin",
    "command": "codex --no-alt-screen --cd /Users/admin --sandbox danger-full-access -a never",
    "state": "running"
  },
  "writing": {
    "backend": "tmux",
    "agent": "claude",
    "tmuxSession": "far-writing",
    "cwd": "/Users/admin/Documents/AI/writing",
    "command": "claude",
    "state": "stopped"
  }
}
```

`data/routes.json`:

```json
{
  "chats": {
    "oc_breaking": {
      "defaultSession": "main"
    },
    "oc_writing": {
      "defaultSession": "writing"
    }
  },
  "threads": {},
  "users": {}
}
```

## Implemented Scope

Phase 1: router MVP

- Feishu long connection via `lark-cli event consume im.message.receive_v1`
- `/sessions`, `/routes`, `/whereami`, `/status`
- `/bind`, `/use`
- `/send`, `/capture`, `/interrupt`
- Codex app-server backend with persistent Codex threads
- tmux backend kept for explicit terminal-agent sessions

Phase 2: office materials

- Inbound text/post/image/file/video/media/audio/sticker/merge-forward messages are normalized
- Business-card and special message types (`interactive`, `share_user`,
  `share_chat`, `location`, `system`, and future unknown types) are staged as
  `materialKind=business_card` with `businessCards[]` summaries instead of
  falling back to plain unsupported text
- Merge-forward messages are expanded by fetching child messages through
  `GET /open-apis/im/v1/messages/{message_id}` before they are sent to Codex
- Merge-forward child business cards are included in `businessCards[]` with
  child index, child message id, and sender label
- Image/file/video/media/audio/sticker events that arrive without a downloadable key are hydrated
  through `GET /open-apis/im/v1/messages/{message_id}` so `body.content` can be
  parsed before resource download plans are created
- Non-text messages and explicit `/file --message-id <message_id>` captures are
  saved under `inbox/`
- `message.json`, `content.md`, and `manifest.json` are created
- Inbox directories are written with `0700` permissions and inbox files with
  `0600` permissions
- The router tries Feishu official resource download for image/file/video/media/audio/sticker
  attachments only when a concrete file key is available
- Business-card URLs are sanitized in `content.md`, `manifest.json`, and Codex
  prompts; original URLs remain only in private `message.json`
- Business-card logs, audit previews, and active-turn previews are structural
  only and never include raw card JSON, callback payloads, URL query strings, or
  precise location coordinates
- Local inbox paths are passed to the backend session
- Merge-forward parsing requires the bot/profile to have message-read access to
  the source chat; common missing scopes are `im:message.group_msg` and
  `contact:user.base:readonly`
- Audio messages are downloaded and transcribed locally by default after
  allowlist checks. The router does not call Feishu STT or hosted APIs; if no
  local ASR engine/model is available, it keeps the downloaded audio and sends a
  safe diagnostic instead of blocking the message.
- Set `FTB_AUDIO_DOWNLOAD=false` to skip audio/media resource downloads. Set
  `FTB_AUDIO_TRANSCRIBE_SEND_TO_CODEX=false` to keep transcript text only in the
  private transcript file instead of in `content.md`/Codex prompt.
- External `lark-cli` fetch/download/reply calls use `FTB_LARK_CLI_TIMEOUT_MS`
  so a stalled Feishu API command cannot hang forever.
- Ordinary text/post logs, audit previews, and active-turn previews are
  structural (`chars` + hash) rather than raw message content.

Phase 3: multi-agent routing

- Sessions are backend/agent/command records
- Codex sessions can use `codex-app-server` and keep a `threadId`
- The tmux backend can start any command for explicit terminal-agent sessions
- Feishu chats/users/threads can map to different sessions
- Optional idle auto-stop is available via `FTB_IDLE_STOP_MS` and per-session `"idleStop": true`

Feishu UX migration:

- Replies use Feishu post messages for normal markdown and interactive cards for code blocks/tables
- Message reactions are added as best-effort phase feedback when the bot has reaction permission
- Streaming replies default to `FTB_FEISHU_STREAMING=auto`: short replies are sent once as final messages, while likely long/complex tasks start a streaming card after `FTB_FEISHU_STREAM_START_DELAY_MS`; set it to `always` or `off` to override. Live progress cards preserve the running transcript but insert a `实时进展` heading and paragraph breaks so long Codex status streams are readable in Feishu.
- When Codex is still cold or prewarming, Router sends one updatable card after `FTB_COLD_START_CARD_DELAY_MS` and patches that same card with the final answer.
- Router owns replies to the current inbound message. Codex should return final
  text for Router to deliver; direct Feishu/Lark tool calls are reserved for
  explicit side effects such as sending a new message to another chat or reading
  chat history.

## Backends

`codex-app-server` is the preferred backend for Codex. It starts one local
`codex app-server --listen stdio://` process by default and sends each Feishu
message as a structured `turn/start` request over newline-delimited JSON. The
session stores the Codex `threadId`, so future messages resume the same Codex
thread without parsing a terminal screen.

For deployments that prefer a socket, set:

```text
FTB_CODEX_APP_SERVER_LISTEN=unix:///absolute/path/to/codex-app-server.sock
```

By default, the Codex backend is configured for remote-office control:

```text
FTB_CODEX_SANDBOX=danger-full-access
FTB_CODEX_APPROVAL_POLICY=never
FTB_CODEX_AUTO_APPROVE_REQUESTS=true
FTB_CODEX_RESPONSES_WEBSOCKETS=false
FTB_CODEX_FORCE_RESPONSES_HTTP=false
FTB_CODEX_HTTP_PROVIDER_ID=chatgpt_http
FTB_CODEX_HTTP_PROVIDER_BASE_URL=https://chatgpt.com/backend-api/codex
FTB_ENABLE_TMUX_FALLBACK=false
FTB_PREWARM_CODEX=true
FTB_PREWARM_SESSIONS=main
FTB_PREWARM_TURN=false
FTB_CODEX_REQUEST_TIMEOUT_MS=120000
FTB_CODEX_FIRST_OUTPUT_TIMEOUT_MS=90000
FTB_CODEX_TURN_IDLE_TIMEOUT_MS=300000
FTB_CODEX_TURN_HARD_TIMEOUT_MS=0
```

The tmux command also defaults to:

```text
codex --no-alt-screen --cd <cwd> --sandbox danger-full-access -a never
```

These defaults avoid permission prompts and sandbox blocks while controlling
the machine from Feishu. Response websockets are disabled on the bridge path so
Codex uses HTTP streaming instead of waiting on a stalled websocket first event.
By default, the app-server does not override `model_provider`, so Codex inherits
the user's global Codex profile/provider. For deployments that intentionally
need the ChatGPT HTTP provider override, set `FTB_CODEX_FORCE_RESPONSES_HTTP=true`;
that adds a local provider override with `wire_api="responses"` and
`supports_websockets=false`.

### Long-running turns: warn, do not interrupt

`FTB_CODEX_FIRST_OUTPUT_TIMEOUT_MS` and `FTB_CODEX_TURN_IDLE_TIMEOUT_MS`
are now **warning thresholds**, despite their historical names. They never
interrupt, retry, rebuild a thread, or release the ordinary-message queue.
Either value can be `0` to disable that detector. A silent period emits at most
one warning; meaningful new activity rearms the idle detector.

On silence, the bridge makes a read-only `thread/read` query bounded by five
seconds (or the shorter request timeout), then sends a non-final Feishu warning.
A responsive server is not proof of task progress. An unsupported or timed-out
query is reported as unconfirmed, not as task failure. A late query result is
discarded if the turn completed or activity resumed. Failed warning delivery
does not cancel the task.

Agent text, reasoning progress, command output, tool progress/start/completion,
and supported user-facing requests count as activity. Warnings, retries,
bookkeeping notifications, and unknown events do not. Process exit, transport
closure, and explicit terminal errors still fail the pending turn.

Ordinary messages remain queued behind a running turn. `/status <session>`
and `/interrupt <session>` bypass that queue; status includes the last activity
and any unconfirmed inactivity observation. Manual interruption is not reported
as successful task completion. Completed side effects are not rolled back.

There is no absolute deadline by default: `FTB_CODEX_TURN_HARD_TIMEOUT_MS=0`.
A positive value remains an explicit opt-in cancellation deadline. The separate
request/start timeouts bound protocol operations, not the duration of a task.
`FTB_PREWARM_CODEX=true` starts the app-server and resumes/creates listed Codex
threads when the bridge starts, so the first Feishu message no longer pays the
process/thread cold-start cost. Each app-server turn logs `appServerReadyMs`,
`threadReadyMs`, `firstOutputMs`, `turnCompletedMs`, `feishuReplyMs`, and
`totalMs` to `logs/router.log`. Inactivity warnings log structural activity
types and health-check outcomes without copying task output or reasoning text.

`tmux` remains available for explicit terminal-agent sessions. Automatic
fallback from `codex-app-server` to tmux is disabled by default because a broken
terminal Codex environment can leak TUI chrome back to Feishu and create extra
local Codex sessions. Set `FTB_ENABLE_TMUX_FALLBACK=true` only for deployments
where the tmux command is known to inherit the required model/provider
environment and terminal output parsing is acceptable. Codex turn timeout and
interrupt failures never fall back to tmux; they stay on the app-server path and
return the timeout/interrupt message to Feishu.
