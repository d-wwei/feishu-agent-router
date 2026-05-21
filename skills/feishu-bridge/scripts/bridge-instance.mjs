#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const REPO_FALLBACK = '/Users/admin/Documents/AI/feishu-agent-router';
const args = parseArgs(process.argv.slice(2));

try {
  main();
} catch (error) {
  console.error(`bridge-instance: ${error.message || String(error)}`);
  process.exit(1);
}

function main() {
  const command = normalizeInitCommand(args.command || 'help');
  if (['help', '--help', '-h'].includes(command)) {
    help();
    return;
  }

  const routerRoot = resolveRouterRoot(args.options.routerRoot);
  const farctl = path.join(routerRoot, 'bin', 'farctl.mjs');
  if (!fs.existsSync(farctl)) {
    throw new Error(`Missing farctl at ${farctl}. Pass --router-root /path/to/feishu-agent-router.`);
  }

  const instanceName = sanitizeInstanceName(args.options.name || process.env.FTB_INSTANCE_NAME || 'default');
  const fileName = instanceName || 'default';
  const baseCwd = path.resolve(args.options.cwd || process.cwd());
  const envPath = path.resolve(args.options.env || path.join(baseCwd, '.feishu-bridge', `${fileName}.env`));
  const homePath = path.resolve(args.options.home || defaultHome(instanceName));

  if (command === 'print-env') {
    rejectUnexpectedRest(command);
    requireExplicitBotInfo();
    process.stdout.write(renderEnv({ routerRoot, instanceName, envPath, homePath, baseCwd }));
    return;
  }

  if (command === 'init') {
    rejectUnexpectedRest(command);
    requireExplicitBotInfo();
    maybeCreateLarkProfile();
    writeEnvFile({ routerRoot, instanceName, envPath, homePath, baseCwd, force: Boolean(args.options.force) });
    console.log(`env: ${envPath}`);
    console.log(`home: ${homePath}`);
    return;
  }

  const farctlCommand = normalizeCommand(command);
  const shouldEnsureEnv = ['install', 'start', 'restart', 'doctor', 'plist'].includes(farctlCommand);
  if (shouldEnsureEnv && !fs.existsSync(envPath)) {
    requireExplicitBotInfo();
    maybeCreateLarkProfile();
    writeEnvFile({ routerRoot, instanceName, envPath, homePath, baseCwd, force: false });
  }
  if (['install', 'start', 'restart', 'allowlist-capture', 'doctor', 'plist'].includes(farctlCommand)) {
    requireEnvHasExplicitBotInfo(envPath);
  }

  const farctlArgs = [];
  if (instanceName) farctlArgs.push('--name', instanceName);
  farctlArgs.push('--env', envPath, '--home', homePath, farctlCommand, ...args.rest);

  if (args.options.dryRun) {
    console.log([process.execPath, farctl, ...farctlArgs].join(' '));
    return;
  }

  const result = spawnSync(process.execPath, [farctl, ...farctlArgs], {
    cwd: routerRoot,
    stdio: 'inherit',
  });
  process.exitCode = result.status || 0;
}

function resolveRouterRoot(raw) {
  const candidates = [
    raw,
    process.env.FEISHU_AGENT_ROUTER_ROOT,
    path.resolve(SCRIPT_DIR, '..', '..', '..'),
    REPO_FALLBACK,
  ].filter(Boolean).map((candidate) => path.resolve(candidate));

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'bin', 'farctl.mjs'))) return candidate;
  }
  return candidates[0] || REPO_FALLBACK;
}

function writeEnvFile({ routerRoot, instanceName, envPath, homePath, baseCwd, force }) {
  if (fs.existsSync(envPath) && !force) {
    console.log(`Keeping existing env: ${envPath}`);
    return;
  }
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, renderEnv({ routerRoot, instanceName, envPath, homePath, baseCwd }));
  fs.chmodSync(envPath, 0o600);
  console.log(`${force ? 'Rewrote' : 'Created'} env: ${envPath}`);
}

