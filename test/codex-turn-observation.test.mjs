import assert from 'node:assert/strict';
import test from 'node:test';
import { codexActivityDetail, formatInactivityNotice } from '../lib/codex-turn-observation.mjs';

test('tool output and reasoning progress count as activity without exposing their content', () => {
  for (const method of [
    'item/agentMessage/delta',
    'item/commandExecution/outputDelta',
    'item/fileChange/outputDelta',
    'item/reasoning/textDelta',
    'item/reasoning/summaryTextDelta',
    'item/plan/delta',
    'item/mcpToolCall/progress',
  ]) {
    const detail = codexActivityDetail({ method, params: { delta: 'private payload', message: 'private payload' } });
    assert.equal(typeof detail, 'string', method);
    assert.ok(!detail.includes('private payload'));
  }
  assert.equal(codexActivityDetail({ method: 'item/started', params: { item: { type: 'commandExecution' } } }), 'commandExecution');
});

test('warnings, retries, bookkeeping and unknown events do not hide inactivity', () => {
  for (const method of ['warning', 'error', 'thread/tokenUsage/updated', 'thread/status/changed', 'unknown']) {
    assert.equal(codexActivityDetail({ method, params: { delta: 'noise', willRetry: true } }), null);
  }
  assert.equal(codexActivityDetail({ method: 'item/agentMessage/delta', params: { delta: '' } }), null);
});

test('inactivity notice explicitly keeps the task and offers manual control', () => {
  for (const health of ['responding', 'unconfirmed']) {
    const text = formatInactivityNotice({ kind: 'idle', thresholdMs: 300000, health }, 'main');
    assert.match(text, /没有自动中断/);
    assert.match(text, /\/status main/);
    assert.match(text, /\/interrupt main/);
    assert.doesNotMatch(text, /已经中断|已经停止|自动重试/);
  }
});
