import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildReactionCreateArgv,
  buildReactionDeleteArgv,
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