function renderEnv({ instanceName, homePath, baseCwd }) {
  const fileName = instanceName || 'default';
  const workdir = path.resolve(args.options.workdir || baseCwd);
  const allowedSenders = optionOrEnv('allowedSenders', 'FTB_ALLOWED_SENDERS', '');
  const adminUsers = optionOrEnv('adminUsers', 'FTB_ADMIN_USERS', allowedSenders);
  const larkProfile = optionOrEnv('larkProfile', 'FTB_LARK_PROFILE', '');
  const larkAppId = optionOrEnv('botAppId', 'FTB_LARK_APP_ID', '');
  const values = {
    FTB_INSTANCE_NAME: instanceName,
    FTB_LARK_AS: optionOrEnv('larkAs', 'FTB_LARK_AS', 'bot'),
    FTB_LARK_PROFILE: larkProfile,
    FTB_LARK_APP_ID: larkAppId,
    FTB_ALLOWED_SENDERS: allowedSenders,
    FTB_ALLOWED_CHATS: optionOrEnv('allowedChats', 'FTB_ALLOWED_CHATS', ''),
    FTB_ADMIN_USERS: adminUsers,
    FTB_AUTO_CREATE_GROUP_SESSIONS: optionOrEnv('autoGroup', 'FTB_AUTO_CREATE_GROUP_SESSIONS', 'true'),
    FTB_AUTO_GROUP_SESSION_PREFIX: optionOrEnv('autoGroupPrefix', 'FTB_AUTO_GROUP_SESSION_PREFIX', 'group'),
    FTB_GROUP_REQUIRE_COMMAND: optionOrEnv('groupRequireCommand', 'FTB_GROUP_REQUIRE_COMMAND', 'true'),
    FTB_HOME: homePath,
    FTB_DEFAULT_SESSION: optionOrEnv('defaultSession', 'FTB_DEFAULT_SESSION', 'main'),
    FTB_DEFAULT_BACKEND: optionOrEnv('defaultBackend', 'FTB_DEFAULT_BACKEND', 'codex-app-server'),
    FTB_DEFAULT_AGENT: optionOrEnv('defaultAgent', 'FTB_DEFAULT_AGENT', 'codex'),
    FTB_TMUX_SESSION: optionOrEnv('tmuxSession', 'FTB_TMUX_SESSION', `far-${fileName}`),
    FTB_WORKDIR: workdir,
    FTB_AGENT_CMD: optionOrEnv(
      'agentCmd',
      'FTB_AGENT_CMD',
      `codex --no-alt-screen --cd ${shellQuote(workdir)} --sandbox danger-full-access -a never`,
    ),
    FTB_CODEX_PATH: optionOrEnv('codexPath', 'FTB_CODEX_PATH', 'codex'),
    FTB_CODEX_APP_SERVER_LISTEN: optionOrEnv('codexAppServerListen', 'FTB_CODEX_APP_SERVER_LISTEN', 'stdio://'),
    FTB_CODEX_PROFILE: optionOrEnv('codexProfile', 'FTB_CODEX_PROFILE', ''),
    FTB_CODEX_MODEL: optionOrEnv('codexModel', 'FTB_CODEX_MODEL', ''),
    FTB_CODEX_MODEL_PROVIDER: optionOrEnv('codexModelProvider', 'FTB_CODEX_MODEL_PROVIDER', ''),
    FTB_CODEX_SERVICE_TIER: optionOrEnv('codexServiceTier', 'FTB_CODEX_SERVICE_TIER', ''),
    FTB_CODEX_REASONING_EFFORT: optionOrEnv('codexReasoningEffort', 'FTB_CODEX_REASONING_EFFORT', 'medium'),
    FTB_CODEX_SANDBOX: optionOrEnv('codexSandbox', 'FTB_CODEX_SANDBOX', 'danger-full-access'),
    FTB_CODEX_APPROVAL_POLICY: optionOrEnv('codexApprovalPolicy', 'FTB_CODEX_APPROVAL_POLICY', 'never'),
    FTB_CODEX_NETWORK_ACCESS: optionOrEnv('codexNetworkAccess', 'FTB_CODEX_NETWORK_ACCESS', 'true'),
    FTB_CODEX_AUTO_APPROVE_REQUESTS: optionOrEnv('codexAutoApproveRequests', 'FTB_CODEX_AUTO_APPROVE_REQUESTS', 'true'),
    FTB_CODEX_RESPONSES_WEBSOCKETS: optionOrEnv('codexResponsesWebSockets', 'FTB_CODEX_RESPONSES_WEBSOCKETS', 'false'),
    FTB_CODEX_FORCE_RESPONSES_HTTP: optionOrEnv('codexForceResponsesHttp', 'FTB_CODEX_FORCE_RESPONSES_HTTP', 'false'),
    FTB_CODEX_HTTP_PROVIDER_ID: optionOrEnv('codexHttpProviderId', 'FTB_CODEX_HTTP_PROVIDER_ID', 'chatgpt_http'),
    FTB_CODEX_HTTP_PROVIDER_NAME: optionOrEnv('codexHttpProviderName', 'FTB_CODEX_HTTP_PROVIDER_NAME', 'ChatGPT HTTP'),
    FTB_CODEX_HTTP_PROVIDER_BASE_URL: optionOrEnv('codexHttpProviderBaseUrl', 'FTB_CODEX_HTTP_PROVIDER_BASE_URL', 'https://chatgpt.com/backend-api/codex'),
    FTB_ENABLE_TMUX_FALLBACK: optionOrEnv('enableTmuxFallback', 'FTB_ENABLE_TMUX_FALLBACK', 'false'),
    FTB_PREWARM_CODEX: optionOrEnv('prewarmCodex', 'FTB_PREWARM_CODEX', 'true'),
    FTB_PREWARM_SESSIONS: optionOrEnv('prewarmSessions', 'FTB_PREWARM_SESSIONS', 'main'),
    FTB_PREWARM_TURN: optionOrEnv('prewarmTurn', 'FTB_PREWARM_TURN', 'false'),
    FTB_CODEX_REQUEST_TIMEOUT_MS: optionOrEnv('codexRequestTimeoutMs', 'FTB_CODEX_REQUEST_TIMEOUT_MS', '120000'),
    FTB_CODEX_START_TIMEOUT_MS: optionOrEnv('codexStartTimeoutMs', 'FTB_CODEX_START_TIMEOUT_MS', '8000'),
    FTB_CODEX_FIRST_OUTPUT_TIMEOUT_MS: optionOrEnv('codexFirstOutputTimeoutMs', 'FTB_CODEX_FIRST_OUTPUT_TIMEOUT_MS', '90000'),
    FTB_CODEX_TURN_IDLE_TIMEOUT_MS: optionOrEnv('codexTurnIdleTimeoutMs', 'FTB_CODEX_TURN_IDLE_TIMEOUT_MS', '300000'),
    FTB_CODEX_TURN_HARD_TIMEOUT_MS: optionOrEnv('codexTurnHardTimeoutMs', 'FTB_CODEX_TURN_HARD_TIMEOUT_MS', '0'),
    FTB_FEISHU_RICH_REPLIES: optionOrEnv('feishuRichReplies', 'FTB_FEISHU_RICH_REPLIES', 'true'),
    FTB_FEISHU_REACTIONS: optionOrEnv('feishuReactions', 'FTB_FEISHU_REACTIONS', 'true'),
    FTB_FEISHU_STREAMING: optionOrEnv('feishuStreaming', 'FTB_FEISHU_STREAMING', 'auto'),
    FTB_COLD_START_CARD_DELAY_MS: optionOrEnv('coldStartCardDelayMs', 'FTB_COLD_START_CARD_DELAY_MS', '1500'),
    FTB_FEISHU_STREAM_START_DELAY_MS: optionOrEnv('feishuStreamStartDelayMs', 'FTB_FEISHU_STREAM_START_DELAY_MS', '5000'),
    FTB_FEISHU_STREAM_MIN_CHARS: optionOrEnv('feishuStreamMinChars', 'FTB_FEISHU_STREAM_MIN_CHARS', '240'),
    FTB_FEISHU_STREAM_PATCH_MS: optionOrEnv('feishuStreamPatchMs', 'FTB_FEISHU_STREAM_PATCH_MS', '2000'),
    FTB_MAX_WAIT_MS: optionOrEnv('maxWaitMs', 'FTB_MAX_WAIT_MS', '90000'),
    FTB_STABLE_MS: optionOrEnv('stableMs', 'FTB_STABLE_MS', '3500'),
    FTB_POLL_MS: optionOrEnv('pollMs', 'FTB_POLL_MS', '1000'),
    FTB_CAPTURE_LINES: optionOrEnv('captureLines', 'FTB_CAPTURE_LINES', '1200'),
    FTB_REPLY_MAX_CHARS: optionOrEnv('replyMaxChars', 'FTB_REPLY_MAX_CHARS', '3500'),
    FTB_RESTART_DELAY_MS: optionOrEnv('restartDelayMs', 'FTB_RESTART_DELAY_MS', '3000'),
    FTB_IDLE_STOP_MS: optionOrEnv('idleStopMs', 'FTB_IDLE_STOP_MS', '0'),
  };

  for (const [key, value] of Object.entries(args.options.set || {})) {
    if (!key.startsWith('FTB_')) throw new Error(`--set only accepts FTB_* keys: ${key}`);
    values[key] = value;
  }

  return [
    '# Generated by feishu-bridge/scripts/bridge-instance.mjs',
    '# Feishu identities and credentials are read from the local lark-cli configuration.',
    ...Object.entries(values)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => `${key}=${dotenvValue(value)}`),
    '',
  ].join('\n');
}

