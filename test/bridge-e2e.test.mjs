import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridge = path.join(root, 'bin', 'bridge.mjs');

test('bridge process consumes a Feishu event and replies through lark-cli', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-e2e-'));
  const fakeBin = path.join(tmp, 'bin');
  const home = path.join(tmp, 'home');
  const envPath = path.join(tmp, 'bridge.env');
  const callsPath = path.join(tmp, 'lark-calls.jsonl');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(envPath, [
    'FTB_LARK_AS=bot',
    'FTB_LARK_PROFILE=e2e-bot',
    'FTB_LARK_APP_ID=cli_e2e',
    'FTB_ALLOWED_SENDERS=ou_e2e',
    'FTB_ADMIN_USERS=ou_e2e',
    `FTB_HOME=${home}`,
    'FTB_DEFAULT_BACKEND=codex-app-server',
    'FTB_PREWARM_CODEX=false',
    'FTB_FEISHU_REACTIONS=false',
    'FTB_FEISHU_STREAMING=off',
    'FTB_FEISHU_RICH_REPLIES=false',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(fakeBin, 'lark-cli'), fakeLarkCliScript(), { mode: 0o755 });

  const child = spawn(process.execPath, [bridge], {
    cwd: root,
    env: {
      ...process.env,
      FTB_ENV_PATH: envPath,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      FAKE_LARK_CALLS: callsPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  try {
    await waitFor(() => {
      const calls = readCalls(callsPath);
      return calls.some((call) =>
        call.args.includes('+messages-reply') &&
        call.args.includes('--message-id') &&
        call.args.includes('om_e2e') &&
        call.args.includes('pong'));
    }, 5000);
  } finally {
    child.kill('SIGTERM');
    await onceExit(child, 3000);
  }

  const calls = readCalls(callsPath);
  assert.ok(calls.some((call) => call.args.includes('event') && call.args.includes('consume')));
  assert.ok(calls.some((call) => call.args.includes('+messages-reply') && call.args.includes('pong')));
  assert.match(fs.readFileSync(path.join(home, 'logs', 'router.log'), 'utf8'), /received message/);
  assert.doesNotMatch(stderr, /Error|Exception/i);
  assert.match(stdout, /starting router/);
});

function fakeLarkCliScript() {
  return `#!/usr/bin/env node
const fs = require('fs');
const callsPath = process.env.FAKE_LARK_CALLS;
const args = process.argv.slice(2);
if (callsPath) fs.appendFileSync(callsPath, JSON.stringify({ args }) + '\\n');
if (args.includes('event') && args.includes('consume')) {
  console.log(JSON.stringify({
    event_id: 'ev_e2e',
    message_id: 'om_e2e',
    id: 'om_e2e',
    chat_id: 'oc_e2e',
    chat_type: 'p2p',
    sender_id: 'ou_e2e',
    message_type: 'text',
    content: JSON.stringify({ text: '/ping' }),
    create_time: String(Date.now())
  }));
  process.stdin.resume();
  setInterval(() => {}, 1000);
} else if (args.includes('+messages-reply')) {
  console.log(JSON.stringify({ data: { message_id: 'om_reply' } }));
} else {
  console.log(JSON.stringify({ ok: true }));
}
`;
}

function readCalls(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for bridge e2e condition');
}

async function onceExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
