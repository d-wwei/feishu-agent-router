import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildMessageGetArgs,
  buildMergeForwardGetArgs,
  buildLarkCliResourceDownloadArgs,
  buildMergeForwardFetchArgs,
  createInboxEntryLike,
  extractFileKey,
  fetchMessageWithLarkCli,
  hydrateAttachmentEvent,
  fetchMergeForwardItemsWithLarkCli,
  hydrateMergeForwardEvent,
  normalizeInboundEvent,
  parsePostContent,
  parseTextContent,
  stripMentionMarkers,
} from '../lib/feishu-ingest.mjs';

test('parseTextContent handles Feishu JSON and raw text', () => {
  assert.equal(parseTextContent('{"text":"hello"}'), 'hello');
  assert.equal(parseTextContent('plain'), 'plain');
});

test('parsePostContent extracts rich text and image keys', () => {
  const post = {
    title: 'Title',
    content: [
      [
        { tag: 'text', text: 'See ' },
        { tag: 'a', text: 'doc', href: 'https://example.com' },
        { tag: 'img', image_key: 'img_123' },
      ],
      [{ tag: 'text', text: 'second line' }],
    ],
  };
  const parsed = parsePostContent(JSON.stringify(post));
  assert.equal(parsed.extractedText, 'Title\nSee doc (https://example.com)\nsecond line');
  assert.deepEqual(parsed.imageKeys, ['img_123']);
});

test('extractFileKey accepts known key spellings', () => {
  assert.equal(extractFileKey('{"image_key":"img_a"}'), 'img_a');
  assert.equal(extractFileKey('{"fileKey":"file_a"}'), 'file_a');
  assert.equal(extractFileKey('{"video_key":"vid_a"}'), 'vid_a');
  assert.equal(extractFileKey('<file key="file_v3_0011s_abc" name="测试账号(1).rtf"/>'), 'file_v3_0011s_abc');
  assert.equal(extractFileKey('not-json'), null);
});

test('normalizeInboundEvent builds download plans for file tag content', () => {
  const normalized = normalizeInboundEvent({
    message_id: 'om_file_tag',
    chat_id: 'oc1',
    sender_id: 'ou1',
    message_type: 'file',
    content: '<file key="file_v3_0011s_abc" name="测试账号(1).rtf"/>',
  });

  assert.equal(normalized.text, '[文件: file_v3_0011s_abc]');
  assert.deepEqual(corePlans(normalized.downloadPlans), [{
    messageId: 'om_file_tag',
    fileKey: 'file_v3_0011s_abc',
    messageType: 'file',
    resourceType: 'file',
    label: 'file',
    suggestedName: '测试账号(1).rtf',
  }]);
  assert.deepEqual(normalized.unsupportedReasons, []);
});

test('stripMentionMarkers removes Feishu mention placeholders', () => {
  assert.equal(stripMentionMarkers('@_user_1  hello <at user_id="ou_x">Bot</at>'), 'hello');
});

test('normalizeInboundEvent keeps ordinary text out of log and active previews', () => {
  const normalized = normalizeInboundEvent({
    message_id: 'om_secret_text',
    message_type: 'text',
    content: '{"text":"secret-token-123 https://example.com/path?token=secret#frag"}',
  });

  assert.match(normalized.promptText, /secret-token-123/);
  assert.match(normalized.logPreview, /^\[text\] messageType=text chars=/);
  assert.equal(normalized.activePreview, normalized.logPreview);
  assert.doesNotMatch(normalized.logPreview, /secret-token-123|token=secret|example\.com/);
});

test('normalizeInboundEvent builds download plans for post images', () => {
  const normalized = normalizeInboundEvent({
    event_id: 'ev1',
    message_id: 'om1',
    chat_id: 'oc1',
    sender_id: 'ou1',
    message_type: 'post',
    content: JSON.stringify({ content: [[{ tag: 'text', text: 'look' }, { tag: 'img', image_key: 'img_x' }]] }),
    create_time: '1700000000000',
  });

  assert.equal(normalized.text, 'look');
  assert.equal(normalized.timestamp, 1700000000000);
  assert.deepEqual(corePlans(normalized.downloadPlans), [{
    messageId: 'om1',
    fileKey: 'img_x',
    messageType: 'image',
    resourceType: 'image',
    label: 'image',
    suggestedName: 'image-img_x',
  }]);
});

