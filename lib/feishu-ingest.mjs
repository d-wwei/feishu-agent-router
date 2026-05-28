import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildLarkCliArgs } from './lark-cli.mjs';

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
  const attachments = [];
  const textParts = [];
  const parsed = normalizePostEnvelope(parseMaybeJson(content));

  if (!isPlainObject(parsed)) {
    return { extractedText: '', imageKeys, attachments };
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
      const { text, imageKey, attachment } = parsePostElement(element);
      if (text) lineParts.push(text);
      if (imageKey) imageKeys.push(imageKey);
      if (attachment) attachments.push(attachment);
    }
    if (lineParts.length > 0) textParts.push(lineParts.join(''));
  }

  return {
    extractedText: compactLines(textParts.join('\n')),
    imageKeys: unique(imageKeys),
    attachments: uniqueAttachments(attachments),
  };
}

export function extractFileKey(content) {
  return extractAttachmentInfo(content).fileKey;
}

export function extractAttachmentInfo(content) {
  const parsed = parseMaybeJson(content);
  if (isPlainObject(parsed)) {
    return {
      fileKey: firstString(
        parsed.image_key,
        parsed.file_key,
        parsed.video_key,
        parsed.media_key,
        parsed.imageKey,
        parsed.fileKey,
        parsed.videoKey,
        parsed.mediaKey,
        parsed.key,
      ),
      fileName: firstString(parsed.name, parsed.file_name, parsed.fileName),
    };
  }

  const attrs = parseTagAttributes(parsed);
  return {
    fileKey: firstString(
      attrs.image_key,
      attrs.file_key,
      attrs.video_key,
      attrs.media_key,
      attrs.imageKey,
      attrs.fileKey,
      attrs.videoKey,
      attrs.mediaKey,
      attrs.key,
    ),
    fileName: firstString(attrs.name, attrs.file_name, attrs.fileName),
  };
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

export function normalizeInboundEvent(event, options = {}) {
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
    const attachments = post.attachments?.length
      ? post.attachments
      : post.imageKeys.map((imageKey) => ({ fileKey: imageKey, messageType: 'image' }));
    for (const attachment of attachments) {
      downloadPlans.push(makeDownloadPlan({
        messageId,
        fileKey: attachment.fileKey,
        messageType: attachment.messageType,
        suggestedName: attachment.fileName,
      }));
    }
  } else if (messageType === 'image' || messageType === 'file' || messageType === 'video') {
    const attachment = extractAttachmentInfo(content);
    const fileKey = attachment.fileKey;
    text = buildAttachmentPlaceholder(messageType, fileKey);
    if (fileKey) {
      downloadPlans.push(makeDownloadPlan({ messageId, fileKey, messageType, suggestedName: attachment.fileName }));
    } else {
      unsupportedReasons.push(`${messageType} message does not include a downloadable file key`);
    }
  } else if (messageType === 'merge_forward') {
    const items = getMergeForwardItems(raw);
    if (items.length > 0) {
      const parsed = parseMergeForwardItems(items, {
        parentMessageId: messageId,
        resolveSenderName: options.resolveSenderName,
      });
      text = parsed.text;
      downloadPlans.push(...parsed.downloadPlans);
      mergeForward = { status: 'parsed', childCount: parsed.childCount };
    } else {
      text = '[合并转发消息：需要通过 Feishu message get/mget 接口拉取子消息]';
      mergeForward = {
        status: 'needs_fetch',
        fetchArgs: messageId ? buildMergeForwardGetArgs(messageId, options) : null,
        mgetDiagnosticArgs: messageId ? buildMergeForwardFetchArgs(messageId, options) : null,
        integrationNote: 'Bridge runtime fetches merge_forward children via raw GET /im/v1/messages/{message_id}; +messages-mget remains a manual diagnostic command.',
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
  const args = buildLarkCliArgs([
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
  ], { profile: options.profile });
  if (options.output) {
    args.push('--output', options.output);
  }
  return args;
}

export function buildMergeForwardFetchArgs(messageId, options = {}) {
  if (!messageId) throw new Error('messageId is required for merge_forward fetch');
  // Manual diagnostic command. Runtime expansion uses buildMergeForwardGetArgs()
  // because Feishu returns merge_forward children from GET /im/v1/messages/{id}.
  return buildLarkCliArgs([
    'im',
    '+messages-mget',
    '--as',
    options.as || 'bot',
    '--message-ids',
    messageId,
    '--format',
    options.format || 'json',
  ], { profile: options.profile });
}

export function buildMergeForwardGetArgs(messageId, options = {}) {
  return buildMessageGetArgs(messageId, options);
}

export function buildMessageGetArgs(messageId, options = {}) {
  if (!messageId) throw new Error('messageId is required for Feishu message get');
  return buildLarkCliArgs([
    'api',
    'GET',
    `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
    '--as',
    options.as || 'bot',
  ], { profile: options.profile });
}

export function fetchMessageWithLarkCli(messageId, options = {}) {
  const args = buildMessageGetArgs(messageId, {
    as: options.as || 'bot',
    profile: options.profile,
  });
  const result = (options.spawnSync || spawnSync)('lark-cli', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer || DEFAULT_MAX_STDIO,
  });
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  const parsed = parseJsonOutput(stdout);
  const apiOk = isSuccessfulLarkApiResult(parsed);
  const message = apiOk ? extractMessageFromFetchResult(parsed, messageId) : null;
  const failureSummary = summarizeFetchFailure({
    status: result.status,
    signal: result.signal,
    error: result.error?.message || null,
    parsed,
    stdout,
    stderr,
  });
  return {
    ok: result.status === 0 && apiOk && isPlainObject(message),
    status: result.status,
    signal: result.signal,
    stdout,
    stderr,
    args,
    message,
    parsed,
    error: result.error?.message || null,
    failureSummary,
  };
}

export function fetchMergeForwardItemsWithLarkCli(messageId, options = {}) {
  const args = buildMergeForwardGetArgs(messageId, {
    as: options.as || 'bot',
    profile: options.profile,
  });
  const result = (options.spawnSync || spawnSync)('lark-cli', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer || DEFAULT_MAX_STDIO,
  });
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  const parsed = parseJsonOutput(stdout);
  const items = extractMergeForwardItemsFromFetchResult(parsed);
  const failureSummary = summarizeFetchFailure({
    status: result.status,
    signal: result.signal,
    error: result.error?.message || null,
    parsed,
    stdout,
    stderr,
  });
  return {
    ok: result.status === 0 && items.length > 0,
    status: result.status,
    signal: result.signal,
    stdout,
    stderr,
    args,
    items,
    parsed,
    error: result.error?.message || null,
    failureSummary,
  };
}

export function resolveUserNameWithLarkCli(openId, options = {}) {
  if (!openId) return null;
  const args = buildLarkCliArgs([
    'api',
    'GET',
    `/open-apis/contact/v3/users/${encodeURIComponent(openId)}`,
    '--as',
    options.as || 'bot',
    '--params',
    JSON.stringify({ user_id_type: 'open_id' }),
  ], { profile: options.profile });
  const result = (options.spawnSync || spawnSync)('lark-cli', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer || DEFAULT_MAX_STDIO,
  });
  if (result.status !== 0) return null;
  const parsed = parseJsonOutput(result.stdout);
  const user = parsed?.data?.user || parsed?.user || parsed?.data;
  return firstString(user?.name, user?.en_name, user?.localized_name, user?.nickname) || null;
}

export function hydrateMergeForwardEvent(event, options = {}) {
  const normalized = options.normalized || normalizeInboundEvent(event);
  if (normalized.mergeForward?.status !== 'needs_fetch') {
    return { event, normalized, fetched: false, fetchResult: null };
  }

  const messageId = normalized.messageId;
  const fetcher = options.fetchMergeForwardItems || fetchMergeForwardItemsWithLarkCli;
  let fetchResult;
  try {
    fetchResult = fetcher(messageId, {
      as: options.as || 'bot',
      profile: options.profile,
      cwd: options.cwd,
      maxBuffer: options.maxBuffer,
      spawnSync: options.spawnSync,
    });
  } catch (error) {
    fetchResult = {
      ok: false,
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      args: messageId ? buildMergeForwardGetArgs(messageId, { as: options.as || 'bot', profile: options.profile }) : [],
      items: [],
      error: error?.message || String(error),
      failureSummary: error?.message || String(error),
    };
  }

  if (fetchResult?.items?.length) {
    const enrichedEvent = {
      ...event,
      mergeForwardItems: fetchResult.items,
    };
    const senderNameCache = new Map();
    const hydrated = normalizeInboundEvent(enrichedEvent, {
      resolveSenderName: options.resolveSenderName || ((openId) => {
        if (!openId) return null;
        if (senderNameCache.has(openId)) return senderNameCache.get(openId);
        const name = options.resolveUserName
          ? options.resolveUserName(openId)
          : resolveUserNameWithLarkCli(openId, {
            as: options.as || 'bot',
            profile: options.profile,
            cwd: options.cwd,
            maxBuffer: options.maxBuffer,
            spawnSync: options.spawnSync,
          });
        senderNameCache.set(openId, name || null);
        return name || null;
      }),
    });
    return {
      event: enrichedEvent,
      normalized: {
        ...hydrated,
        mergeForward: {
          ...hydrated.mergeForward,
          fetchStatus: fetchResult.ok ? 'ok' : 'partial',
        },
      },
      fetched: true,
      fetchResult,
    };
  }

  return {
    event,
    normalized: {
      ...normalized,
      text: mergeForwardFetchFailureText(fetchResult),
      mergeForward: {
        ...normalized.mergeForward,
        status: 'fetch_failed',
        fetchError: summarizeFetchFailure(fetchResult),
      },
      unsupportedReasons: [
        ...normalized.unsupportedReasons,
        `merge_forward fetch failed: ${summarizeFetchFailure(fetchResult)}`,
      ],
    },
    fetched: false,
    fetchResult,
  };
}

export function hydrateAttachmentEvent(event, options = {}) {
  const normalized = options.normalized || normalizeInboundEvent(event);
  if (!needsAttachmentContentFetch(normalized)) {
    return { event, normalized, fetched: false, fetchResult: null };
  }

  const messageId = normalized.messageId;
  const fetcher = options.fetchMessage || fetchMessageWithLarkCli;
  let fetchResult;
  try {
    fetchResult = fetcher(messageId, {
      as: options.as || 'bot',
      profile: options.profile,
      cwd: options.cwd,
      maxBuffer: options.maxBuffer,
      spawnSync: options.spawnSync,
    });
  } catch (error) {
    fetchResult = {
      ok: false,
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      args: messageId ? buildMessageGetArgs(messageId, { as: options.as || 'bot', profile: options.profile }) : [],
      message: null,
      error: error?.message || String(error),
      failureSummary: error?.message || String(error),
    };
  }

  if (fetchResult?.message) {
    const enrichedEvent = mergeFetchedMessageIntoEvent(event, fetchResult.message);
    const hydrated = normalizeInboundEvent(enrichedEvent, options);
    return {
      event: enrichedEvent,
      normalized: {
        ...hydrated,
        attachmentFetch: {
          status: hydrated.downloadPlans.length > 0 ? 'ok' : 'no_file_key',
        },
      },
      fetched: true,
      fetchResult,
    };
  }

  return {
    event,
    normalized: {
      ...normalized,
      attachmentFetch: {
        status: 'fetch_failed',
        error: summarizeFetchFailure(fetchResult),
      },
      unsupportedReasons: [
        ...normalized.unsupportedReasons,
        `${normalized.messageType} message content fetch failed: ${summarizeFetchFailure(fetchResult)}`,
      ],
    },
    fetched: false,
    fetchResult,
  };
}

export function parseMergeForwardItems(items, options = {}) {
  const parentMessageId = options.parentMessageId || '';
  const children = normalizeMergeForwardChildren(items, parentMessageId);
  const lines = [];
  const downloadPlans = [];

  for (const item of children) {
    const child = normalizeMergeForwardChild(item, {
      resolveSenderName: options.resolveSenderName,
    });
    const prefix = child.senderLabel || '(unknown)';
    let contentText = '';

    if (child.messageType === 'text') {
      contentText = parseTextContent(child.content);
    } else if (child.messageType === 'post') {
      const post = parsePostContent(child.content);
      contentText = post.extractedText || '[富文本]';
      const attachments = post.attachments?.length
        ? post.attachments
        : post.imageKeys.map((imageKey) => ({ fileKey: imageKey, messageType: 'image' }));
      for (const attachment of attachments) {
        downloadPlans.push(makeDownloadPlan({
          messageId: child.messageId,
          fileKey: attachment.fileKey,
          messageType: attachment.messageType,
          suggestedName: attachment.fileName,
        }));
      }
    } else if (child.messageType === 'image' || child.messageType === 'file' || child.messageType === 'video') {
      const attachment = extractAttachmentInfo(child.content);
      const fileKey = attachment.fileKey;
      contentText = buildAttachmentPlaceholder(child.messageType, fileKey);
      if (fileKey) {
        downloadPlans.push(makeDownloadPlan({
          messageId: child.messageId,
          fileKey,
          messageType: child.messageType,
          suggestedName: attachment.fileName,
        }));
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
      profile: options.profile,
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

  const normalized = options.normalized || normalizeInboundEvent(event);
  const messageId = normalized.messageId || `event-${Date.now()}`;
  const createdAt = new Date(options.now || Date.now()).toISOString();
  const dir = path.join(options.inboxRoot, createdAt.slice(0, 10), safePathSegment(messageId));
  const attachmentsDir = path.join(dir, 'attachments');
  ensurePrivateDir(options.inboxRoot);
  ensurePrivateDir(path.dirname(dir));
  ensurePrivateDir(dir);
  ensurePrivateDir(attachmentsDir);

  writePrivateFile(path.join(dir, 'message.json'), `${JSON.stringify(event, null, 2)}\n`);
  writePrivateFile(path.join(dir, 'content.md'), renderContentMarkdown(normalized));

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
      profile: options.larkProfile,
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
    chmodTreePrivate(attachmentsDir);
  }

  writePrivateFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
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
        attachment: {
          fileKey: firstString(element.image_key, element.file_key, element.imageKey, element.fileKey),
          messageType: 'image',
        },
      };
    case 'media': {
      const messageType = normalizePostMediaMessageType(element);
      const fileKey = firstString(
        element.file_key,
        element.fileKey,
        element.video_key,
        element.videoKey,
        element.media_key,
        element.mediaKey,
        messageType === 'image' ? element.image_key : null,
        messageType === 'image' ? element.imageKey : null,
      );
      return {
        text: messageType === 'image' ? '' : buildAttachmentPlaceholder(messageType, fileKey),
        attachment: fileKey ? {
          fileKey,
          messageType,
          fileName: firstString(element.name, element.file_name, element.fileName),
        } : null,
      };
    }
    default:
      return { text: stringOrEmpty(element.text || element.name) };
  }
}

function normalizePostMediaMessageType(element) {
  const type = firstString(element.message_type, element.msg_type, element.media_type, element.type, element.file_type);
  if (/image/i.test(type || '')) return 'image';
  if (/file/i.test(type || '')) return 'file';
  return 'video';
}

function normalizePostEnvelope(parsed) {
  if (!isPlainObject(parsed)) return parsed;
  if (Array.isArray(parsed.content)) return parsed;
  for (const value of Object.values(parsed)) {
    if (isPlainObject(value) && Array.isArray(value.content)) return value;
  }
  return parsed;
}

function makeDownloadPlan({ messageId, fileKey, messageType, suggestedName }) {
  const label = DOWNLOAD_LABEL_BY_MESSAGE_TYPE[messageType] || messageType || 'file';
  return {
    messageId,
    fileKey,
    messageType,
    resourceType: DOWNLOAD_RESOURCE_TYPE_BY_MESSAGE_TYPE[messageType] || 'file',
    label,
    suggestedName: suggestedName || `${label}-${safePathSegment(fileKey || 'resource')}`,
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

function extractMergeForwardItemsFromFetchResult(parsed) {
  for (const candidate of [
    parsed?.data?.items,
    parsed?.items,
    parsed?.messages,
    parsed?.data?.messages,
    parsed?.data?.message?.items,
    parsed?.message?.items,
  ]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function extractMessageFromFetchResult(parsed, messageId) {
  const candidates = [
    ...(Array.isArray(parsed?.data?.items) ? parsed.data.items : []),
    ...(Array.isArray(parsed?.items) ? parsed.items : []),
    parsed?.data?.message,
    parsed?.message,
    parsed?.data?.item,
    parsed?.item,
    parsed?.data,
  ].filter(isPlainObject);
  return candidates.find((item) => firstString(item.message_id, item.id) === messageId) || candidates[0] || null;
}

function isSuccessfulLarkApiResult(parsed) {
  if (!isPlainObject(parsed)) return false;
  if (parsed.code !== undefined && Number(parsed.code) !== 0) return false;
  if (parsed.error !== undefined && parsed.error) return false;
  return true;
}

function needsAttachmentContentFetch(normalized) {
  if (!normalized?.messageId) return false;
  if (!['image', 'file', 'video'].includes(normalized.messageType)) return false;
  if (normalized.downloadPlans.length > 0) return false;
  return !extractAttachmentInfo(normalized.content).fileKey;
}

function mergeFetchedMessageIntoEvent(event, message) {
  const content = firstString(message?.body?.content, message?.content, event?.content);
  const messageType = firstString(event?.message_type, event?.msg_type, message?.msg_type, message?.message_type, message?.type);
  return {
    ...event,
    ...message,
    message_id: firstString(event?.message_id, event?.id, message?.message_id, message?.id),
    id: firstString(event?.id, message?.id, event?.message_id, message?.message_id),
    chat_id: firstString(event?.chat_id, message?.chat_id),
    chat_type: firstString(event?.chat_type, message?.chat_type),
    sender_id: firstString(event?.sender_id, message?.sender_id),
    message_type: messageType,
    msg_type: messageType,
    content,
    body: {
      ...(message?.body || {}),
      content,
    },
  };
}

function normalizeMergeForwardChildren(items, parentMessageId) {
  if (!Array.isArray(items)) return [];
  if (!parentMessageId) return items;
  const children = items.filter((item) => item?.upper_message_id === parentMessageId || item?.parent_message_id === parentMessageId);
  return children.length > 0 ? children : items.filter((item) => item?.message_id !== parentMessageId);
}

function normalizeMergeForwardChild(item, options = {}) {
  const senderId = firstString(
    item?.sender?.sender_id?.open_id,
    item?.sender?.sender_id?.user_id,
    item?.sender?.id,
    item?.sender_id,
  );
  const senderName = firstString(item?.sender?.name, item?.sender?.sender_name, item?.sender_name, item?.from?.name) ||
    options.resolveSenderName?.(senderId);
  const senderType = firstString(item?.sender?.sender_type, item?.sender_type);
  const senderLabel = senderType === 'bot' ? '(bot)' : senderName || senderId || '(unknown)';
  return {
    senderLabel,
    messageId: firstString(item?.message_id, item?.id),
    messageType: firstString(item?.msg_type, item?.message_type, item?.type),
    content: normalizeChildContent(item?.body?.content ?? item?.content),
  };
}

function normalizeChildContent(value) {
  const direct = firstString(value);
  if (direct !== null) return direct;
  if (isPlainObject(value) || Array.isArray(value)) return JSON.stringify(value);
  return '';
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

function parseJsonOutput(stdout) {
  const value = String(stdout || '').trim();
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {}

  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(value.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function summarizeFetchFailure(fetchResult = {}) {
  if (fetchResult.failureSummary) return fetchResult.failureSummary;
  const pieces = [];
  if (fetchResult.error) pieces.push(fetchResult.error);
  if (fetchResult.status !== undefined && fetchResult.status !== null) pieces.push(`exit=${fetchResult.status}`);
  if (fetchResult.signal) pieces.push(`signal=${fetchResult.signal}`);
  const parsed = fetchResult.parsed || parseJsonOutput(fetchResult.stderr) || parseJsonOutput(fetchResult.stdout);
  for (const value of extractSafeErrorFields(parsed)) {
    pieces.push(value);
  }
  const stderr = safeDiagnosticText(fetchResult.stderr);
  if (stderr) pieces.push(stderr);
  if (!pieces.length) pieces.push('no child messages returned');
  return pieces.join('; ');
}

function extractSafeErrorFields(parsed) {
  const fields = [];
  const candidates = [
    parsed?.code,
    parsed?.msg,
    parsed?.message,
    parsed?.error,
    parsed?.hint,
    parsed?._notice,
    parsed?.data?.code,
    parsed?.data?.msg,
    parsed?.data?.message,
    parsed?.data?.hint,
    parsed?.error?.message,
  ];
  for (const candidate of candidates) {
    const value = safeDiagnosticText(candidate);
    if (value && !fields.includes(value)) fields.push(value);
  }
  for (const violation of parsed?.permission_violations || parsed?.data?.permission_violations || []) {
    const value = safeDiagnosticText(violation?.scope || violation?.name || violation);
    if (value && !fields.includes(value)) fields.push(value);
  }
  return fields;
}

function safeDiagnosticText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (/[{[]/.test(text) || /\b(content|items|messages|body|message_id|sender_id)\b/i.test(text)) {
    return '';
  }
  return text.slice(0, 300);
}

function mergeForwardFetchFailureText(fetchResult) {
  return [
    '[合并转发消息：无法获取子消息内容]',
    `原因：${summarizeFetchFailure(fetchResult)}`,
    '请确认当前 bot/profile 具备消息读取权限，并且该 bot 能访问这条合并转发消息所在会话。',
    '常见缺失权限：im:message.group_msg、contact:user.base:readonly；如果用 user 身份读取，还需要对应 user OAuth 权限。',
  ].join('\n');
}

function parseTagAttributes(value) {
  if (typeof value !== 'string') return {};
  const trimmed = value.trim();
  if (!/^<[A-Za-z][\w:.-]*(?:\s|\/?>)/.test(trimmed)) return {};
  const attrs = {};
  const attrPattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+))/g;
  for (const match of trimmed.matchAll(attrPattern)) {
    attrs[match[1]] = decodeXmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
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

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function writePrivateFile(file, content) {
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function chmodTreePrivate(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      fs.chmodSync(fullPath, 0o700);
      chmodTreePrivate(fullPath);
    } else if (entry.isFile()) {
      fs.chmodSync(fullPath, 0o600);
    }
  }
  fs.chmodSync(dir, 0o700);
}

function safeRelativeOutput(value) {
  return safePathSegment(value).replace(/^\.+$/, 'resource');
}

function safePathSegment(value) {
  return String(value || 'unknown')
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
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

function uniqueAttachments(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (!item?.fileKey || !item?.messageType) continue;
    const key = `${item.messageType}:${item.fileKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
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