function optionOrEnv(optionKey, envKey, fallback) {
  const value = args.options[optionKey];
  if (value !== undefined && value !== '') return String(value);
  const envValue = process.env[envKey];
  if (envValue !== undefined && envValue !== '') return envValue;
  return fallback;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function requireExplicitBotInfo() {
  const profile = optionOrEnv('larkProfile', 'FTB_LARK_PROFILE', '');
  const appId = optionOrEnv('botAppId', 'FTB_LARK_APP_ID', '');
  if (!profile || !appId) {
    const instance = args.options.name || '<instance>';
    const workdir = args.options.workdir || '$PWD';
    throw new Error([
      'Explicit Feishu bot information is required for a bridge instance.',
      'Pass --lark-profile <profile-name> and --bot-app-id <cli_xxx>.',
      'Create the profile first with lark-cli profile add, or pass --create-lark-profile with --bot-app-secret-stdin.',
      'Example:',
      `node "$SKILL_DIR/scripts/bridge-instance.mjs" init --name ${instance} --lark-profile <profile-name> --bot-app-id <cli_xxx> --allowed-senders <sender_open_id> --admin-users <sender_open_id> --workdir "${workdir}"`,
    ].join(' '));
  }
}

function requireEnvHasExplicitBotInfo(envPath) {
  if (!fs.existsSync(envPath)) return;
  const env = readDotEnv(envPath);
  if (!env.FTB_LARK_PROFILE || !env.FTB_LARK_APP_ID) {
    throw new Error([
      `Env file lacks explicit bot binding: ${envPath}`,
      'Refusing to use the active lark-cli bot implicitly.',
      'Regenerate it with init --force --lark-profile <profile-name> --bot-app-id <cli_xxx>.',
    ].join(' '));
  }
}

function maybeCreateLarkProfile() {
  if (!args.options.createLarkProfile) return;
  const profile = optionOrEnv('larkProfile', 'FTB_LARK_PROFILE', '');
  const appId = optionOrEnv('botAppId', 'FTB_LARK_APP_ID', '');
  const secret = readBotAppSecret();
  if (!secret) throw new Error('Creating a lark profile requires --bot-app-secret-stdin or --bot-app-secret-env <NAME>.');
  const result = spawnSync('lark-cli', ['profile', 'add', '--name', profile, '--app-id', appId, '--app-secret-stdin'], {
    input: secret,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `lark-cli profile add failed for ${profile}`);
  }
  console.log(`Created lark-cli profile: ${profile}`);
}

function readBotAppSecret() {
  if (args.options.botAppSecretEnv) {
    return process.env[args.options.botAppSecretEnv] || '';
  }
  if (args.options.botAppSecretStdin) {
    return fs.readFileSync(0, 'utf8').trim();
  }
  return '';
}

function readDotEnv(file) {
  const result = {};
  if (!fs.existsSync(file)) return result;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value.replace(/\\"/g, '"');
  }
  return result;
}

function dotenvValue(value) {
  const text = String(value ?? '');
  if (/[\n\r]/.test(text)) throw new Error('Env values cannot contain newlines.');
  if (text === '' || /^[A-Za-z0-9_./:@,+-]+$/.test(text)) return text;
  return JSON.stringify(text);
}

function defaultHome(instanceName) {
  if (!instanceName) return path.join(os.homedir(), '.feishu-agent-router');
  return path.join(os.homedir(), `.feishu-agent-router-${instanceName}`);
}

function normalizeCommand(command) {
  const aliases = {
    tail: 'logs',
    remove: 'uninstall',
  };
  const normalized = aliases[command] || command;
  const allowed = new Set(['install', 'uninstall', 'start', 'stop', 'restart', 'status', 'logs', 'allowlist-capture', 'doctor', 'plist']);
  if (!allowed.has(normalized)) {
    throw new Error(`Unknown command: ${command}. Run help for usage.`);
  }
  return normalized;
}

function rejectUnexpectedRest(command) {
  if (args.rest.length > 0) {
    throw new Error(`Unexpected argument(s) for ${command}: ${args.rest.join(' ')}`);
  }
}

function parseArgs(argv) {
  const options = { set: {} };
  const positional = [];
  let afterDoubleDash = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (afterDoubleDash) {
      positional.push(token);
      continue;
    }
    if (token === '--') {
      afterDoubleDash = true;
      continue;
    }
    if (!token.startsWith('--') || token === '-') {
      positional.push(token);
      continue;
    }

    const rawOption = token.slice(2);
    const eqIndex = rawOption.indexOf('=');
    const rawKey = eqIndex >= 0 ? rawOption.slice(0, eqIndex) : rawOption;
    const inlineValue = eqIndex >= 0 ? rawOption.slice(eqIndex + 1) : undefined;
    const key = optionKey(rawKey);
    if (key === 'force' || key === 'dryRun' || key === 'createLarkProfile' || key === 'botAppSecretStdin') {
      options[key] = true;
      continue;
    }
    const value = inlineValue !== undefined ? inlineValue : argv[++i];
    if (value === undefined) throw new Error(`Missing value for --${rawKey}`);
    if (key === 'set') {
      const eq = value.indexOf('=');
      if (eq <= 0) throw new Error('--set expects KEY=VALUE');
      options.set[value.slice(0, eq)] = value.slice(eq + 1);
    } else {
      options[key] = value;
    }
  }

  return {
    command: positional[0],
    rest: positional.slice(1),
    options,
  };
}

