import assert from 'node:assert/strict';
import test from 'node:test';

import {
  shouldUseTmuxFallback,
  userFacingSessionError,
} from '../lib/bridge-fallback.mjs';

test('tmux fallback is opt-in for codex app-server sessions', () => {
  const session = { backend: 'codex-app-server' };

  assert.equal(shouldUseTmuxFallback(session, { enableTmuxFallback: false }), false);
  assert.equal(shouldUseTmuxFallback(session, { enableTmuxFallback: true }), true);
  assert.equal(shouldUseTmuxFallback({ ...session, fallback: false }, { enableTmuxFallback: true }), false);
  assert.equal(shouldUseTmuxFallback({ backend: 'tmux' }, { enableTmuxFallback: true }), false);
});

test('codex completion timeout reports no tmux fallback', () => {
  const text = userFacingSessionError(
    new Error('Timed out waiting for turn/completed; interrupt requested'),
    'main',
  );

  assert.match(text, /处理超时/);
  assert.match(text, /不会切到 tmux fallback/);
  assert.doesNotMatch(text, /╭/);
});
