import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildLarkCliArgs,
  parseLarkProfileList,
  resolveLarkBotIdentity,
  safeLarkBotLockKey,
} from '../lib/lark-cli.mjs';

test('buildLarkCliArgs prefixes explicit lark-cli profile before command', () => {
  assert.deepEqual(
    buildLarkCliArgs(['event', 'consume', 'im.message.receive_v1'], { profile: 'bot-sales' }),
    ['--profile', 'bot-sales', 'event', 'consume', 'im.message.receive_v1'],
  );

  assert.deepEqual(
    buildLarkCliArgs(['im', '+messages-reply'], { profile: '' }),
    ['im', '+messages-reply'],
  );
});

test('resolveLarkBotIdentity prefers app id for uniqueness', () => {
  const profiles = parseLarkProfileList(JSON.stringify([
    { name: 'default', appId: 'cli_old', active: true },
    { name: 'sales', appId: 'cli_sales', active: false },
  ]));

  assert.deepEqual(resolveLarkBotIdentity({ profiles, profile: 'sales' }), {
    profile: 'sales',
    appId: 'cli_sales',
    key: 'app:cli_sales',
  });

  assert.deepEqual(resolveLarkBotIdentity({ profiles, appId: 'cli_manual' }), {
    profile: '',
    appId: 'cli_manual',
    key: 'app:cli_manual',
  });
});

test('safeLarkBotLockKey is stable for filesystem locks', () => {
  assert.equal(safeLarkBotLockKey('app:cli_aa819ca3c4b8dbc3'), 'app-cli_aa819ca3c4b8dbc3');
});
