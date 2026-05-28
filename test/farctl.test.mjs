import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const farctl = path.join(root, 'bin', 'farctl.mjs');
const envFile = path.join(root, '.env.example');

test('farctl plist defaults to the legacy singleton service label', () => {
  const result = spawnSync(process.execPath, [farctl, '--env', envFile, '--home', '/tmp/far-default', 'plist'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /<string>com\.feishu-agent-router<\/string>/);
  assert.doesNotMatch(result.stdout, /FTB_INSTANCE_NAME/);
  assert.match(result.stdout, /<key>FTB_ENV_PATH<\/key>/);
  assert.match(result.stdout, /<string>\/tmp\/far-default<\/string>/);
});

test('farctl plist isolates named instances by label and runtime home', () => {
  const result = spawnSync(
    process.execPath,
    [farctl, '--name', 'Sales Bot', '--env', envFile, '--home', '/tmp/far-sales', 'plist'],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /<string>com\.feishu-agent-router\.sales-bot<\/string>/);
  assert.match(result.stdout, /<key>FTB_INSTANCE_NAME<\/key>\n    <string>sales-bot<\/string>/);
  assert.match(result.stdout, /<key>FTB_HOME<\/key>\n    <string>\/tmp\/far-sales<\/string>/);
});

test('farctl allowlist-capture dry-run pins profile and keeps stdin open', () => {
  const result = spawnSync(
    process.execPath,
    [farctl, '--name', 'Sales Bot', '--env', envFile, '--home', '/tmp/far-sales', 'allowlist-capture', '--timeout', '5s', '--dry-run'],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--profile bot-profile-name event consume im\.message\.receive_v1/);
  assert.match(result.stdout, /{message_id,chat_id,chat_type,sender_id}/);
  assert.doesNotMatch(result.stdout, /content/);
  assert.match(result.stdout, /--timeout 5s/);
  assert.match(result.stdout, /stdin: kept open/);
});

test('farctl doctor diagnoses the CLI env and home overrides', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'farctl-doctor-'));
  const customEnv = path.join(tmp, 'custom.env');
  const customHome = path.join(tmp, 'home');
  fs.writeFileSync(customEnv, [
    'FTB_LARK_PROFILE=doctor-bot',
    'FTB_LARK_APP_ID=cli_doctor',
    'FTB_HOME=/tmp/wrong-home',
    '',
  ].join('\n'));

  const result = spawnSync(process.execPath, [
    farctl,
    '--env',
    customEnv,
    '--home',
    customHome,
    'doctor',
  ], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`env -> ${escapeRegExp(customEnv)}`));
  assert.match(result.stdout, new RegExp(`no router log yet -> ${escapeRegExp(path.join(customHome, 'logs', 'router.log'))}`));
});

test('farctl start rewrites an existing plist when env or home changes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'farctl-plist-'));
  const fakeBin = path.join(tmp, 'bin');
  const home = path.join(tmp, 'home');
  const oldEnv = path.join(tmp, 'old.env');
  const newEnv = path.join(tmp, 'new.env');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(oldEnv, 'FTB_LARK_PROFILE=old\nFTB_LARK_APP_ID=cli_old\nFTB_ALLOWED_SENDERS=ou_old\nFTB_ADMIN_USERS=ou_old\n');
  fs.writeFileSync(newEnv, 'FTB_LARK_PROFILE=new\nFTB_LARK_APP_ID=cli_new\nFTB_ALLOWED_SENDERS=ou_new\nFTB_ADMIN_USERS=ou_new\n');
  fs.writeFileSync(path.join(fakeBin, 'launchctl'), [
    '#!/bin/sh',
    'if [ "$1" = "print" ]; then',
    '  printf "state = running\\npid = 123\\n"',
    'fi',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });

  const env = { ...process.env, HOME: home, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` };
  const first = spawnSync(process.execPath, [
    farctl,
    '--name',
    'sales',
    '--env',
    oldEnv,
    '--home',
    path.join(tmp, 'old-home'),
    'start',
  ], { encoding: 'utf8', env });
  assert.equal(first.status, 0, first.stderr);

  const second = spawnSync(process.execPath, [
    farctl,
    '--name',
    'sales',
    '--env',
    newEnv,
    '--home',
    path.join(tmp, 'new-home'),
    'start',
  ], { encoding: 'utf8', env });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Updated .*com\.feishu-agent-router\.sales\.plist/);

  const plist = fs.readFileSync(path.join(home, 'Library', 'LaunchAgents', 'com.feishu-agent-router.sales.plist'), 'utf8');
  assert.match(plist, new RegExp(escapeRegExp(newEnv)));
  assert.match(plist, new RegExp(escapeRegExp(path.join(tmp, 'new-home'))));
  assert.doesNotMatch(plist, new RegExp(escapeRegExp(path.join(tmp, 'old-home'))));
});

test('farctl start refuses env without access policy', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'farctl-policy-'));
  const home = path.join(tmp, 'home');
  const customEnv = path.join(tmp, 'open.env');
  fs.writeFileSync(customEnv, 'FTB_LARK_PROFILE=open\nFTB_LARK_APP_ID=cli_open\n');

  const result = spawnSync(process.execPath, [
    farctl,
    '--env',
    customEnv,
    '--home',
    home,
    'start',
  ], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FTB_ALLOWED_SENDERS or FTB_ALLOWED_CHATS/);
});

test('farctl start refuses env without admin policy', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'farctl-admin-policy-'));
  const home = path.join(tmp, 'home');
  const customEnv = path.join(tmp, 'no-admin.env');
  fs.writeFileSync(customEnv, 'FTB_LARK_PROFILE=open\nFTB_LARK_APP_ID=cli_open\nFTB_ALLOWED_SENDERS=ou_one\n');

  const result = spawnSync(process.execPath, [
    farctl,
    '--env',
    customEnv,
    '--home',
    home,
    'start',
  ], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FTB_ADMIN_USERS/);
});

test('farctl allowlist-capture refuses while the matching launchd service is loaded', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'farctl-capture-'));
  const fakeBin = path.join(tmp, 'bin');
  const home = path.join(tmp, 'home');
  const customEnv = path.join(tmp, 'capture.env');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(customEnv, 'FTB_LARK_PROFILE=capture-bot\nFTB_LARK_APP_ID=cli_capture\n');
  fs.writeFileSync(path.join(fakeBin, 'launchctl'), [
    '#!/bin/sh',
    'if [ "$1" = "print" ]; then',
    '  printf "state = running\\npid = 321\\n"',
    '  exit 0',
    'fi',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });

  const result = spawnSync(process.execPath, [
    farctl,
    '--name',
    'sales',
    '--env',
    customEnv,
    '--home',
    home,
    'allowlist-capture',
    '--timeout',
    '1s',
  ], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /stop it before allowlist-capture/);
  assert.match(result.stderr, /competing for the Feishu event stream/);
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
