import assert from 'node:assert/strict';
import test from 'node:test';

import { isFeishuSelfSendReceipt } from '../lib/bridge-output.mjs';

test('detects Feishu self-send receipts from agent output', () => {
  assert.equal(isFeishuSelfSendReceipt([
    '已回复飞书：',
    '',
    '`当前工作目录是：/tmp/project`',
    '',
    '消息 ID：`om_x100b6fe8465118a4b11ea384c2e7f25`。',
  ].join('\n')), true);

  assert.equal(isFeishuSelfSendReceipt('Replied to Lark. message_id: om_1234567890abcdef'), true);
});

test('does not suppress normal answers that mention Feishu or message ids', () => {
  assert.equal(isFeishuSelfSendReceipt('当前工作目录是：/tmp/project'), false);
  assert.equal(isFeishuSelfSendReceipt('这条飞书消息的 id 形如 om_xxx。'), false);
  assert.equal(isFeishuSelfSendReceipt('已回复飞书：当前工作目录是 /tmp/project'), false);
  assert.equal(isFeishuSelfSendReceipt('排查结论：已回复飞书消息，消息 ID：om_1234567890abcdef。'), false);
});
