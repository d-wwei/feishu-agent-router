# Feishu Agent Router

Feishu Agent Router turns Feishu into a mobile office control surface while keeping the actual agent/runtime outside the Feishu connection process.

```text
Feishu official events/messages/files
-> local router daemon
-> session registry and route table
-> backend adapter
-> Codex app-server, or tmux fallback for terminal agents
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
If you run raw `lark-cli event consume` from an agent subprocess, keep stdin open
or it may exit on EOF:

```bash
lark-cli --profile sales-bot event consume im.message.receive_v1 \
  --as bot \
  --jq '{message_id,chat_id,chat_type,sender_id,content}' \
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
/new <name> [--agent codex|claude|gemini|script] [--cwd path] [--cmd command]
/stop [session]
/restart [session]
/file [session] [note]
```

Admin-only commands:

```text
/bind
/unbind
/new
/stop
/restart
```

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
- tmux backend kept as a fallback and for terminal agents

Phase 2: office materials

- Inbound text/post/image/file/video/merge-forward messages are normalized
- Non-text and `/file` messages are saved under `inbox/`
- `message.json`, `content.md`, and `manifest.json` are created
- The router tries Feishu official resource download for image/file/video attachments
- Local inbox paths are passed to the backend session
- Voice transcription is intentionally not included in this phase

Phase 3: multi-agent routing

- Sessions are backend/agent/command records
- Codex sessions can use `codex-app-server` and keep a `threadId`
- The tmux backend can start any command and is used as fallback when app-server fails
- Feishu chats/users/threads can map to different sessions
- Optional idle auto-stop is available via `FTB_IDLE_STOP_MS` and per-session `"idleStop": true`

Feishu UX migration:

- Replies use Feishu post messages for normal markdown and interactive cards for code blocks/tables
- Message reactions are added as best-effort phase feedback when the bot has reaction permission
- Permission cards can be rendered, but button callback handling is not wired until the active `lark-cli` event catalog exposes card action events; text fallback commands remain the safe path
- Streaming replies default to `FTB_FEISHU_STREAMING=auto`: short replies are sent once as final messages, while likely long/complex tasks start a streaming card after `FTB_FEISHU_STREAM_START_DELAY_MS`; set it to `always` or `off` to override

## Backends

`codex-app-server` is the preferred backend for Codex. It starts one local
`codex app-server --listen ws://127.0.0.1:<port>` process and sends each Feishu
message as a structured `turn/start` request. The session stores the Codex
`threadId`, so future messages resume the same Codex thread without parsing a
terminal screen.

By default, the Codex backend is configured for remote-office control:

```text
FTB_CODEX_SANDBOX=danger-full-access
FTB_CODEX_APPROVAL_POLICY=never
FTB_CODEX_AUTO_APPROVE_REQUESTS=true
```

The tmux fallback command also defaults to:

```text
codex --no-alt-screen --cd <cwd> --sandbox danger-full-access -a never
```

These defaults avoid permission prompts and sandbox blocks while controlling
the machine from Feishu. They can be tightened in `.env` per deployment.

`tmux` remains available as a fallback. If a `codex-app-server` session fails
and the session does not set `"fallback": false`, the router sends the same
prompt to the session's `tmuxSession` and replies with the tmux result.
