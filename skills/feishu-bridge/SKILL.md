---
name: feishu-bridge
description: Manage a Feishu/Lark-to-Codex bridge instance backed by the local feishu-agent-router repository. Use when the user wants to configure, install, start, restart, stop, inspect status, tail logs, diagnose, or uninstall a Feishu bridge for remote Codex control from Feishu. Trigger on feishu-bridge, 飞书桥接, Feishu bridge, Lark bridge, mobile Codex, 手机上用 Codex, farctl, bridge instance, start bridge, stop bridge, bridge status, bridge logs, or connect Codex to Feishu.
---

# Feishu Bridge

Use this skill to manage Feishu Agent Router as a local launchd service. The skill is a thin operational wrapper: it does not duplicate router code, and all service lifecycle work goes through the repository's `farctl` CLI.

## Quick Start

Resolve the skill directory first, then run the helper:

```bash
node "$SKILL_DIR/scripts/bridge-instance.mjs" init --name <instance> --lark-profile <profile> --bot-app-id <cli_xxx> --allowed-senders <ou_xxx> --admin-users <ou_xxx> --workdir "$PWD"
node "$SKILL_DIR/scripts/bridge-instance.mjs" install --name <instance>
node "$SKILL_DIR/scripts/bridge-instance.mjs" status --name <instance>
```

If the user has not chosen an instance name, use `default` only when they clearly want the singleton service. Otherwise choose a short, stable name such as `sales`, `ops`, or the project name.

Never install a new bridge by implicitly reusing the active `lark-cli` bot. For every new bridge setup, ask the user for the new Feishu bot/app's `lark-cli` profile name and app ID. If the profile does not exist, ask for the app secret and create it with:

```bash
printf '%s' "$FEISHU_APP_SECRET" | lark-cli profile add --name <profile> --app-id <cli_xxx> --app-secret-stdin
```

## Commands

Run all commands from any working directory. By default the helper stores per-directory env files under `.feishu-bridge/<instance>.env` and runtime data under `~/.feishu-agent-router-<instance>`.

```bash
node "$SKILL_DIR/scripts/bridge-instance.mjs" init --name sales --lark-profile sales-bot --bot-app-id cli_xxx
node "$SKILL_DIR/scripts/bridge-instance.mjs" install --name sales
node "$SKILL_DIR/scripts/bridge-instance.mjs" restart --name sales
node "$SKILL_DIR/scripts/bridge-instance.mjs" status --name sales
node "$SKILL_DIR/scripts/bridge-instance.mjs" logs --name sales 200
node "$SKILL_DIR/scripts/bridge-instance.mjs" logs --name sales -f
node "$SKILL_DIR/scripts/bridge-instance.mjs" allowlist-capture --name sales --timeout 120s
node "$SKILL_DIR/scripts/bridge-instance.mjs" doctor --name sales
node "$SKILL_DIR/scripts/bridge-instance.mjs" uninstall --name sales
```

Use `--router-root /path/to/feishu-agent-router` if the repository is not at `/Users/admin/Documents/AI/feishu-agent-router` and the skill is not being run from the repository copy.

## Configuration

Important options:

- `--name <instance>`: maps to `farctl --name`; `default` uses the legacy singleton label.
- `--env <file>`: explicit env path; otherwise `.feishu-bridge/<instance>.env` in the current directory.
- `--home <dir>`: runtime state/log path; otherwise `~/.feishu-agent-router-<instance>`.
- `--lark-profile <profile>`: required for setup; explicit `lark-cli` profile for this Feishu bot.
- `--bot-app-id <cli_xxx>`: required for setup; Feishu/Lark app ID used for uniqueness locks.
- `--create-lark-profile`: create the `lark-cli` profile during setup.
- `--bot-app-secret-stdin`: read the app secret from stdin when creating the profile.
- `--bot-app-secret-env <name>`: read the app secret from an environment variable when creating the profile.
- `--allowed-senders <ids>`: comma-separated Feishu user IDs allowed to talk to the bridge.
- `--allowed-chats <ids>`: comma-separated Feishu chat IDs allowed to talk to the bridge.
- `--admin-users <ids>`: comma-separated Feishu user IDs allowed to run admin commands.
- `--lark-as <bot|user>`: identity passed to `lark-cli`.
- `--workdir <dir>`: default Codex working directory for new sessions.
- `--agent-cmd <cmd>`: tmux fallback command.
- `--set KEY=VALUE`: override any generated `FTB_*` env key.
- `--force`: rewrite an existing generated env file.

Do not put app secrets in command-line arguments. Use `--bot-app-secret-stdin` or `--bot-app-secret-env` only when creating a profile. The generated router env stores profile/app ID, not the app secret.

`FTB_ALLOWED_SENDERS` uses `im.message.receive_v1.sender_id`, which is a Feishu `open_id`. `open_id` is app-scoped, so changing the bot/app can change the same user's ID. After creating a new bot profile, run:

```bash
node "$SKILL_DIR/scripts/bridge-instance.mjs" allowlist-capture --name <instance> --timeout 120s
```

Then send one message to the bot and copy the printed full `sender_id` into `FTB_ALLOWED_SENDERS` and `FTB_ADMIN_USERS`.

## Workflow

1. For setup, first ask for the new bot profile and app ID. If the profile does not exist, ask for the app secret and create the profile without switching the global active profile.
2. Run `init` with `--lark-profile`, `--bot-app-id`, and explicit allowlists. If allowlists are unknown, create the env file with placeholders and tell the user which `FTB_ALLOWED_*` values must be filled before install.
3. For lifecycle actions, run the matching helper command. `install`, `start`, and `restart` create the env file only when explicit bot info was provided.
4. For "bot online but not replying", prefer `doctor`, then `logs 200`. If logs show `ignored event by policy`, run `allowlist-capture --timeout 120s` and update `FTB_ALLOWED_SENDERS` because open_id changes across bot apps.
5. For multiple bots, always use distinct `--lark-profile`, `--bot-app-id`, `--name`, `--env`, and `--home` values. The helper's defaults already isolate named env/home paths.

## Safety

Do not edit launchd plists by hand. Do not start the router with missing allowlists unless the user explicitly accepts that configuration. Do not run two router instances for the same `--bot-app-id`; the router has a global lock and will reject duplicates. Prefer `uninstall` over deleting plist files manually; it keeps runtime data in place for inspection.

When using raw `lark-cli event consume` from an agent subprocess, keep stdin open with `< <(tail -f /dev/null)`. The helper's `allowlist-capture` command already does this.
