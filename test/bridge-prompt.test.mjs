import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bridgeDeveloperInstructions,
  buildPrompt,
} from '../lib/bridge-prompt.mjs';

test('per-turn Feishu prompt keeps only message metadata and user content', () => {
  const prompt = buildPrompt(
    {
      sender_id: 'ou_sender',
      chat_id: 'oc_chat',
    },
    '你好',
    'main',
    '/tmp/inbox/om_1',
  );

  assert.match(prompt, /\[Feishu message\]/);
  assert.match(prompt, /session: main/);
  assert.match(prompt, /sender_open_id: ou_sender/);
  assert.match(prompt, /chat_id: oc_chat/);
  assert.match(prompt, /inbox_dir: \/tmp\/inbox\/om_1/);
  assert.match(prompt, /\[User message\]\n你好/);
  assert.doesNotMatch(prompt, /\[Router reply contract\]/);
  assert.doesNotMatch(prompt, /Do not call lark-cli/);
  assert.doesNotMatch(prompt, /The router will send that text back to Feishu/);
});

test('per-turn Feishu prompt prefers normalized promptText projections', () => {
  const prompt = buildPrompt(
    {
      sender_id: 'ou_sender',
      chat_id: 'oc_chat',
    },
    '[business_card] cards=1 status=parsed textItems=1 actions=0 refs=0 entities=0',
    'main',
    '/tmp/inbox/om_card',
    {
      text: '[business_card] cards=1 status=parsed textItems=1 actions=0 refs=0 entities=0',
      promptText: '业务卡片可见内容摘要',
    },
  );

  assert.match(prompt, /\[User message\]\n业务卡片可见内容摘要/);
  assert.doesNotMatch(prompt, /cards=1 status=parsed/);
});

test('Feishu bridge delivery rules live in developer instructions', () => {
  const instructions = bridgeDeveloperInstructions();

  assert.match(instructions, /do not send, reply, update, delete, or react/i);
  assert.match(instructions, /feishu-agent-router will deliver it to Feishu/i);
  assert.match(instructions, /Treat that metadata as context/);
});
