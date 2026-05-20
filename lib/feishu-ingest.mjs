import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SUPPORTED_MESSAGE_TYPES = new Set(['text', 'post', 'image', 'file', 'video', 'merge_forward']);

const DEFAULT_MAX_STDIO = 16 * 1024 * 1024;

const DOWNLOAD_RESOURCE_TYPE_BY_MESSAGE_TYPE = {
  image: 'image',
  file: 'file',
  video: 'file',
};

const DOWNLOAD_LABEL_BY_MESSAGE_TYPE = {
  image: 'image',
  file: 'file',
  video: 'video',
};

export function parseTextContent(content) {
  const parsed = parseMaybeJson(content);
  if (isPlainObject(parsed)) {
    if (typeof parsed.text === 'string') return parsed.text;
    if (typeof parsed.content === 'string') return parsed.content;
    return '';
  }
  return typeof parsed === 'string' ? parsed : String(content ?? '');
}

export function parsePostContent(content) {
  const imageKeys = [];
  const textParts = [];
  const parsed = normalizePostEnvelope(parseMaybeJson(content));

  if (!isPlainObject(parsed)) {
    return { extractedText: '', imageKeys };
  }

  if (typeof parsed.title === 'string' && parsed.title.trim()) {
    textParts.push(parsed.title.trim());
  }

  const paragraphs = Array.isArray(parsed.content) ? parsed.content : [];
  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) continue;
    const lineParts = [];
    for (const element of paragraph) {
      if (!isPlainObject(element)) continue;
      const { text, imageKey } = parsePostElement(element);
      if (text) lineParts.push(text);
      if (imageKey) imageKeys.push(imageKey);
    }
    if (lineParts.length > 0) textParts.push(lineParts.join(''));
  }

  return {
    extractedText: compactLines(textParts.join('\n')),
    imageKeys: unique(imageKeys),
  };
}

export function extractFileKey(content) {
  const parsed = parseMaybeJson(content);
  if (!isPlainObject(parsed)) return null;
  return firstString(
    parsed.image_key,
    parsed.file_key,
    parsed.video_key,
    parsed.media_key,
    parsed.imageKey,
    parsed.fileKey,
    parsed.videoKey,
    parsed.mediaKey,
  );
}

