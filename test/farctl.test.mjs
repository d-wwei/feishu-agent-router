import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  assert.match(result.stdout, /--timeout 5s/);
  assert.match(result.stdout, /stdin: kept open/);
});