function optionKey(raw) {
  const aliases = {
    name: 'name',
    env: 'env',
    home: 'home',
    cwd: 'cwd',
    dir: 'cwd',
    'router-root': 'routerRoot',
    'lark-as': 'larkAs',
    'lark-profile': 'larkProfile',
    'bot-app-id': 'botAppId',
    'create-lark-profile': 'createLarkProfile',
    'bot-app-secret-stdin': 'botAppSecretStdin',
    'bot-app-secret-env': 'botAppSecretEnv',
    'allowed-senders': 'allowedSenders',
    'allowed-chats': 'allowedChats',
    'admin-users': 'adminUsers',
    'auto-group': 'autoGroup',
    'auto-group-prefix': 'autoGroupPrefix',
    'group-require-command': 'groupRequireCommand',
    'default-session': 'defaultSession',
    'default-backend': 'defaultBackend',
    'default-agent': 'defaultAgent',
    'tmux-session': 'tmuxSession',
    workdir: 'workdir',
    'agent-cmd': 'agentCmd',
    'codex-path': 'codexPath',
    'codex-listen': 'codexAppServerListen',
    'codex-profile': 'codexProfile',
    'codex-model': 'codexModel',
    'codex-model-provider': 'codexModelProvider',
    'codex-service-tier': 'codexServiceTier',
    'reasoning-effort': 'codexReasoningEffort',
    'codex-sandbox': 'codexSandbox',
    'approval-policy': 'codexApprovalPolicy',
    'network-access': 'codexNetworkAccess',
    'auto-approve-requests': 'codexAutoApproveRequests',
    'responses-websockets': 'codexResponsesWebSockets',
    'force-responses-http': 'codexForceResponsesHttp',
    'http-provider-id': 'codexHttpProviderId',
    'http-provider-name': 'codexHttpProviderName',
    'http-provider-base-url': 'codexHttpProviderBaseUrl',
    'prewarm-codex': 'prewarmCodex',
    'prewarm-sessions': 'prewarmSessions',
    'prewarm-turn': 'prewarmTurn',
    'request-timeout-ms': 'codexRequestTimeoutMs',
    'start-timeout-ms': 'codexStartTimeoutMs',
    'first-output-timeout-ms': 'codexFirstOutputTimeoutMs',
    'rich-replies': 'feishuRichReplies',
    reactions: 'feishuReactions',
    streaming: 'feishuStreaming',
    'cold-start-card-delay-ms': 'coldStartCardDelayMs',
    'stream-start-delay-ms': 'feishuStreamStartDelayMs',
    'stream-min-chars': 'feishuStreamMinChars',
    'stream-patch-ms': 'feishuStreamPatchMs',
    'max-wait-ms': 'maxWaitMs',
    'stable-ms': 'stableMs',
    'poll-ms': 'pollMs',
    'capture-lines': 'captureLines',
    'reply-max-chars': 'replyMaxChars',
    'restart-delay-ms': 'restartDelayMs',
    'idle-stop-ms': 'idleStopMs',
    set: 'set',
    force: 'force',
    'dry-run': 'dryRun',
  };
  const key = aliases[raw];
  if (!key) throw new Error(`Unknown option: --${raw}`);
  return key;
}