export function stripMentionMarkers(text) {
  return String(text ?? '')
    .replace(/@_user_\d+/g, '')
    .replace(/<at\b[^>]*>.*?<\/at>/gis, '')
    .replace(/\u200b/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeInboundEvent(event) {
  const raw = event ?? {};
  const message = getMessageNode(raw);
  const senderNode = raw.sender ?? raw.event?.sender ?? message.sender ?? {};
  const senderIdNode = senderNode.sender_id ?? message.sender?.sender_id ?? {};
  const messageId = firstString(raw.message_id, raw.id, message.message_id, message.id);
  const chatId = firstString(raw.chat_id, message.chat_id);
  const senderId = firstString(raw.sender_id, senderIdNode.open_id, senderIdNode.user_id, senderIdNode.union_id, senderNode.id);
  const messageType = firstString(raw.message_type, raw.msg_type, message.message_type, message.msg_type, message.type) || 'unknown';
  const content = firstString(raw.content, message.content, message.body?.content) ?? '';
  const timestamp = normalizeTimestamp(firstString(raw.create_time, raw.timestamp, message.create_time, message.timestamp));

  const downloadPlans = [];
  const unsupportedReasons = [];
  let text = '';
  let mergeForward = null;

  if (messageType === 'text') {
    text = parseTextContent(content);
  } else if (messageType === 'post') {
    const post = parsePostContent(content);
    text = post.extractedText;
    for (const imageKey of post.imageKeys) {
      downloadPlans.push(makeDownloadPlan({ messageId, fileKey: imageKey, messageType: 'image' }));
    }
  } else if (messageType === 'image' || messageType === 'file' || messageType === 'video') {
    const fileKey = extractFileKey(content);
    text = buildAttachmentPlaceholder(messageType, fileKey);
    if (fileKey) {
      downloadPlans.push(makeDownloadPlan({ messageId, fileKey, messageType }));
    } else {
      unsupportedReasons.push(`${messageType} message does not include a downloadable file key`);
    }
  } else if (messageType === 'merge_forward') {
    const items = getMergeForwardItems(raw);
    if (items.length > 0) {
      const parsed = parseMergeForwardItems(items, { parentMessageId: messageId });
      text = parsed.text;
      downloadPlans.push(...parsed.downloadPlans);
      mergeForward = { status: 'parsed', childCount: parsed.childCount };
    } else {
      text = '[合并转发消息：需要通过 Feishu message get/mget 接口拉取子消息]';
      mergeForward = {
        status: 'needs_fetch',
        fetchArgs: messageId ? buildMergeForwardFetchArgs(messageId) : null,
        integrationNote: 'lark-cli +messages-mget is the current integration point; confirm its output includes merge_forward child items before wiring bridge.mjs.',
      };
    }
  } else if (messageType === 'audio') {
    text = '[语音消息：已明确排除语音转写，未做语音内容解析]';
    unsupportedReasons.push('audio transcription is intentionally excluded');
  } else {
    text = `[不支持的飞书消息类型：${messageType}]`;
    unsupportedReasons.push(`unsupported message_type: ${messageType}`);
  }

  const cleanText = stripMentionMarkers(text);

  return {
    eventId: firstString(raw.event_id, raw.header?.event_id),
    messageId,
    chatId,
    chatType: firstString(raw.chat_type, message.chat_type),
    threadId: firstString(raw.thread_id, message.thread_id),
    senderId,
    senderType: firstString(raw.sender_type, senderNode.sender_type),
    messageType,
    supported: SUPPORTED_MESSAGE_TYPES.has(messageType),
    content,
    text: cleanText,
    timestamp,
    mentions: Array.isArray(message.mentions) ? message.mentions : [],
    downloadPlans: downloadPlans.filter((plan) => plan.messageId && plan.fileKey),
    mergeForward,
    unsupportedReasons,
    rawEvent: raw,
  };
}

export function buildResourceDownloadPlans(input) {
  const normalized = input?.downloadPlans ? input : normalizeInboundEvent(input);
  return normalized.downloadPlans.map((plan) => ({ ...plan }));
}

export function buildLarkCliResourceDownloadArgs(plan, options = {}) {
  if (!plan?.messageId) throw new Error('messageId is required for Feishu resource download');
  if (!plan?.fileKey) throw new Error('fileKey is required for Feishu resource download');
  const args = [
    'im',
    '+messages-resources-download',
    '--as',
    options.as || 'bot',
    '--message-id',
    plan.messageId,
    '--file-key',
    plan.fileKey,
    '--type',
    plan.resourceType || 'file',
  ];
  if (options.output) {
    args.push('--output', options.output);
  }
  return args;
}

export function buildMergeForwardFetchArgs(messageId, options = {}) {
  if (!messageId) throw new Error('messageId is required for merge_forward fetch');
  // Integration point: lark-cli currently exposes +messages-mget. If its JSON
  // shape does not include merge_forward children, replace this builder with the
  // raw Feishu GET /im/v1/messages/{message_id} command/API wrapper.
  return [
    'im',
    '+messages-mget',
    '--as',
    options.as || 'bot',
    '--message-ids',
    messageId,
    '--format',
    options.format || 'json',
  ];
}

export function parseMergeForwardItems(items, options = {}) {
  const parentMessageId = options.parentMessageId || '';
  const children = normalizeMergeForwardChildren(items, parentMessageId);
  const lines = [];
  const downloadPlans = [];

  for (const item of children) {
    const child = normalizeMergeForwardChild(item);
    const prefix = child.senderLabel || '(unknown)';
    let contentText = '';

    if (child.messageType === 'text') {
      contentText = parseTextContent(child.content);
    } else if (child.messageType === 'post') {
      const post = parsePostContent(child.content);
      contentText = post.extractedText || '[富文本]';
      for (const imageKey of post.imageKeys) {
        downloadPlans.push(makeDownloadPlan({ messageId: child.messageId, fileKey: imageKey, messageType: 'image' }));
      }
    } else if (child.messageType === 'image' || child.messageType === 'file' || child.messageType === 'video') {
      const fileKey = extractFileKey(child.content);
      contentText = buildAttachmentPlaceholder(child.messageType, fileKey);
      if (fileKey) {
        downloadPlans.push(makeDownloadPlan({ messageId: child.messageId, fileKey, messageType: child.messageType }));
      }
    } else if (child.messageType === 'merge_forward') {
      contentText = '[嵌套合并转发]';
    } else if (child.messageType === 'audio') {
      contentText = '[语音消息：未转写]';
    } else {
      contentText = `[${child.messageType || '未知类型'}]`;
    }

    lines.push(`${prefix}: ${stripMentionMarkers(contentText)}`);
  }

  const text = lines.length > 0
    ? ['--- 以下是一组合并转发的聊天记录 ---', ...lines, '--- 合并转发结束 ---'].join('\n')
    : '[合并转发消息：没有可解析的子消息]';

  return {
    text,
    downloadPlans: downloadPlans.filter((plan) => plan.messageId && plan.fileKey),
    childCount: children.length,
  };
}

export function downloadPlannedResourcesWithLarkCli(plans, options = {}) {
  const cwd = options.cwd || process.cwd();
  const runner = options.spawnSync || spawnSync;
  const results = [];

  fs.mkdirSync(cwd, { recursive: true });

  for (const plan of plans || []) {
    const output = plan.suggestedName ? safeRelativeOutput(plan.suggestedName) : undefined;
    const args = buildLarkCliResourceDownloadArgs(plan, {
      as: options.as || 'bot',
      output,
    });
    const result = runner('lark-cli', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: options.maxBuffer || DEFAULT_MAX_STDIO,
    });
    results.push({
      plan,
      ok: result.status === 0,
      status: result.status,
      signal: result.signal,
      stdout: String(result.stdout || '').trim(),
      stderr: String(result.stderr || '').trim(),
      args,
    });
  }

  return results;
}

export function createInboxEntryLike(event, options = {}) {
  if (!options.inboxRoot) throw new Error('inboxRoot is required');

  const normalized = normalizeInboundEvent(event);
  const messageId = normalized.messageId || `event-${Date.now()}`;
  const createdAt = new Date(options.now || Date.now()).toISOString();
  const dir = path.join(options.inboxRoot, createdAt.slice(0, 10), safePathSegment(messageId));
  const attachmentsDir = path.join(dir, 'attachments');
  fs.mkdirSync(attachmentsDir, { recursive: true });

  fs.writeFileSync(path.join(dir, 'message.json'), `${JSON.stringify(event, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'content.md'), renderContentMarkdown(normalized));

  const manifest = {
    messageId: normalized.messageId,
    chatId: normalized.chatId,
    senderId: normalized.senderId,
    messageType: normalized.messageType,
    createdAt,
    text: normalized.text,
    downloadPlans: normalized.downloadPlans,
    downloads: [],
    downloadErrors: [],
    mergeForward: normalized.mergeForward,
    unsupportedReasons: normalized.unsupportedReasons,
  };

  if (options.download) {
    const downloadResults = downloadPlannedResourcesWithLarkCli(normalized.downloadPlans, {
      cwd: attachmentsDir,
      as: options.larkAs || 'bot',
      spawnSync: options.spawnSync,
      maxBuffer: options.maxBuffer,
    });
    for (const result of downloadResults) {
      const safeResult = {
        plan: result.plan,
        stdout: result.stdout,
        stderr: result.stderr,
        status: result.status,
      };
      if (result.ok) manifest.downloads.push(safeResult);
      else manifest.downloadErrors.push(safeResult);
    }
  }

  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, attachmentsDir, manifest, normalized };
}

function parsePostElement(element) {
  switch (element.tag) {
    case 'text':
      return { text: stringOrEmpty(element.text) };
    case 'a': {
      const label = stringOrEmpty(element.text);
      const href = stringOrEmpty(element.href || element.url);
      return { text: href && href !== label ? `${label} (${href})` : label };
    }
    case 'at':
      return { text: stringOrEmpty(element.user_name || element.name || element.text) };
    case 'img':
      return {
        text: '',
        imageKey: firstString(element.image_key, element.file_key, element.imageKey, element.fileKey),
      };
    case 'media':
      return {
        text: '[视频]',
        imageKey: firstString(element.image_key, element.cover_key),
      };
    default:
      return { text: stringOrEmpty(element.text || element.name) };
  }
}

function normalizePostEnvelope(parsed) {
  if (!isPlainObject(parsed)) return parsed;
  if (Array.isArray(parsed.content)) return parsed;
  for (const value of Object.values(parsed)) {
    if (isPlainObject(value) && Array.isArray(value.content)) return value;
  }
  return parsed;
}

function makeDownloadPlan({ messageId, fileKey, messageType }) {
  const label = DOWNLOAD_LABEL_BY_MESSAGE_TYPE[messageType] || messageType || 'file';
  return {
    messageId,
    fileKey,
    messageType,
    resourceType: DOWNLOAD_RESOURCE_TYPE_BY_MESSAGE_TYPE[messageType] || 'file',
    label,
    suggestedName: `${label}-${safePathSegment(fileKey || 'resource')}`,
  };
}

function buildAttachmentPlaceholder(messageType, fileKey) {
  const labels = {
    image: '图片',
    file: '文件',
    video: '视频',
  };
  const label = labels[messageType] || messageType;
  return fileKey ? `[${label}: ${fileKey}]` : `[${label}]`;
}

function getMessageNode(raw) {
  if (isPlainObject(raw.event?.message)) return raw.event.message;
  if (isPlainObject(raw.message)) return raw.message;
  return raw;
}

function getMergeForwardItems(raw) {
  for (const candidate of [
    raw.mergeForwardItems,
    raw.merge_forward_items,
    raw.children,
    raw.items,
    raw.data?.items,
    raw.event?.message?.items,
    raw.message?.items,
  ]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function normalizeMergeForwardChildren(items, parentMessageId) {
  if (!Array.isArray(items)) return [];
  if (!parentMessageId) return items;
  const children = items.filter((item) => item?.upper_message_id === parentMessageId || item?.parent_message_id === parentMessageId);
  return children.length > 0 ? children : items.filter((item) => item?.message_id !== parentMessageId);
}

function normalizeMergeForwardChild(item) {
  const senderId = firstString(
    item?.sender?.sender_id?.open_id,
    item?.sender?.sender_id?.user_id,
    item?.sender?.id,
    item?.sender_id,
  );
  const senderName = firstString(item?.sender?.name, item?.sender?.sender_name, item?.sender_name, item?.from?.name);
  const senderType = firstString(item?.sender?.sender_type, item?.sender_type);
  const senderLabel = senderType === 'bot' ? '(bot)' : senderName || senderId || '(unknown)';
  return {
    senderLabel,
    messageId: firstString(item?.message_id, item?.id),
    messageType: firstString(item?.msg_type, item?.message_type, item?.type),
    content: firstString(item?.body?.content, item?.content) ?? '',
  };
}

function normalizeTimestamp(value) {
  if (!value) return Date.now();
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }
  return numeric > 10_000_000_000 ? numeric : numeric * 1000;
}

function parseMaybeJson(value) {
  if (isPlainObject(value) || Array.isArray(value)) return value;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function renderContentMarkdown(normalized) {
  const lines = [
    `# Feishu Inbound ${normalized.messageId || ''}`.trim(),
    '',
    `- messageType: ${normalized.messageType}`,
    `- senderId: ${normalized.senderId || ''}`,
    `- chatId: ${normalized.chatId || ''}`,
    normalized.threadId ? `- threadId: ${normalized.threadId}` : '',
    '',
    normalized.text || '',
  ].filter((line) => line !== '');

  if (normalized.downloadPlans.length > 0) {
    lines.push('', '## Download Plans');
    for (const plan of normalized.downloadPlans) {
      lines.push(`- ${plan.messageType}: ${plan.fileKey} (${plan.resourceType})`);
    }
  }

  if (normalized.mergeForward?.status === 'needs_fetch') {
    lines.push('', '## Merge Forward Fetch');
    lines.push(`- ${normalized.mergeForward.fetchArgs?.join(' ') || '(missing message id)'}`);
  }

  return `${lines.join('\n')}\n`;
}

function safeRelativeOutput(value) {
  return safePathSegment(value).replace(/^\.+$/, 'resource');
}

function safePathSegment(value) {
  return String(value || 'unknown')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 160) || 'unknown';
}

function compactLines(value) {
  return String(value || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function unique(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function stringOrEmpty(value) {
  return typeof value === 'string' ? value : '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
