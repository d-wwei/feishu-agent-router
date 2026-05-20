import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPermissionActionValue,
  buildPermissionCallbackData,
  buildPermissionResultCard,
  buildPermissionResultCardPatchArgv,
  buildReactionCreateArgv,
  buildReactionDeleteArgv,
  buildStreamingCardDeleteArgv,
  buildStreamingCardPatchArgv,
  buildStreamingCardSendArgv,
  parsePermissionCallbackData,
  pickPhase1Emoji,
  pickPhase2Emojis,
} from '../lib/feishu-interactions.mjs';

test('pickPhase1Emoji returns contextual emoji or substantial fallback', () => {
  assert.equal(pickPhase1Emoji('hi there'), null);
  assert.equal(pickPhase1Emoji('你好'), null);
  assert.equal(pickPhase1Emoji('bye bye'), null);
  assert.equal(pickPhase1Emoji('再见'), null);
  assert.equal(pickPhase1Emoji('你好，帮我检查一下'), 'OnIt');
  assert.equal(pickPhase1Emoji('麻烦帮我检查一下报错'), 'OnIt');
  assert.equal(pickPhase1Emoji('tiny'), null);
  assert.equal(pickPhase1Emoji('please take a look'), 'THINKING');
});

test('pickPhase2Emojis returns up to two unique summary reactions', () => {
  const response = [
    '```js',
    'const message = "this code block is intentionally long enough to match";',
    'console.log(message);',
    '```',
    'fixed and completed',
    '| a | b |',
  ].join('\n');

  assert.deepEqual(pickPhase2Emojis('', response), ['DONE', 'CheckMark']);
  assert.deepEqual(pickPhase2Emojis('', response, { limit: 1 }), ['DONE']);
});

test('reaction argv builders target lark-cli reaction APIs', () => {
  assert.deepEqual(buildReactionCreateArgv({
    messageId: 'om_1',
    emojiType: 'THINKING',
    larkAs: 'bot',
  }), [
    'im',
    'reactions',
    'create',
    '--as',
    'bot',
    '--params',
    '{"message_id":"om_1"}',
    '--data',
    '{"reaction_type":{"emoji_type":"THINKING"}}',
  ]);

  assert.deepEqual(buildReactionDeleteArgv({
    messageId: 'om_1',
    reactionId: 'reaction_1',
    larkAs: 'user',
    dryRun: true,
  }), [
    'im',
    'reactions',
    'delete',
    '--as',
    'user',
    '--params',
    '{"message_id":"om_1","reaction_id":"reaction_1"}',
    '--dry-run',
  ]);
});

test('reaction argv builders can pin a lark profile', () => {
  assert.deepEqual(buildReactionCreateArgv({
    messageId: 'om_1',
    emojiType: 'THINKING',
    larkAs: 'bot',
    larkProfile: 'sales-bot',
  }).slice(0, 3), ['--profile', 'sales-bot', 'im']);
});

test('streaming card argv builders send, patch, and delete cards', () => {
  const sendArgv = buildStreamingCardSendArgv({
    chatId: 'oc_1',
    text: 'draft',
    idempotencyKey: 'idem-1',
  });
  assert.deepEqual(sendArgv.slice(0, 10), [
    'im',
    '+messages-send',
    '--as',
    'bot',
    '--chat-id',
    'oc_1',
    '--msg-type',
    'interactive',
    '--content',
    '{"config":{"wide_screen_mode":true},"elements":[{"tag":"markdown","content":"draft"},{"tag":"note","elements":[{"tag":"plain_text","content":"Generating..."}]}]}',
  ]);
  assert.deepEqual(sendArgv.slice(10), ['--idempotency-key', 'idem-1']);

  assert.deepEqual(buildStreamingCardPatchArgv({
    messageId: 'om_1',
    text: 'final',
    pending: false,
  }), [
    'api',
    'PATCH',
    '/open-apis/im/v1/messages/om_1',
    '--as',
    'bot',
    '--data',
    '{"content":"{\\"config\\":{\\"wide_screen_mode\\":true},\\"elements\\":[{\\"tag\\":\\"markdown\\",\\"content\\":\\"final\\"}]}"}',
  ]);

  assert.deepEqual(buildStreamingCardDeleteArgv({ messageId: 'om_1' }), [
    'im',
    'messages',
    'delete',
    '--as',
    'bot',
    '--params',
    '{"message_id":"om_1"}',
  ]);
});

test('permission callback helpers preserve permission ids containing colons', () => {
  const callbackData = buildPermissionCallbackData('allow_session', 'perm:with:colon');
  assert.equal(callbackData, 'perm:allow_session:perm:with:colon');

  assert.deepEqual(parsePermissionCallbackData({
    action: {
      value: {
        callbackData,
        chatId: 'oc_1',
      },
    },
    open_message_id: 'om_1',
  }), {
    ok: true,
    callbackData,
    action: 'allow_session',
    permissionId: 'perm:with:colon',
    chatId: 'oc_1',
    openMessageId: 'om_1',
    command: '/perm allow_session perm:with:colon',
  });

  assert.deepEqual(buildPermissionActionValue({
    action: 'deny',
    permissionId: 'perm_2',
    chatId: 'oc_2',
  }), {
    callbackData: 'perm:deny:perm_2',
    chatId: 'oc_2',
  });
});

test('permission result card reflects handled and selected state', () => {
  const handled = buildPermissionResultCard({
    callbackData: 'perm:deny:perm_1',
    handled: true,
  });
  assert.equal(handled.header.template, 'red');
  assert.equal(handled.header.title.content, 'Permission Resolved');
  assert.equal(handled.elements[2].actions[2].text.content, 'Deny Selected');
  assert.equal(handled.elements[2].actions[2].type, 'danger');

  const ignored = buildPermissionResultCard({
    callbackData: 'perm:allow:perm_1',
    handled: false,
  });
  assert.equal(ignored.header.template, 'grey');
  assert.match(ignored.elements[0].content, /already handled/);

  assert.deepEqual(buildPermissionResultCardPatchArgv({
    messageId: 'om_1',
    callbackData: 'perm:allow:perm_1',
    dryRun: true,
  }).slice(0, 6), [
    'api',
    'PATCH',
    '/open-apis/im/v1/messages/om_1',
    '--as',
    'bot',
    '--data',
  ]);
});

test('permission parser rejects malformed payloads', () => {
  assert.equal(parsePermissionCallbackData('').ok, false);
  assert.equal(parsePermissionCallbackData('other:allow:perm_1').ok, false);
  assert.equal(parsePermissionCallbackData('perm:maybe:perm_1').ok, false);
  assert.equal(parsePermissionCallbackData('perm:allow:').ok, false);
});