test('normalizeInboundEvent builds post media download plans from media file keys, not cover images', () => {
  const normalized = normalizeInboundEvent({
    message_id: 'om_post_media',
    message_type: 'post',
    content: JSON.stringify({
      content: [[
        { tag: 'media', media_type: 'video', file_key: 'video_file', image_key: 'cover_img' },
        { tag: 'media', media_type: 'file', file_key: 'doc_file', name: 'brief.pdf' },
        { tag: 'media', media_type: 'image', image_key: 'inline_img' },
      ]],
    }),
  });

  assert.deepEqual(corePlans(normalized.downloadPlans), [
    {
      messageId: 'om_post_media',
      fileKey: 'video_file',
      messageType: 'video',
      resourceType: 'file',
      label: 'video',
      suggestedName: 'video-video_file',
    },
    {
      messageId: 'om_post_media',
      fileKey: 'doc_file',
      messageType: 'file',
      resourceType: 'file',
      label: 'file',
      suggestedName: 'brief.pdf',
    },
    {
      messageId: 'om_post_media',
      fileKey: 'inline_img',
      messageType: 'image',
      resourceType: 'image',
      label: 'image',
      suggestedName: 'image-inline_img',
    },
  ]);
});

test('hydrateAttachmentEvent fetches raw body.content when image event omits file key', () => {
  const event = {
    message_id: 'om_img',
    message_type: 'image',
    content: '{}',
  };
  const before = normalizeInboundEvent(event);
  assert.deepEqual(before.downloadPlans, []);

  const hydrated = hydrateAttachmentEvent(event, {
    normalized: before,
    fetchMessage(messageId) {
      assert.equal(messageId, 'om_img');
      return {
        ok: true,
        status: 0,
        signal: null,
        stdout: '{}',
        stderr: '',
        args: [],
        message: {
          message_id: 'om_img',
          msg_type: 'image',
          body: { content: '{"image_key":"img_from_raw"}' },
        },
      };
    },
  });

  assert.equal(hydrated.fetched, true);
  assert.equal(hydrated.normalized.attachmentFetch.status, 'ok');
  assert.deepEqual(corePlans(hydrated.normalized.downloadPlans), [{
    messageId: 'om_img',
    fileKey: 'img_from_raw',
    messageType: 'image',
    resourceType: 'image',
    label: 'image',
    suggestedName: 'image-img_from_raw',
  }]);
});

test('normalizeInboundEvent supports top-level media as video material', () => {
  const normalized = normalizeInboundEvent({
    message_id: 'om_media',
    message_type: 'media',
    content: '{"file_key":"video_file","image_key":"cover"}',
  });

  assert.equal(normalized.messageType, 'media');
  assert.equal(normalized.rawMessageType, 'media');
  assert.equal(normalized.materialKind, 'video');
  assert.equal(normalized.text, '[视频: video_file]');
  assert.deepEqual(corePlans(normalized.downloadPlans), [{
    messageId: 'om_media',
    fileKey: 'video_file',
    messageType: 'video',
    resourceType: 'file',
    label: 'video',
    suggestedName: 'video-video_file',
  }]);
});

test('normalizeInboundEvent supports top-level audio download plans', () => {
  const normalized = normalizeInboundEvent({
    message_id: 'om_audio',
    message_type: 'audio',
    content: '{"file_key":"audio_file","name":"voice.ogg"}',
  });

  assert.equal(normalized.materialKind, 'audio');
  assert.equal(normalized.text, '[语音: audio_file]');
  assert.deepEqual(corePlans(normalized.downloadPlans), [{
    messageId: 'om_audio',
    fileKey: 'audio_file',
    messageType: 'audio',
    resourceType: 'file',
    label: 'audio',
    suggestedName: 'voice.ogg',
  }]);
});

test('normalizeInboundEvent supports sticker image-like download plans', () => {
  const normalized = normalizeInboundEvent({
    message_id: 'om_sticker',
    message_type: 'sticker',
    content: '{"sticker_key":"img_sticker"}',
  });

  assert.equal(normalized.materialKind, 'sticker');
  assert.equal(normalized.text, '[表情: img_sticker]');
  assert.deepEqual(corePlans(normalized.downloadPlans), [{
    messageId: 'om_sticker',
    fileKey: 'img_sticker',
    messageType: 'sticker',
    resourceType: 'image',
    label: 'sticker',
    suggestedName: 'sticker-img_sticker',
  }]);
});