function normalizeInitCommand(command) {
  if (command === 'setup' || command === 'configure') return 'init';
  return command;
}

function sanitizeInstanceName(value) {
  const name = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!name || name === 'default') return '';
  return name.slice(0, 48);
}

function help() {
  console.log(`Usage: bridge-instance.mjs <command> [options] [farctl args]

Commands:
  init          Generate .feishu-bridge/<instance>.env
  print-env     Print the generated env to stdout
  install       Generate env if needed, then install and start launchd service
  start         Start service
  stop          Stop service
  restart       Restart service
  status        Show launchd status
  logs          Show logs; pass router|out|err, a line count, or -f
  allowlist-capture
               Print full sender_id/chat_id from the next bot event
  doctor        Run router environment checks
  plist         Print generated launchd plist
  uninstall     Stop service and remove launchd plist

Core options:
  --name NAME                 Instance name; "default" uses singleton farctl service
  --env FILE                  Env file path; default: .feishu-bridge/<instance>.env
  --home DIR                  Runtime state path; default: ~/.feishu-agent-router-<instance>
  --cwd DIR                   Directory for default env placement
  --router-root DIR           feishu-agent-router repository path
  --lark-profile NAME         Required lark-cli profile for this Feishu bot
  --bot-app-id APP_ID         Required Feishu/Lark app id for uniqueness locks
  --create-lark-profile       Run lark-cli profile add before writing env
  --bot-app-secret-stdin      Read app secret from stdin for profile creation
  --bot-app-secret-env NAME   Read app secret from an environment variable
  --allowed-senders IDS       Comma-separated Feishu user IDs
  --allowed-chats IDS         Comma-separated Feishu chat IDs
  --admin-users IDS           Comma-separated admin user IDs
  --workdir DIR               Default agent working directory
  --agent-cmd CMD             tmux fallback command
  --codex-listen URL          Codex app-server transport: stdio:// or unix://PATH
  --force-responses-http BOOL Force Codex provider wire_api="responses"
  --prewarm-sessions NAMES    Comma-separated Codex sessions to prewarm
  --set FTB_KEY=VALUE         Override a generated FTB_* value
  --force                     Rewrite existing env on init
  --dry-run                   Print farctl invocation without running it

Examples:
  bridge-instance.mjs init --name sales --lark-profile sales-bot --bot-app-id cli_xxx --allowed-senders ou_xxx --admin-users ou_xxx
  bridge-instance.mjs install --name sales
  bridge-instance.mjs allowlist-capture --name sales --timeout 120s
  bridge-instance.mjs logs --name sales -f
`);
}
