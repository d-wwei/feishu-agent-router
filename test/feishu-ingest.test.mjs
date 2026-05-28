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
  assert.deepEqual(normalized.downloadPlans, [{
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
  assert.deepEqual(normalized.downloadPlans, [{
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

  assert.deepEqual(normalized.downloadPlans, [
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
  assert.deepEqual(hydrated.normalized.downloadPlans, [{
    messageId: 'om_img',
    fileKey: 'img_from_raw',
    messageType: 'image',
    resourceType: 'image',
    label: 'image',
    suggestedName: 'image-img_from_raw',
  }]);
});

test('normalizeInboundEvent parses merge_forward children and excludes audio transcription', () => {
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
  assert.match(normalized.text, /\(bot\): \[语音消息：未转写\]/);
  assert.equal(normalized.downloadPlans.length, 0);
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
  const result = fetchMessageWithLarkCli('om_file', {
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
  assert.deepEqual(hydrated.normalized.downloadPlans, [{
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

function modeOf(file) {
  return fs.statSync(file).mode & 0o777;
}
