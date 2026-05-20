import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildLarkCliResourceDownloadArgs,
  buildMergeForwardFetchArgs,
  createInboxEntryLike,
  extractFileKey,
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
  assert.equal(extractFileKey('not-json'), null);
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
  assert.deepEqual(normalized.mergeForward.fetchArgs, buildMergeForwardFetchArgs('om_mf'));
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

test('createInboxEntryLike writes normalized materials and manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-ingest-'));
  const entry = createInboxEntryLike(
    {
      message_id: 'om_file',
      chat_id: 'oc1',
      sender_id: 'ou1',
      message_type: 'file',
      content: '{"file_key":"file_123"}',
    },
    { inboxRoot: root, now: new Date('2026-05-20T00:00:00Z') },
  );

  assert.equal(entry.manifest.messageId, 'om_file');
  assert.equal(entry.manifest.downloadPlans[0].fileKey, 'file_123');
  assert.ok(fs.existsSync(path.join(entry.dir, 'content.md')));
  assert.ok(fs.existsSync(path.join(entry.dir, 'manifest.json')));
});