test('normalizeInboundEvent parses interactive business cards with sanitized visible projection', () => {
  const normalized = normalizeInboundEvent({
    message_id: 'om_card',
    chat_id: 'oc1',
    sender_id: 'ou1',
    message_type: 'interactive',
    content: JSON.stringify({
      schema: '2.0',
      version: '1.0',
      header: { title: { tag: 'plain_text', content: '审批提醒' } },
      elements: [
        { tag: 'markdown', content: '请处理 https://user:pass@example.com/path?token=secret#frag' },
        {
          tag: 'div',
          fields: [
            { text: { tag: 'lark_md', content: '**截止时间**\n明天' } },
          ],
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '同意' },
              url: 'https://example.com/approve?ticket=secret',
              value: { callback: 'must-not-leak' },
            },
          ],
        },
      ],
    }),
  });

  assert.equal(normalized.materialKind, 'business_card');
  assert.equal(normalized.supported, true);
  assert.equal(normalized.businessCards[0].status, 'parsed');
  assert.equal(normalized.businessCards[0].title, '审批提醒');
  assert.deepEqual(normalized.businessCards[0].fields[0], {
    label: '截止时间',
    value: '明天',
    path: '$.elements[1].fields[0]',
  });
  assert.equal(normalized.businessCards[0].actions[0].label, '同意');
  assert.match(normalized.businessCards[0].actions[0].sanitizedUrl, /^https:\/\/example\.com\/approve/);
  assert.equal(normalized.businessCards[0].textItems.filter((item) => item.text === '同意').length, 0);
  assert.equal(normalized.businessCards[0].textItems.filter((item) => item.text.includes('截止时间')).length, 1);
  assert.doesNotMatch(JSON.stringify(normalized.businessCards), /token=secret|ticket=secret|must-not-leak|user:pass/);
  assert.match(normalized.promptText, /审批提醒/);
  assert.match(normalized.promptText, /https:\/\/example\.com\/approve \[query removed\]/);
  assert.doesNotMatch(normalized.promptText, /token=secret|ticket=secret|must-not-leak|user:pass/);
  assert.match(normalized.text, /^\[business_card\] cards=1 status=parsed/);
});

test('normalizeInboundEvent extracts form control labels without copying values', () => {
  const normalized = normalizeInboundEvent({
    message_id: 'om_form_card',
    message_type: 'interactive',
    content: JSON.stringify({
      elements: [
        {
          tag: 'input',
          label: { tag: 'plain_text', content: '客户名称' },
          placeholder: { tag: 'plain_text', content: '请输入客户名称' },
          value: 'hidden-customer-value',
        },
        {
          tag: 'select_static',
          label: { tag: 'plain_text', content: '优先级' },
          initial_value: 'p0-secret',
        },
      ],
    }),
  });

  assert.deepEqual(
    normalized.businessCards[0].textItems
      .filter((item) => item.role === 'field_label')
      .map((item) => item.text),
    ['客户名称', '优先级'],
  );
  assert.deepEqual(normalized.businessCards[0].entities, []);
  assert.doesNotMatch(JSON.stringify(normalized.businessCards), /hidden-customer-value|p0-secret/);
});

test('normalizeInboundEvent treats malformed interactive cards as parse_failed without throwing', () => {
  const normalized = normalizeInboundEvent({
    message_id: 'om_bad_card',
    message_type: 'interactive',
    content: '{"header":',
  });

  assert.equal(normalized.businessCards[0].status, 'parse_failed');
  assert.deepEqual(normalized.businessCards[0].parseErrors, ['invalid_json']);
  assert.match(normalized.promptText, /格式无法解析/);
});

test('normalizeInboundEvent extracts share cards, location, and non-instruction system summaries', () => {
  const user = normalizeInboundEvent({
    message_id: 'om_user',
    message_type: 'share_user',
    content: '{"open_id":"ou_1","name":"Alice"}',
  });
  const chat = normalizeInboundEvent({
    message_id: 'om_chat',
    message_type: 'share_chat',
    content: '{"chat_id":"oc_1","chat_name":"项目群"}',
  });
  const location = normalizeInboundEvent({
    message_id: 'om_location',
    message_type: 'location',
    content: '{"name":"办公室","address":"北京","latitude":39.9,"longitude":116.4}',
  });
  const system = normalizeInboundEvent({
    message_id: 'om_system',
    message_type: 'system',
    content: '{"type":"member_join","text":"Alice joined"}',
  });

  assert.deepEqual(user.businessCards[0].entities[0], { type: 'user', id: 'ou_1', idType: 'open_id', name: 'Alice' });
  assert.deepEqual(chat.businessCards[0].entities[0], { type: 'chat', id: 'oc_1', idType: 'chat_id', name: '项目群' });
  assert.equal(location.businessCards[0].geo.latitude, 39.9);
  assert.equal(location.businessCards[0].geo.longitude, 116.4);
  assert.match(location.logPreview, /hasGeo=true/);
  assert.doesNotMatch(location.logPreview, /39\.9|116\.4|北京|办公室/);
  assert.equal(system.businessCards[0].system.type, 'member_join');
  assert.equal(system.deliverToCodex, false);
});

