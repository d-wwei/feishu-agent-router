import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCardContent,
  buildFinalCardContent,
  buildMessageContent,
  buildPermissionCardContent,
  buildPostContent,
  buildStreamingCardContent,
  formatElapsed,
  hasComplexMarkdown,
  preprocessFeishuMarkdown,
} from '../lib/feishu-render.mjs';

function parsePayload(payload) {
  return JSON.parse(payload.content);
}

test('detects code fences and markdown tables as complex markdown', () => {
  assert.equal(hasComplexMarkdown('plain **markdown**'), false);
  assert.equal(hasComplexMarkdown('before\n```js\nconsole.log(1)\n```'), true);
  assert.equal(hasComplexMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |'), true);
});

test('preprocessFeishuMarkdown preserves fence language tags', () => {
  assert.equal(
    preprocessFeishuMarkdown('intro```python\nprint(1)\n```'),
    'intro\n```python\nprint(1)\n```',
  );
});

test('buildPostContent creates a post payload with md text', () => {
  const payload = buildPostContent('hello **world**');
  const content = parsePayload(payload);

  assert.equal(payload.msg_type, 'post');
  assert.equal(content.zh_cn.content[0][0].tag, 'md');
  assert.equal(content.zh_cn.content[0][0].text, 'hello **world**');
});

test('buildCardContent creates a schema 2.0 interactive card payload', () => {
  const payload = buildCardContent('```sh\nnode --version\n```');
  const card = parsePayload(payload);

  assert.equal(payload.msg_type, 'interactive');
  assert.equal(card.schema, '2.0');
  assert.equal(card.body.elements[0].tag, 'markdown');
  assert.match(card.body.elements[0].content, /```sh/);
});

test('buildMessageContent selects post for simple text and card for complex text', () => {
  assert.equal(buildMessageContent('simple').msg_type, 'post');
  assert.equal(buildMessageContent('| A | B |\n| --- | --- |').msg_type, 'interactive');
});

test('buildPermissionCardContent includes action buttons and fallback commands', () => {
  const payload = buildPermissionCardContent({
    text: 'Need approval.',
    permissionRequestId: 'perm-123',
    chatId: 'oc_abc',
  });
  const card = parsePayload(payload);
  const actions = card.elements.find((element) => element.tag === 'action').actions;

  assert.equal(payload.msg_type, 'interactive');
  assert.equal(card.header.title.content, 'Permission Required');
  assert.equal(actions.length, 3);
  assert.equal(actions[0].value.callbackData, 'perm:allow:perm-123');
  assert.equal(actions[0].value.callback_data, 'perm:allow:perm-123');
  assert.equal(actions[0].value.chatId, 'oc_abc');
  assert.match(card.elements.at(-1).content, /\/perm deny perm-123/);
});

test('buildStreamingCardContent renders thinking state and tool progress', () => {
  const payload = buildStreamingCardContent('', {
    tools: [{ name: 'shell', status: 'running' }],
  });
  const card = parsePayload(payload);
  const markdown = card.body.elements[0].content;

  assert.equal(payload.msg_type, 'interactive');
  assert.equal(card.config.streaming_mode, true);
  assert.match(markdown, /Thinking/);
  assert.match(markdown, /\[Running\] `shell`/);
});

test('buildFinalCardContent renders final markdown and footer', () => {
  const payload = buildFinalCardContent('done', {
    tools: [{ name: 'test', status: 'complete' }],
    footer: { status: 'Completed', elapsedMs: 1250 },
  });
  const card = parsePayload(payload);
  const footer = card.body.elements.at(-1);

  assert.equal(card.config.streaming_mode, false);
  assert.match(card.body.elements[0].content, /\[Complete\] `test`/);
  assert.equal(footer.text_size, 'notation');
  assert.equal(footer.content, 'Completed | 1.3s');
});

test('formatElapsed formats common durations', () => {
  assert.equal(formatElapsed(42), '42ms');
  assert.equal(formatElapsed(1500), '1.5s');
  assert.equal(formatElapsed(62_000), '1m 2s');
});

