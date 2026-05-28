import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isManuallyStoppedSession,
  shouldUseTmuxFallback,
  shouldBypassGlobalQueue,
  stoppedSessionError,
  userFacingSessionError,
} from '../lib/bridge-fallback.mjs';
import {
  CODEX_TURN_IDLE_TIMEOUT,
  createCodexTurnTimeoutError,
} from '../lib/codex-turn-timeout.mjs';

test('tmux fallback is opt-in for codex app-server sessions', () => {
  const session = { backend: 'codex-app-server' };

  assert.equal(shouldUseTmuxFallback(session, { enableTmuxFallback: false }), false);
  assert.equal(shouldUseTmuxFallback(session, { enableTmuxFallback: true }), true);
  assert.equal(shouldUseTmuxFallback({ ...session, fallback: false }, { enableTmuxFallback: true }), false);
  assert.equal(shouldUseTmuxFallback({ backend: 'tmux' }, { enableTmuxFallback: true }), false);
});

test('tmux fallback ignores codex timeout and interrupt failures', () => {
  const session = { backend: 'codex-app-server' };

  assert.equal(
    shouldUseTmuxFallback(
      session,
      { enableTmuxFallback: true },
      createCodexTurnTimeoutError('idle', 10_000),
    ),
    false,
  );
  assert.equal(
    shouldUseTmuxFallback(
      session,
      { enableTmuxFallback: true },
      Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' }),
    ),
    false,
  );
  assert.equal(
    shouldUseTmuxFallback(
      session,
      { enableTmuxFallback: true },
      Object.assign(new Error('Codex turn interrupted by /interrupt'), { code: 'TURN_INTERRUPTED' }),
    ),
    false,
  );
  assert.equal(
    shouldUseTmuxFallback(
      session,
      { enableTmuxFallback: true },
      Object.assign(new Error('idle timeout'), { code: CODEX_TURN_IDLE_TIMEOUT }),
    ),
    false,
  );
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

test('interrupt and status commands bypass the global turn queue', () => {
  assert.equal(shouldBypassGlobalQueue('/interrupt main'), true);
  assert.equal(shouldBypassGlobalQueue('/status'), true);
  assert.equal(shouldBypassGlobalQueue('/send main hello'), false);
  assert.equal(shouldBypassGlobalQueue('hello'), false);
});

test('manual codex app-server stop rejects normal sends until restart clears stop marker', () => {
  assert.equal(isManuallyStoppedSession({
    backend: 'codex-app-server',
    state: 'stopped',
    stopReason: 'manual',
  }), true);
  assert.equal(isManuallyStoppedSession({
    backend: 'codex-app-server',
    state: 'stopped',
  }), false);
  assert.equal(isManuallyStoppedSession({
    backend: 'tmux',
    state: 'stopped',
    stopReason: 'manual',
  }), false);

  const text = userFacingSessionError(stoppedSessionError('main'), 'main');
  assert.match(text, /已停止/);
  assert.match(text, /\/restart main/);
});