test('normalizeInboundEvent preserves unknown message types as business-card placeholders', () => {
  const normalized = normalizeInboundEvent({
    message_id: 'om_future',
    message_type: 'approval_card',
    content: '{"secret":"not parsed"}',
  });

  assert.equal(normalized.materialKind, 'business_card');
  assert.equal(normalized.supported, false);
  assert.equal(normalized.businessCards[0].cardKind, 'unknown');
  assert.equal(normalized.businessCards[0].status, 'unsupported');
  assert.deepEqual(normalized.unsupportedReasons, ['unsupported business-card message_type: approval_card']);
  assert.match(normalized.promptText, /暂不支持深度解析/);
});

test('normalizeInboundEvent includes merge-forward business cards with child metadata', () => {
  const normalized = normalizeInboundEvent({
    message_id: 'om_parent',
    message_type: 'merge_forward',
    items: [
      { message_id: 'om_parent', msg_type: 'merge_forward', body: { content: '{}' } },
      {
        message_id: 'om_card_child',
        upper_message_id: 'om_parent',
        sender: { sender_id: { open_id: 'ou_a' }, name: 'Alice' },
        msg_type: 'interactive',
        body: { content: JSON.stringify({ header: { title: { content: '子卡片' } } }) },
      },
    ],
  });

  assert.equal(normalized.businessCards.length, 1);
  assert.equal(normalized.businessCards[0].origin, 'merge_forward');
  assert.equal(normalized.businessCards[0].childIndex, 0);
  assert.equal(normalized.businessCards[0].messageId, 'om_card_child');
  assert.equal(normalized.businessCards[0].senderLabel, 'Alice');
  assert.match(normalized.promptText, /子卡片/);
  assert.match(normalized.logPreview, /\[merge_forward\].*businessCards=1/);
});

test('normalizeInboundEvent parses merge_forward children and creates audio download plans', () => {
  const normalized = normalizeInboundEvent({
    message_id: 'om_parent',
    chat_id: 'oc1',
    sender_id: 'ou_sender',
    message_type: 'merge_forward',
    items: [
      { message_id: 'om_parent', msg_type: 'merge_forward', body: { content: '{}' } },
      {
        message_id: 'om_child_1',
        upper_message_id: 'om_parent',
        sender: { sender_id: { open_id: 'ou_a' } },
        msg_type: 'text',
        body: { content: '{"text":"hi"}' },
      },
      {
        message_id: 'om_child_2',
        upper_message_id: 'om_parent',
        sender: { sender_type: 'bot' },
        msg_type: 'audio',
        body: { content: '{"file_key":"file_audio"}' },
      },
    ],
  });

  assert.match(normalized.text, /ou_a: hi/);
  assert.match(normalized.text, /\(bot\): \[语音: file_audio\]/);
  assert.deepEqual(corePlans(normalized.downloadPlans), [{
    messageId: 'om_child_2',
    fileKey: 'file_audio',
    messageType: 'audio',
    resourceType: 'file',
    label: 'audio',
    suggestedName: 'audio-file_audio',
  }]);
  assert.equal(normalized.downloadPlans[0].origin, 'merge_forward');
  assert.equal(normalized.downloadPlans[0].transcriptionEligible, true);
  assert.equal(normalized.downloadPlans[0].resourceMessageId, 'om_parent');
  assert.equal(normalized.mergeForward.status, 'parsed');
});

test('merge_forward without children exposes lark-cli fetch integration point', () => {
  const normalized = normalizeInboundEvent({ message_id: 'om_mf', message_type: 'merge_forward' });
  assert.equal(normalized.mergeForward.status, 'needs_fetch');
  assert.deepEqual(normalized.mergeForward.fetchArgs, buildMergeForwardGetArgs('om_mf'));
  assert.deepEqual(normalized.mergeForward.mgetDiagnosticArgs, buildMergeForwardFetchArgs('om_mf'));
});

test('buildMergeForwardGetArgs fetches merge_forward children through raw message get API', () => {
  assert.deepEqual(
    buildMergeForwardGetArgs('om_mf', { as: 'bot', profile: 'sales-bot' }),
    ['--profile', 'sales-bot', 'api', 'GET', '/open-apis/im/v1/messages/om_mf', '--as', 'bot'],
  );
});

