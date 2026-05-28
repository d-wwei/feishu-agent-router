import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateAllowlist,
  extractIgnoredPolicyEvents,
} from '../lib/allowlist-policy.mjs';

test('evaluateAllowlist reports sender mismatch with remediation', () => {
  const result = evaluateAllowlist(
    { sender_id: 'ou_new', chat_id: 'oc_ok' },
    { allowedSenders: ['ou_old'], allowedChats: [] },
  );

  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'sender not in FTB_ALLOWED_SENDERS');
  assert.equal(result.field, 'sender_id');
  assert.match(result.remediation.join('\n'), /open_id is app-scoped/);
});

test('evaluateAllowlist fails closed when no allowlist is configured', () => {
  const result = evaluateAllowlist(
    { sender_id: 'ou_any', chat_id: 'oc_any' },
    { allowedSenders: [], allowedChats: [] },
  );

  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'missing FTB_ALLOWED_SENDERS or FTB_ALLOWED_CHATS');
  assert.equal(result.field, 'allowlist');
  assert.match(result.remediation.join('\n'), /FTB_ALLOW_UNRESTRICTED=true/);
});

test('evaluateAllowlist can be explicitly unrestricted', () => {
  const result = evaluateAllowlist(
    { sender_id: 'ou_any', chat_id: 'oc_any' },
    { allowedSenders: [], allowedChats: [], allowUnrestricted: true },
  );

  assert.equal(result.allowed, true);
});

test('evaluateAllowlist reports chat mismatch after sender matches', () => {
  const result = evaluateAllowlist(
    { sender_id: 'ou_ok', chat_id: 'oc_new' },
    { allowedSenders: ['ou_ok'], allowedChats: ['oc_old'] },
  );

  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'chat not in FTB_ALLOWED_CHATS');
  assert.equal(result.field, 'chat_id');
});

test('extractIgnoredPolicyEvents parses recent structured router logs', () => {
  const events = extractIgnoredPolicyEvents([
    '[2026-05-20T00:00:00.000Z] ignored event by policy {"messageId":"om1","reason":"sender not in FTB_ALLOWED_SENDERS"}',
    '[2026-05-20T00:00:01.000Z] received message {"messageId":"om2"}',
    '[2026-05-20T00:00:02.000Z] ignored event by policy {"messageId":"om3","reason":"chat not in FTB_ALLOWED_CHATS"}',
  ].join('\n'), { limit: 1 });

  assert.deepEqual(events, [{ messageId: 'om3', reason: 'chat not in FTB_ALLOWED_CHATS' }]);
});
