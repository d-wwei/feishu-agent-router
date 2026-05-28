#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLarkCliArgs } from '../lib/lark-cli.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const HOME = os.homedir();
const cli = parseCli(process.argv.slice(2));
const INSTANCE_NAME = sanitizeInstanceName(cli.options.name || process.env.FTB_INSTANCE_NAME || '');
const LABEL = INSTANCE_NAME ? `com.feishu-agent-router.${INSTANCE_NAME}` : 'com.feishu-agent-router';
const PLIST_PATH = path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const ENV_PATH = path.resolve(cli.options.env || process.env.FTB_ENV_PATH || path.join(ROOT, '.env'));

loadDotEnv(ENV_PATH);

const FTB_HOME = cli.options.home
  ? path.resolve(cli.options.home)
  : env(
    'FTB_HOME',
    INSTANCE_NAME ? path.join(HOME, `.feishu-agent-router-${INSTANCE_NAME}`) : path.join(HOME, '.feishu-agent-router'),
  );
process.env.FTB_ENV_PATH = ENV_PATH;
process.env.FTB_HOME = FTB_HOME;
if (INSTANCE_NAME) {
  process.env.FTB_INSTANCE_NAME = INSTANCE_NAME;
} else {
  delete process.env.FTB_INSTANCE_NAME;
}
const LOG_DIR = path.join(FTB_HOME, 'logs');
const NODE = process.execPath;
const UID = process.getuid?.() ?? Number(run('id', ['-u']).trim());

fs.mkdirSync(LOG_DIR, { recursive: true });

const command = cli.command || 'help';
const rest = cli.args;

try {
  await main();
} catch (error) {
  console.error(`farctl: ${error.message || String(error)}`);
  process.exit(1);
}

