import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgeInstance = path.join(root, 'skills', 'feishu-bridge', 'scripts', 'bridge-instance.mjs');

test('bridge-instance refuses to generate env without explicit bot profile and app id', () => {
  const result = spawnSync(process.execPath, [bridgeInstance, 'print-env', '--name', 'sales'], {
    encoding: 'utf8',
    cwd: root,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--lark-profile/);
  assert.match(result.stderr, /--bot-app-id/);
  assert.match(result.stderr, /bridge-instance\.mjs" init --name sales/);
});

test('bridge-instance generated env pins lark profile and app id', () => {
  const result = spawnSync(process.execPath, [
    bridgeInstance,
    'print-env',
    '--name',
    'sales',
    '--lark-profile',
    'sales-bot',
    '--bot-app-id',
    'cli_sales',
    '--allowed-senders',
    'ou_sales',
  ], {
    encoding: 'utf8',
    cwd: root,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^FTB_LARK_PROFILE=sales-bot$/m);
  assert.match(result.stdout, /^FTB_LARK_APP_ID=cli_sales$/m);
  assert.match(result.stdout, /^FTB_ALLOWED_SENDERS=ou_sales$/m);
  assert.match(result.stdout, /^FTB_ADMIN_USERS=$/m);
  assert.match(result.stdout, /^FTB_ENABLE_TMUX_FALLBACK=false$/m);
  assert.match(result.stdout, /^FTB_CODEX_FORCE_RESPONSES_HTTP=false$/m);
  assert.match(result.stdout, /^FTB_CODEX_TURN_HARD_TIMEOUT_MS=0$/m);
});

test('bridge-instance quotes workdir in fallback agent command', () => {
  const result = spawnSync(process.execPath, [
    bridgeInstance,
    'print-env',
    '--name',
    'sales',
    '--lark-profile',
    'sales-bot',
    '--bot-app-id',
    'cli_sales',
    '--allowed-senders',
    'ou_sales',
    '--workdir',
    '/tmp/path with spaces',
  ], {
    encoding: 'utf8',
    cwd: root,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^FTB_AGENT_CMD="codex --no-alt-screen --cd '\/tmp\/path with spaces' --sandbox danger-full-access -a never"$/m);
});

test('bridge-instance reuses registered env and home for named instances from another cwd', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-instance-registry-'));
  const home = path.join(tmp, 'home');
  const firstCwd = path.join(tmp, 'first');
  const secondCwd = path.join(tmp, 'second');
  fs.mkdirSync(firstCwd, { recursive: true });
  fs.mkdirSync(secondCwd, { recursive: true });

  const init = spawnSync(process.execPath, [
    bridgeInstance,
    'init',
    '--name',
    'sales',
    '--lark-profile',
    'sales-bot',
    '--bot-app-id',
    'cli_sales',
    '--allowed-senders',
    'ou_sales',
  ], {
    encoding: 'utf8',
    cwd: firstCwd,
    env: { ...process.env, HOME: home },
  });
  assert.equal(init.status, 0, init.stderr);

  const expectedEnv = path.join(fs.realpathSync(firstCwd), '.feishu-bridge', 'sales.env');
  const expectedHome = path.join(home, '.feishu-agent-router-sales');
  const status = spawnSync(process.execPath, [
    bridgeInstance,
    'status',
    '--name',
    'sales',
    '--dry-run',
  ], {
    encoding: 'utf8',
    cwd: secondCwd,
    env: { ...process.env, HOME: home },
  });

  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, new RegExp(`--env ${escapeRegExp(expectedEnv)}`));
  assert.match(status.stdout, new RegExp(`--home ${escapeRegExp(expectedHome)}`));
  assert.doesNotMatch(status.stdout, new RegExp(escapeRegExp(path.join(secondCwd, '.feishu-bridge', 'sales.env'))));
});

test('bridge-instance prefers existing launchd plist env and home over cwd defaults', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-instance-plist-'));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'cwd');
  const plistDir = path.join(home, 'Library', 'LaunchAgents');
  const actualEnv = path.join(tmp, 'actual.env');
  const actualHome = path.join(tmp, 'actual-home');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(plistDir, { recursive: true });
  fs.writeFileSync(actualEnv, [
    'FTB_LARK_PROFILE=sales-bot',
    'FTB_LARK_APP_ID=cli_sales',
    'FTB_ALLOWED_SENDERS=ou_sales',
    'FTB_ADMIN_USERS=ou_admin',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(plistDir, 'com.feishu-agent-router.sales.plist'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    '<key>EnvironmentVariables</key><dict>',
    '<key>FTB_ENV_PATH</key>',
    `<string>${actualEnv}</string>`,
    '<key>FTB_HOME</key>',
    `<string>${actualHome}</string>`,
    '<key>FTB_INSTANCE_NAME</key>',
    '<string>sales</string>',
    '</dict>',
    '</dict></plist>',
    '',
  ].join('\n'));

  const status = spawnSync(process.execPath, [
    bridgeInstance,
    'status',
    '--name',
    'sales',
    '--dry-run',
  ], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, HOME: home },
  });

  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, new RegExp(`--env ${escapeRegExp(actualEnv)}`));
  assert.match(status.stdout, new RegExp(`--home ${escapeRegExp(actualHome)}`));
  assert.doesNotMatch(status.stdout, new RegExp(escapeRegExp(path.join(cwd, '.feishu-bridge', 'sales.env'))));
});

test('bridge-instance refuses to start without access and admin policies', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-instance-policy-'));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });

  const result = spawnSync(process.execPath, [
    bridgeInstance,
    'install',
    '--name',
    'sales',
    '--lark-profile',
    'sales-bot',
    '--bot-app-id',
    'cli_sales',
    '--dry-run',
  ], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, HOME: home },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FTB_ALLOWED_SENDERS or FTB_ALLOWED_CHATS/);
});

test('bridge-instance refuses to start with allowlist but no admin policy', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-instance-admin-policy-'));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });

  const result = spawnSync(process.execPath, [
    bridgeInstance,
    'install',
    '--name',
    'sales',
    '--lark-profile',
    'sales-bot',
    '--bot-app-id',
    'cli_sales',
    '--allowed-senders',
    'ou_sales',
    '--dry-run',
  ], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, HOME: home },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FTB_ADMIN_USERS/);
});

test('bridge-instance can explicitly generate an unrestricted admin-all bridge', () => {
  const result = spawnSync(process.execPath, [
    bridgeInstance,
    'print-env',
    '--name',
    'public',
    '--lark-profile',
    'public-bot',
    '--bot-app-id',
    'cli_public',
    '--allow-unrestricted',
    'true',
    '--allow-admin-all',
    'true',
  ], {
    encoding: 'utf8',
    cwd: root,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^FTB_ALLOW_UNRESTRICTED=true$/m);
  assert.match(result.stdout, /^FTB_ALLOW_ADMIN_ALL=true$/m);
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