test('fetchMessageWithLarkCli parses raw message get body.content output', () => {
  const calls = [];
  const optsSeen = [];
  const result = fetchMessageWithLarkCli('om_file', {
    as: 'bot',
    profile: 'sales-bot',
    timeoutMs: 1234,
    spawnSync(command, args, options) {
      calls.push({ command, args });
      optsSeen.push(options);
      return {
        status: 0,
        signal: null,
        stdout: JSON.stringify({
          code: 0,
          data: {
            items: [{
              message_id: 'om_file',
              msg_type: 'file',
              body: { content: '{"file_key":"file_from_raw","name":"raw.pdf"}' },
            }],
          },
        }),
        stderr: '',
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.message.body.content, '{"file_key":"file_from_raw","name":"raw.pdf"}');
  assert.equal(calls[0].command, 'lark-cli');
  assert.equal(optsSeen[0].timeout, 1234);
  assert.deepEqual(calls[0].args, buildMessageGetArgs('om_file', { as: 'bot', profile: 'sales-bot' }));
});

test('fetchMessageWithLarkCli treats nonzero API code as failure', () => {
  const result = fetchMessageWithLarkCli('om_file', {
    spawnSync() {
      return {
        status: 0,
        signal: null,
        stdout: JSON.stringify({ code: 99991672, msg: 'permission denied', data: {} }),
        stderr: '',
      };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.message, null);
  assert.match(result.failureSummary, /permission denied|99991672/);
});

test('hydrateMergeForwardEvent fetches and parses merge_forward children', () => {
  const hydrated = hydrateMergeForwardEvent(
    { message_id: 'om_parent', message_type: 'merge_forward', chat_id: 'oc1', sender_id: 'ou_sender' },
    {
      fetchMergeForwardItems() {
        return {
          ok: true,
          status: 0,
          signal: null,
          stdout: '{}',
          stderr: '',
          args: [],
          items: [
            { message_id: 'om_parent', msg_type: 'merge_forward', body: { content: '{}' } },
            {
              message_id: 'om_child_1',
              upper_message_id: 'om_parent',
              sender: { sender_id: { open_id: 'ou_a' }, name: 'Leaf' },
              msg_type: 'text',
              body: { content: '{"text":"hi"}' },
            },
            {
              message_id: 'om_child_2',
              upper_message_id: 'om_parent',
              sender: { sender_id: { open_id: 'ou_b' }, name: 'Eli' },
              msg_type: 'file',
              body: { content: '{"file_key":"file_1","name":"spec.pdf"}' },
            },
          ],
        };
      },
    },
  );

  assert.equal(hydrated.fetched, true);
  assert.equal(hydrated.normalized.mergeForward.status, 'parsed');
  assert.equal(hydrated.normalized.mergeForward.childCount, 2);
  assert.match(hydrated.normalized.text, /Leaf: hi/);
  assert.match(hydrated.normalized.text, /Eli: \[文件: file_1\]/);
  assert.deepEqual(corePlans(hydrated.normalized.downloadPlans), [{
    messageId: 'om_child_2',
    fileKey: 'file_1',
    messageType: 'file',
    resourceType: 'file',
    label: 'file',
    suggestedName: 'spec.pdf',
  }]);
});

test('hydrateMergeForwardEvent resolves sender names when fetched items only include open_id', () => {
  const seen = [];
  const hydrated = hydrateMergeForwardEvent(
    { message_id: 'om_parent', message_type: 'merge_forward' },
    {
      fetchMergeForwardItems() {
        return {
          ok: true,
          status: 0,
          signal: null,
          stdout: '{}',
          stderr: '',
          args: [],
          items: [
            { message_id: 'om_parent', msg_type: 'merge_forward', body: { content: '{}' } },
            {
              message_id: 'om_child_1',
              upper_message_id: 'om_parent',
              sender: { sender_id: { open_id: 'ou_leaf' } },
              msg_type: 'text',
              body: { content: '{"text":"hi"}' },
            },
          ],
        };
      },
      resolveUserName(openId) {
        seen.push(openId);
        return openId === 'ou_leaf' ? 'Leaf' : null;
      },
    },
  );

  assert.deepEqual(seen, ['ou_leaf']);
  assert.match(hydrated.normalized.text, /Leaf: hi/);
});

test('fetchMergeForwardItemsWithLarkCli parses raw API data.items output', () => {
  const calls = [];
  const result = fetchMergeForwardItemsWithLarkCli('om_parent', {
    as: 'bot',
    profile: 'sales-bot',
    spawnSync(command, args) {
      calls.push({ command, args });
      return {
        status: 0,
        signal: null,
        stdout: JSON.stringify({
          code: 0,
          data: {
            items: [
              { message_id: 'om_parent', msg_type: 'merge_forward' },
              { message_id: 'om_child', upper_message_id: 'om_parent', msg_type: 'text', body: { content: '{"text":"ok"}' } },
            ],
          },
        }),
        stderr: '',
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.items.length, 2);
  assert.equal(calls[0].command, 'lark-cli');
  assert.deepEqual(calls[0].args, [
    '--profile',
    'sales-bot',
    'api',
    'GET',
    '/open-apis/im/v1/messages/om_parent',
    '--as',
    'bot',
  ]);
});

test('hydrateMergeForwardEvent reports actionable fetch failures', () => {
  const hydrated = hydrateMergeForwardEvent(
    { message_id: 'om_parent', message_type: 'merge_forward' },
    {
      fetchMergeForwardItems() {
        return {
          ok: false,
          status: 1,
          signal: null,
          stdout: '',
          stderr: 'permission denied: missing im:message.group_msg',
          args: [],
          items: [],
        };
      },
    },
  );

  assert.equal(hydrated.normalized.mergeForward.status, 'fetch_failed');
  assert.match(hydrated.normalized.text, /无法获取子消息内容/);
  assert.match(hydrated.normalized.text, /im:message\.group_msg/);
  assert.match(hydrated.normalized.unsupportedReasons.at(-1), /permission denied/);
});

test('hydrateMergeForwardEvent failure text does not expose raw stdout message content', () => {
  const hydrated = hydrateMergeForwardEvent(
    { message_id: 'om_parent', message_type: 'merge_forward' },
    {
      fetchMergeForwardItems() {
        return {
          ok: false,
          status: 0,
          signal: null,
          stdout: JSON.stringify({ data: { items: [{ body: { content: '{"text":"secret transcript"}' } }] } }),
          stderr: '',
          args: [],
          items: [],
        };
      },
    },
  );

  assert.match(hydrated.normalized.text, /无法获取子消息内容/);
  assert.doesNotMatch(hydrated.normalized.text, /secret transcript/);
});

test('buildLarkCliResourceDownloadArgs includes file-key without exposing secrets', () => {
  assert.deepEqual(
    buildLarkCliResourceDownloadArgs(
      { messageId: 'om1', fileKey: 'img1', resourceType: 'image' },
      { as: 'bot', output: 'image-img1' },
    ),
    ['im', '+messages-resources-download', '--as', 'bot', '--message-id', 'om1', '--file-key', 'img1', '--type', 'image', '--output', 'image-img1'],
  );
});

test('buildLarkCliResourceDownloadArgs uses resourceMessageId for merge-forward child resources', () => {
  assert.deepEqual(
    buildLarkCliResourceDownloadArgs(
      { messageId: 'om_child', resourceMessageId: 'om_parent', fileKey: 'file1', resourceType: 'file' },
      { as: 'bot' },
    ),
    ['im', '+messages-resources-download', '--as', 'bot', '--message-id', 'om_parent', '--file-key', 'file1', '--type', 'file'],
  );
});

test('buildLarkCliResourceDownloadArgs can pin a lark profile', () => {
  assert.deepEqual(
    buildLarkCliResourceDownloadArgs(
      { messageId: 'om1', fileKey: 'img1', resourceType: 'image' },
      { as: 'bot', profile: 'sales-bot' },
    ),
    ['--profile', 'sales-bot', 'im', '+messages-resources-download', '--as', 'bot', '--message-id', 'om1', '--file-key', 'img1', '--type', 'image'],
  );
});

test('createInboxEntryLike writes normalized materials and manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-ingest-'));
  const calls = [];
  const entry = createInboxEntryLike(
    {
      message_id: 'om_file',
      chat_id: 'oc1',
      sender_id: 'ou1',
      message_type: 'file',
      content: '<file key="file_v3_0011s_abc" name="测试账号(1).rtf"/>',
    },
    {
      inboxRoot: root,
      now: new Date('2026-05-20T00:00:00Z'),
      download: true,
      spawnSync(command, args) {
        calls.push({ command, args });
        return { status: 0, signal: null, stdout: '{"ok":true}', stderr: '' };
      },
    },
  );

  assert.equal(entry.manifest.messageId, 'om_file');
  assert.equal(entry.manifest.downloadPlans[0].fileKey, 'file_v3_0011s_abc');
  assert.equal(entry.manifest.downloadPlans[0].suggestedName, '测试账号(1).rtf');
  assert.equal(entry.manifest.downloads.length, 1);
  assert.equal(calls[0].command, 'lark-cli');
  assert.deepEqual(calls[0].args, [
    'im',
    '+messages-resources-download',
    '--as',
    'bot',
    '--message-id',
    'om_file',
    '--file-key',
    'file_v3_0011s_abc',
    '--type',
    'file',
    '--output',
    '测试账号_1_.rtf',
  ]);
  assert.ok(fs.existsSync(path.join(entry.dir, 'content.md')));
  assert.ok(fs.existsSync(path.join(entry.dir, 'manifest.json')));
  assert.equal(modeOf(root), 0o700);
  assert.equal(modeOf(path.dirname(entry.dir)), 0o700);
  assert.equal(modeOf(entry.dir), 0o700);
  assert.equal(modeOf(entry.attachmentsDir), 0o700);
  assert.equal(modeOf(path.join(entry.dir, 'message.json')), 0o600);
  assert.equal(modeOf(path.join(entry.dir, 'content.md')), 0o600);
  assert.equal(modeOf(path.join(entry.dir, 'manifest.json')), 0o600);
});

test('createInboxEntryLike writes business-card content and manifest with sanitized URLs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-ingest-'));
  const event = {
    message_id: 'om_card',
    message_type: 'interactive',
    content: JSON.stringify({
      header: { title: { content: '链接卡片' } },
      elements: [
        { tag: 'markdown', content: '查看 https://example.com/path?token=secret#frag' },
      ],
    }),
  };

  const entry = createInboxEntryLike(event, {
    inboxRoot: root,
    now: new Date('2026-05-20T00:00:00Z'),
  });
  const contentMd = fs.readFileSync(path.join(entry.dir, 'content.md'), 'utf8');
  const manifestText = fs.readFileSync(path.join(entry.dir, 'manifest.json'), 'utf8');
  const messageJson = fs.readFileSync(path.join(entry.dir, 'message.json'), 'utf8');

  assert.equal(entry.manifest.businessCards[0].cardKind, 'interactive');
  assert.match(contentMd, /https:\/\/example\.com\/path \[query removed, fragment removed\]/);
  assert.doesNotMatch(contentMd, /token=secret|#frag/);
  assert.doesNotMatch(manifestText, /token=secret|#frag/);
  assert.match(messageJson, /token=secret/);
});

test('createInboxEntryLike can persist pre-hydrated merge_forward content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-ingest-'));
  const hydrated = hydrateMergeForwardEvent(
    { message_id: 'om_parent', message_type: 'merge_forward' },
    {
      fetchMergeForwardItems() {
        return {
          ok: true,
          status: 0,
          signal: null,
          stdout: '{}',
          stderr: '',
          args: [],
          items: [
            { message_id: 'om_parent', msg_type: 'merge_forward', body: { content: '{}' } },
            {
              message_id: 'om_child_1',
              upper_message_id: 'om_parent',
              sender: { sender_id: { open_id: 'ou_a' }, name: 'Leaf' },
              msg_type: 'text',
              body: { content: '{"text":"ship it"}' },
            },
          ],
        };
      },
    },
  );

  const entry = createInboxEntryLike(
    { message_id: 'om_parent', message_type: 'merge_forward' },
    {
      inboxRoot: root,
      now: new Date('2026-05-20T00:00:00Z'),
      normalized: hydrated.normalized,
    },
  );

  assert.equal(entry.manifest.mergeForward.status, 'parsed');
  assert.match(fs.readFileSync(path.join(entry.dir, 'content.md'), 'utf8'), /Leaf: ship it/);
});

test('createInboxEntryLike transcribes downloaded audio with a local fake engine', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-ingest-'));
  const fakeEngine = path.join(root, 'fake-asr');
  fs.writeFileSync(fakeEngine, '#!/bin/sh\nprintf \'{"text":"语音内容"}\\n\'\n', { mode: 0o700 });

  const entry = createInboxEntryLike(
    {
      message_id: 'om_audio',
      message_type: 'audio',
      content: '{"file_key":"file_audio","name":"voice.ogg"}',
    },
    {
      inboxRoot: root,
      now: new Date('2026-05-20T00:00:00Z'),
      download: true,
      transcribeAudio: true,
      audioTranscribeConfig: {
        audioTranscribe: 'local',
        audioTranscribeEngine: 'fake',
        fakeAudioTranscribePath: fakeEngine,
      },
      transcribeSpawnSync(command, args) {
        assert.equal(command, fakeEngine);
        return { status: 0, signal: null, stdout: JSON.stringify({ text: '语音内容' }), stderr: '' };
      },
      spawnSync(command, args, options) {
        const output = args.at(-1);
        const savedPath = path.join(options.cwd, output);
        fs.writeFileSync(savedPath, 'fake audio', { mode: 0o600 });
        return { status: 0, signal: null, stdout: JSON.stringify({ data: { saved_path: savedPath } }), stderr: '' };
      },
    },
  );

  assert.equal(entry.manifest.transcriptions[0].status, 'ok');
  assert.equal(entry.manifest.transcriptions[0].textLength, 4);
  assert.equal(entry.manifest.transcriptions[0].text, undefined);
  assert.match(fs.readFileSync(path.join(entry.dir, 'content.md'), 'utf8'), /语音内容/);
  assert.ok(fs.existsSync(path.join(entry.dir, entry.manifest.transcriptions[0].transcriptPath)));
});

