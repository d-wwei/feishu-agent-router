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

The router uses the existing local `lark-cli` app/bot configuration. No Feishu app secret is stored in this repo.

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
farctl uninstall
```

The launchd plist is installed to:

```text
~/Library/LaunchAgents/com.feishu-agent-router.plist
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
-> FTB_DEFAULT_SESSION
```

A Feishu group can therefore map to one persistent local work context, while a different group can map to another session and another agent.

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

- Non-text and `/file` messages are saved under `inbox/`
- `message.json`, `content.md`, and `manifest.json` are created
- The router tries Feishu official resource download for image/file attachments
- Local inbox paths are passed to the backend session

Phase 3: multi-agent routing

- Sessions are backend/agent/command records
- Codex sessions can use `codex-app-server` and keep a `threadId`
- The tmux backend can start any command and is used as fallback when app-server fails
- Feishu chats/users/threads can map to different sessions
- Optional idle auto-stop is available via `FTB_IDLE_STOP_MS` and per-session `"idleStop": true`

## Backends

`codex-app-server` is the preferred backend for Codex. It starts one local
`codex app-server --listen ws://127.0.0.1:<port>` process and sends each Feishu
message as a structured `turn/start` request. The session stores the Codex
`threadId`, so future messages resume the same Codex thread without parsing a
terminal screen.

`tmux` remains available as a fallback. If a `codex-app-server` session fails
and the session does not set `"fallback": false`, the router sends the same
prompt to the session's `tmuxSession` and replies with the tmux result.
