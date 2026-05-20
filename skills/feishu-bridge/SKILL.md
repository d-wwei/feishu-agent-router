---
name: feishu-bridge
description: Manage a Feishu/Lark-to-Codex bridge instance backed by the local feishu-agent-router repository. Use when the user wants to configure, install, start, restart, stop, inspect status, tail logs, diagnose, or uninstall a Feishu bridge for remote Codex control from Feishu. Trigger on feishu-bridge, 飞书桥接, Feishu bridge, Lark bridge, mobile Codex, 手机上用 Codex, farctl, bridge instance, start bridge, stop bridge, bridge status, bridge logs, or connect Codex to Feishu.
---

# Feishu Bridge

Use this skill to manage Feishu Agent Router as a local launchd service. The skill is a thin operational wrapper: it does not duplicate router code, and all service lifecycle work goes through the repository's `farctl` CLI.

## Quick Start

Resolve the skill directory first, then run the helper:

```bash
node "$SKILL_DIR/scripts/bridge-instance.mjs" init --name <instance> --allowed-senders <ou_xxx> --admin-users <ou_xxx> --workdir "$PWD"
node "$SKILL_DIR/scripts/bridge-instance.mjs" install --name <instance>
node "$SKILL_DIR/scripts/bridge-instance.mjs" status --name <instance>
```

If the user has not chosen an instance name, use `default` only when they clearly want the singleton service. Otherwise choose a short, stable name such as `sales`, `ops`, or the project name.

## Commands

Run all commands from any working directory. By default the helper stores per-directory env files under `.feishu-bridge/<instance>.env` and runtime data under `~/.feishu-agent-router-<instance>`.

```bash
node "$SKILL_DIR/scripts/bridge-instance.mjs" init --name sales
node "$SKILL_DIR/scripts/bridge-instance.mjs" install --name sales
node "$SKILL_DIR/scripts/bridge-instance.mjs" restart --name sales
node "$SKILL_DIR/scripts/bridge-instance.mjs" status --name sales
node "$SKILL_DIR/scripts/bridge-instance.mjs" logs --name sales 200
node "$SKILL_DIR/scripts/bridge-instance.mjs" logs --name sales -f
node "$SKILL_DIR/scripts/bridge-instance.mjs" doctor --name sales
node "$SKILL_DIR/scripts/bridge-instance.mjs" uninstall --name sales
```

Use `--router-root /path/to/feishu-agent-router` if the repository is not at `/Users/admin/Documents/AI/feishu-agent-router` and the skill is not being run from the repository copy.

## Configuration

Important options:

- `--name <instance>`: maps to `farctl --name`; `default` uses the legacy singleton label.
- `--env <file>`: explicit env path; otherwise `.feishu-bridge/<instance>.env` in the current directory.
- `--home <dir>`: runtime state/log path; otherwise `~/.feishu-agent-router-<instance>`.
- `--allowed-senders <ids>`: comma-separated Feishu user IDs allowed to talk to the bridge.
- `--allowed-chats <ids>`: comma-separated Feishu chat IDs allowed to talk to the bridge.
- `--admin-users <ids>`: comma-separated Feishu user IDs allowed to run admin commands.
- `--lark-as <bot|user>`: identity passed to `lark-cli`.
- `--workdir <dir>`: default Codex working directory for new sessions.
- `--agent-cmd <cmd>`: tmux fallback command.
- `--set KEY=VALUE`: override any generated `FTB_*` env key.
- `--force`: rewrite an existing generated env file.

Secrets are not collected by this skill. Feishu credentials and login state come from the existing local `lark-cli` configuration.

## Workflow

1. For setup, run `init` with explicit allowlists. If allowlists are unknown, create the env file with placeholders and tell the user which `FTB_ALLOWED_*` values must be filled before install.
2. For lifecycle actions, run the matching helper command. `install`, `start`, and `restart` create the env file if it is missing.
3. For "not responding", prefer `doctor`, then `status`, then `logs 200`.
4. For multiple bots, always use distinct `--name`, `--env`, and `--home` values. The helper's defaults already do this for named instances.

## Safety

Do not edit launchd plists by hand. Do not start the router with missing allowlists unless the user explicitly accepts that configuration. Prefer `uninstall` over deleting plist files manually; it keeps runtime data in place for inspection.