test('createInboxEntryLike can keep audio transcript out of content sent to Codex', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-ingest-'));
  const fakeEngine = path.join(root, 'fake-asr');
  fs.writeFileSync(fakeEngine, '#!/bin/sh\nprintf \'{"text":"SECRET_TRANSCRIPT"}\\n\'\n', { mode: 0o700 });

  const entry = createInboxEntryLike(
    {
      message_id: 'om_audio_private',
      message_type: 'audio',
      content: '{"file_key":"file_audio","name":"voice.ogg"}',
    },
    {
      inboxRoot: root,
      now: new Date('2026-05-20T00:00:00Z'),
      download: true,
      transcribeAudio: true,
      audioTranscribeSendToCodex: false,
      audioTranscribeConfig: {
        audioTranscribe: 'local',
        audioTranscribeEngine: 'fake',
        fakeAudioTranscribePath: fakeEngine,
      },
      transcribeSpawnSync() {
        return { status: 0, signal: null, stdout: JSON.stringify({ text: 'SECRET_TRANSCRIPT' }), stderr: '' };
      },
      spawnSync(command, args, options) {
        const output = args.at(-1);
        const savedPath = path.join(options.cwd, output);
        fs.writeFileSync(savedPath, 'fake audio', { mode: 0o600 });
        return { status: 0, signal: null, stdout: JSON.stringify({ data: { saved_path: savedPath } }), stderr: '' };
      },
    },
  );

  assert.equal(entry.manifest.transcriptions[0].text, undefined);
  assert.doesNotMatch(fs.readFileSync(path.join(entry.dir, 'content.md'), 'utf8'), /SECRET_TRANSCRIPT/);
  assert.match(fs.readFileSync(path.join(entry.dir, entry.manifest.transcriptions[0].transcriptPath), 'utf8'), /SECRET_TRANSCRIPT/);
});