async function main() {
  switch (command) {
    case 'install':
      install();
      break;
    case 'uninstall':
      uninstall();
      break;
    case 'start':
      start();
      break;
    case 'stop':
      stop();
      break;
    case 'restart':
      restart();
      break;
    case 'status':
      status();
      break;
    case 'logs':
      logs(rest);
      break;
    case 'allowlist-capture':
      await allowlistCapture(rest);
      break;
    case 'doctor':
      passthroughDoctor();
      break;
    case 'plist':
      process.stdout.write(renderPlist());
      break;
    case 'help':
    case '--help':
    case '-h':
      help();
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

function install() {
  if (!fs.existsSync(ENV_PATH)) {
    throw new Error(`Missing ${ENV_PATH}. Create it from .env.example first.`);
  }
  requireAccessPolicyForService();
  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  writePlist();
  bootstrap();
  console.log('Service installed and started.');
  status();
}

function uninstall() {
  bootout({ ignoreMissing: true });
  if (fs.existsSync(PLIST_PATH)) {
    fs.unlinkSync(PLIST_PATH);
    console.log(`Removed ${PLIST_PATH}`);
  }
  console.log('Service uninstalled. Runtime data was kept at:');
  console.log(FTB_HOME);
}

function start() {
  requireAccessPolicyForService();
  writePlist();
  bootstrap();
  status();
}

function stop() {
  bootout({ ignoreMissing: true });
  status();
}

function restart() {
  requireAccessPolicyForService();
  writePlist();
  bootstrap();
  status();
}

function status() {
  const result = spawnSync('launchctl', ['print', domainTarget()], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.log(`Service ${LABEL}: not loaded`);
    console.log(`plist: ${PLIST_PATH}`);
    return;
  }
  const pid = result.stdout.match(/\bpid = (\d+)/)?.[1];
  const state = result.stdout.match(/\bstate = ([^\n]+)/)?.[1]?.trim();
  console.log(`Service ${LABEL}: loaded`);
  console.log(`state: ${state || 'unknown'}`);
  console.log(`pid: ${pid || '-'}`);
  console.log(`plist: ${PLIST_PATH}`);
  console.log(`env: ${ENV_PATH}`);
  console.log(`home: ${FTB_HOME}`);
  const activeTurn = readJson(path.join(FTB_HOME, 'data', 'active-turn.json'), null);
  if (activeTurn) {
    console.log(`active_turn: ${activeTurn.sessionName || '-'} message=${activeTurn.messageId || '-'} started=${activeTurn.startedAt || '-'}`);
    if (activeTurn.contentPreview) console.log(`active_preview: ${activeTurn.contentPreview}`);
  } else {
    console.log('active_turn: none');
  }
}

function logs(args) {
  const kind = args[0] === 'err' ? 'err' : args[0] === 'out' ? 'out' : 'router';
  const file = kind === 'router'
    ? path.join(LOG_DIR, 'router.log')
    : path.join(LOG_DIR, `launchd.${kind}.log`);
  const lines = args.includes('-f') ? null : Number.parseInt(args.find((x) => /^\d+$/.test(x)) || '120', 10);
  if (!fs.existsSync(file)) {
    console.log(`No log file yet: ${file}`);
    return;
  }
  if (args.includes('-f')) {
    spawnSync('tail', ['-f', file], { stdio: 'inherit' });
  } else {
    spawnSync('tail', ['-n', String(lines), file], { stdio: 'inherit' });
  }
}

async function allowlistCapture(args) {
  const timeout = parseTimeoutArg(args, '120s');
  const dryRun = args.includes('--dry-run');
  const larkAs = env('FTB_LARK_AS', 'bot');
  const larkProfile = env('FTB_LARK_PROFILE', '');
  const larkAppId = env('FTB_LARK_APP_ID', '');
  if (!larkProfile || !larkAppId) {
    throw new Error(`Env ${ENV_PATH} must set FTB_LARK_PROFILE and FTB_LARK_APP_ID before allowlist capture.`);
  }

  const captureArgs = buildLarkCliArgs([
    'event',
    'consume',
    'im.message.receive_v1',
    '--as',
    larkAs,
    '--jq',
    '{message_id,chat_id,chat_type,sender_id}',
    '--timeout',
    timeout,
    '--quiet',
  ], { profile: larkProfile });

  if (!dryRun && isServiceLoaded()) {
    throw new Error([
      `Service ${LABEL} is running; stop it before allowlist-capture to avoid competing for the Feishu event stream.`,
      `Run: farctl${INSTANCE_NAME ? ` --name ${INSTANCE_NAME}` : ''} --env "${ENV_PATH}" --home "${FTB_HOME}" stop`,
      'Restart the service after the capture finishes.',
    ].join(' '));
  }

  console.log(`Capturing full Feishu sender_id/chat_id for ${LABEL}`);
  console.log(`profile: ${larkProfile}`);
  console.log(`app_id: ${larkAppId}`);
  console.log('Send one message to the bot now. Full IDs are printed only to this local stdout.');
  console.log('');

  if (dryRun) {
    console.log([`lark-cli`, ...captureArgs].join(' '));
    console.log('stdin: kept open by farctl to avoid EOF in agent subprocesses');
    return;
  }

  const child = spawn('lark-cli', captureArgs, {
    cwd: ROOT,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  child.stdin.write('\n');
  const killTimer = setTimeout(() => child.kill('SIGTERM'), durationMs(timeout) + 5_000);
  killTimer.unref?.();
  const status = await new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(killTimer);
  if (status.code && status.code !== 0) {
    throw new Error(`lark-cli event consume exited with code ${status.code}${status.signal ? ` signal ${status.signal}` : ''}`);
  }
}

function requireAccessPolicyForService() {
  const currentEnv = readDotEnv(ENV_PATH);
  const hasAllowlist = csv(currentEnv.FTB_ALLOWED_SENDERS).length > 0 || csv(currentEnv.FTB_ALLOWED_CHATS).length > 0;
  if (!hasAllowlist && !truthy(currentEnv.FTB_ALLOW_UNRESTRICTED)) {
    throw new Error([
      `Env file lacks an access allowlist: ${ENV_PATH}`,
      'Set FTB_ALLOWED_SENDERS or FTB_ALLOWED_CHATS before starting the bridge.',
      'Use FTB_ALLOW_UNRESTRICTED=true only for an intentionally public bridge.',
    ].join(' '));
  }
  const hasAdmins = csv(currentEnv.FTB_ADMIN_USERS).length > 0;
  if (!hasAdmins && !truthy(currentEnv.FTB_ALLOW_ADMIN_ALL)) {
    throw new Error([
      `Env file lacks admin policy: ${ENV_PATH}`,
      'Set FTB_ADMIN_USERS before starting the bridge.',
      'Use FTB_ALLOW_ADMIN_ALL=true only when every allowed sender should be an admin.',
    ].join(' '));
  }
}

function passthroughDoctor() {
  const doctorArgs = [
    path.join(ROOT, 'bin', 'doctor.mjs'),
    '--env',
    ENV_PATH,
    '--home',
    FTB_HOME,
  ];
  if (INSTANCE_NAME) doctorArgs.push('--name', INSTANCE_NAME);
  doctorArgs.push(...rest);
  const result = spawnSync(NODE, doctorArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      FTB_ENV_PATH: ENV_PATH,
      FTB_HOME,
      ...(INSTANCE_NAME ? { FTB_INSTANCE_NAME: INSTANCE_NAME } : {}),
    },
  });
  process.exitCode = result.status || 0;
}

function parseTimeoutArg(args, fallback) {
  const idx = args.indexOf('--timeout');
  if (idx >= 0) return args[idx + 1] || fallback;
  const inline = args.find((arg) => arg.startsWith('--timeout='));
  if (inline) return inline.slice('--timeout='.length) || fallback;
  return args.find((arg) => /^\d+[smh]?$/.test(arg)) || fallback;
}

function durationMs(value) {
  const match = String(value || '').trim().match(/^(\d+)(ms|s|m|h)?$/);
  if (!match) return 120_000;
  const amount = Number(match[1]);
  const unit = match[2] || 's';
  if (unit === 'ms') return amount;
  if (unit === 'm') return amount * 60_000;
  if (unit === 'h') return amount * 3_600_000;
  return amount * 1_000;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
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

function csv(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function writePlist() {
  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  const next = renderPlist();
  if (!fs.existsSync(PLIST_PATH)) {
    fs.writeFileSync(PLIST_PATH, next);
    console.log(`Installed ${PLIST_PATH}`);
    return;
  }
  const current = fs.readFileSync(PLIST_PATH, 'utf8');
  if (current !== next) {
    fs.writeFileSync(PLIST_PATH, next);
    console.log(`Updated ${PLIST_PATH} for env/home arguments`);
  }
}

function isServiceLoaded() {
  const result = spawnSync('launchctl', ['print', domainTarget()], { encoding: 'utf8' });
  return result.status === 0;
}

function bootstrap() {
  bootout({ ignoreMissing: true });
  const result = spawnSync('launchctl', ['bootstrap', `gui/${UID}`, PLIST_PATH], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'launchctl bootstrap failed');
  }
  spawnSync('launchctl', ['kickstart', '-k', domainTarget()], { encoding: 'utf8' });
}

function bootout({ ignoreMissing } = {}) {
  const result = spawnSync('launchctl', ['bootout', `gui/${UID}`, PLIST_PATH], { encoding: 'utf8' });
  if (result.status !== 0 && !ignoreMissing) {
    throw new Error(result.stderr || result.stdout || 'launchctl bootout failed');
  }
}

function domainTarget() {
  return `gui/${UID}/${LABEL}`;
}

function renderPlist() {
  const envObject = {
    PATH: [
      path.dirname(NODE),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ].join(':'),
    HOME,
    FTB_HOME,
    FTB_ENV_PATH: ENV_PATH,
    ...(INSTANCE_NAME ? { FTB_INSTANCE_NAME: INSTANCE_NAME } : {}),
  };

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(NODE)}</string>
    <string>${xml(path.join(ROOT, 'bin', 'bridge.mjs'))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(ROOT)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(envObject).map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`).join('\n')}
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(path.join(LOG_DIR, 'launchd.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(LOG_DIR, 'launchd.err.log'))}</string>
</dict>
</plist>
`;
}

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
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
    process.env[key] = value.replace(/\\"/g, '"');
  }
}

function parseCli(argv) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--name') {
      options.name = argv[++i] || '';
    } else if (token.startsWith('--name=')) {
      options.name = token.slice('--name='.length);
    } else if (token === '--env') {
      options.env = argv[++i] || '';
    } else if (token.startsWith('--env=')) {
      options.env = token.slice('--env='.length);
    } else if (token === '--home') {
      options.home = argv[++i] || '';
    } else if (token.startsWith('--home=')) {
      options.home = token.slice('--home='.length);
    } else {
      positional.push(token);
    }
  }
  return {
    command: positional[0],
    args: positional.slice(1),
    options,
  };
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

function env(name, fallback) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function help() {
  console.log(`Usage: farctl [--name <instance>] [--env <file>] <command>

Commands:
  install      Install launchd service and start it
  uninstall    Stop service and remove launchd plist
  start        Start service
  stop         Stop service
  restart      Restart service
  status       Show launchd status
  logs [kind]  Show logs; kind: router|out|err; add -f to follow
  allowlist-capture  Print full sender_id/chat_id from the next bot event
  doctor       Run environment checks
  plist        Print generated launchd plist

Options:
  --name NAME  Instance name. Default uses the legacy com.feishu-agent-router service.
  --env FILE   Env file for this instance. Default: ${path.join(ROOT, '.env')}
  --home DIR   Runtime state directory for this instance.

Examples:
  farctl install
  farctl --name sales --env .env.sales --home ~/.feishu-agent-router-sales install
  farctl --name sales --env .env.sales --home ~/.feishu-agent-router-sales allowlist-capture --timeout 120s
  farctl --name ops status

Notes:
  start/restart rewrite the launchd plist when --env or --home changes.
  allowlist-capture refuses while this service is loaded; stop it first to avoid competing for Feishu events.
`);
}
