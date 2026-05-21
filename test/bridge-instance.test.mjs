import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  ], {
    encoding: 'utf8',
    cwd: root,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^FTB_LARK_PROFILE=sales-bot$/m);
  assert.match(result.stdout, /^FTB_LARK_APP_ID=cli_sales$/m);
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
    '--workdir',
    '/tmp/path with spaces',
  ], {
    encoding: 'utf8',
    cwd: root,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^FTB_AGENT_CMD="codex --no-alt-screen --cd '\/tmp\/path with spaces' --sandbox danger-full-access -a never"$/m);
});