test('createInboxEntryLike records skipped downloads when download is disabled', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-ingest-'));
  const entry = createInboxEntryLike(
    {
      message_id: 'om_audio_no_download',
      message_type: 'audio',
      content: '{"file_key":"file_audio","name":"voice.ogg"}',
    },
    {
      inboxRoot: root,
      now: new Date('2026-05-20T00:00:00Z'),
      download: false,
      spawnSync() {
        throw new Error('download should not run');
      },
    },
  );

  assert.equal(entry.manifest.downloads.length, 0);
  assert.equal(entry.manifest.downloadSkipped[0].reason, 'download_disabled');
  assert.match(fs.readFileSync(path.join(entry.dir, 'content.md'), 'utf8'), /Download Skipped/);
});

test('createInboxEntryLike renders sanitized download failure diagnostics', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-ingest-'));
  const entry = createInboxEntryLike(
    {
      message_id: 'om_audio_download_failed',
      message_type: 'audio',
      content: '{"file_key":"file_audio","name":"voice.ogg"}',
    },
    {
      inboxRoot: root,
      now: new Date('2026-05-20T00:00:00Z'),
      download: true,
      spawnSync() {
        return { status: 1, signal: null, stdout: '', stderr: 'permission denied token=secret' };
      },
    },
  );

  assert.equal(entry.manifest.downloadErrors[0].status, 1);
  assert.doesNotMatch(entry.manifest.downloadErrors[0].stderr, /token=secret/);
  const contentMd = fs.readFileSync(path.join(entry.dir, 'content.md'), 'utf8');
  assert.match(contentMd, /Download Errors/);
  assert.doesNotMatch(contentMd, /token=secret/);
});

function modeOf(file) {
  return fs.statSync(file).mode & 0o777;
}

function corePlans(plans) {
  return plans.map((plan) => ({
    messageId: plan.messageId,
    fileKey: plan.fileKey,
    messageType: plan.messageType,
    resourceType: plan.resourceType,
    label: plan.label,
    suggestedName: plan.suggestedName,
  }));
}
