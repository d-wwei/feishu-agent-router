import { buildLarkCliArgs } from './lark-cli.mjs';

const DEFAULT_LARK_AS = 'bot';

const PHASE1_RULES = [
  { patterns: /你好|hi\b|hello|hey|早上好|晚上好|早安|晚安|morning|evening/i, emoji: 'WAVE' },
  { patterns: /哈哈|lol|笑|funny|有趣|搞笑|joke|段子|逗/i, emoji: 'LAUGH' },
  { patterns: /谢谢|thanks|thank you|辛苦|感谢|多谢/i, emoji: 'HEART' },
  { patterns: /urgent|赶紧|马上|asap|挂了|炸了|紧急|立刻|crash/i, emoji: 'Fire' },
  { patterns: /帮我|请|麻烦|do\b|create|make|生成|建|搭/i, emoji: 'OnIt' },
  { patterns: /分析|看看|检查|查一下|debug|排查|诊断|investigate/i, emoji: 'SMART' },
  { patterns: /code|function|api|deploy|bug|error|报错|代码|部署|编译/i, emoji: 'StatusFlashOfInspiration' },
  { patterns: /写|总结|报告|翻译|review|文档|draft|文章/i, emoji: 'StatusReading' },
  { patterns: /为什么|怎么|什么|如何|explain|对比|区别|原理|how|why|吗|呢/i, emoji: 'THINKING' },
  { patterns: /推荐|建议|选择|比较|哪个|should|suggest|recommend/i, emoji: 'THINKING' },
];

const PHASE2_RULES = [
  { patterns: /```[\s\S]{50,}```/m, emoji: 'DONE' },
  { patterns: /\b(fix|fixed|解决|修复|搞定|完成)\b/i, emoji: 'CheckMark' },
  { patterns: /\b(warning|注意|caution|小心|风险)\b/i, emoji: 'Alarm' },
  { patterns: /\b(sorry|抱歉|unfortunately|遗憾|无法|不支持)\b/i, emoji: 'FROWN' },
  { patterns: /[😂🤣😄😆]|哈哈|笑/u, emoji: 'LOL' },
  { patterns: /\|.*\|.*\|/m, emoji: 'SMART' },
  { patterns: /^\s*(\d+\.|[-*])\s/m, emoji: 'APPLAUSE' },
];

const PERMISSION_ACTIONS = new Set(['allow', 'allow_session', 'deny']);

export function pickPhase1Emoji(text) {
  const normalized = String(text || '');
  for (const rule of PHASE1_RULES) {
    if (rule.patterns.test(normalized)) return rule.emoji;
  }
  return normalized.trim().length > 5 ? 'THINKING' : null;
}

export function pickPhase2Emojis(_inbound, response, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 2;
  const normalized = String(response || '');
  const result = [];
  const seen = new Set();

  for (const rule of PHASE2_RULES) {
    if (rule.patterns.test(normalized) && !seen.has(rule.emoji)) {
      seen.add(rule.emoji);
      result.push(rule.emoji);
      if (result.length >= limit) break;
    }
  }

  return result;
}

export function buildReactionCreateArgv({ messageId, emojiType, larkAs = DEFAULT_LARK_AS, larkProfile = '', dryRun = false } = {}) {
  assertNonEmptyString(messageId, 'messageId');
  assertNonEmptyString(emojiType, 'emojiType');

  return withDryRun(buildLarkCliArgs([
    'im',
    'reactions',
    'create',
    '--as',
    larkAs,
    '--params',
    stringify({ message_id: messageId }),
    '--data',
    stringify({ reaction_type: { emoji_type: emojiType } }),
  ], { profile: larkProfile }), dryRun);
}

export function buildReactionDeleteArgv({ messageId, reactionId, larkAs = DEFAULT_LARK_AS, larkProfile = '', dryRun = false } = {}) {
  assertNonEmptyString(messageId, 'messageId');
  assertNonEmptyString(reactionId, 'reactionId');

  return withDryRun(buildLarkCliArgs([
    'im',
    'reactions',
    'delete',
    '--as',
    larkAs,
    '--params',
    stringify({ message_id: messageId, reaction_id: reactionId }),
  ], { profile: larkProfile }), dryRun);
}

export function buildStreamingCard(text, { pending = true, footerText = 'Generating...' } = {}) {
  const elements = [
    {
      tag: 'markdown',
      content: String(text || ''),
    },
  ];

  if (pending) {
    elements.push({
      tag: 'note',
      elements: [
        { tag: 'plain_text', content: footerText },
      ],
    });
  }

  return {
    config: { wide_screen_mode: true },
    elements,
  };
}

export function buildStreamingCardContent(text, options = {}) {
  return stringify(buildStreamingCard(text, options));
}

export function buildStreamingCardSendArgv({
  chatId,
  text,
  larkAs = DEFAULT_LARK_AS,
  larkProfile = '',
  idempotencyKey,
  dryRun = false,
  pending = true,
} = {}) {
  assertNonEmptyString(chatId, 'chatId');

  const argv = buildLarkCliArgs([
    'im',
    '+messages-send',
    '--as',
    larkAs,
    '--chat-id',
    chatId,
    '--msg-type',
    'interactive',
    '--content',
    buildStreamingCardContent(text, { pending }),
  ], { profile: larkProfile });

  if (idempotencyKey) argv.push('--idempotency-key', idempotencyKey);
  return withDryRun(argv, dryRun);
}

export function buildStreamingCardPatchArgv({
  messageId,
  text,
  larkAs = DEFAULT_LARK_AS,
  larkProfile = '',
  dryRun = false,
  pending = true,
} = {}) {
  assertNonEmptyString(messageId, 'messageId');

  return withDryRun(buildLarkCliArgs([
    'api',
    'PATCH',
    `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
    '--as',
    larkAs,
    '--data',
    stringify({ content: buildStreamingCardContent(text, { pending }) }),
  ], { profile: larkProfile }), dryRun);
}

export function buildStreamingCardDeleteArgv({ messageId, larkAs = DEFAULT_LARK_AS, larkProfile = '', dryRun = false } = {}) {
  assertNonEmptyString(messageId, 'messageId');

  return withDryRun(buildLarkCliArgs([
    'im',
    'messages',
    'delete',
    '--as',
    larkAs,
    '--params',
    stringify({ message_id: messageId }),
  ], { profile: larkProfile }), dryRun);
}

export function buildPermissionCallbackData(action, permissionId) {
  assertPermissionAction(action);
  assertNonEmptyString(permissionId, 'permissionId');
  return `perm:${action}:${permissionId}`;
}

export function buildPermissionActionValue({ action, permissionId, callbackData, chatId } = {}) {
  const normalizedCallbackData = callbackData || buildPermissionCallbackData(action, permissionId);
  const parsed = parsePermissionCallbackData(normalizedCallbackData);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  assertNonEmptyString(chatId, 'chatId');

  return {
    callbackData: normalizedCallbackData,
    chatId,
  };
}

export function parsePermissionCallbackData(input = {}) {
  const callbackData = typeof input === 'string'
    ? input
    : String(input?.callbackData || input?.action?.value?.callbackData || '');
  const chatId = typeof input === 'object' && input !== null
    ? stringOrNull(input.chatId || input?.action?.value?.chatId)
    : null;
  const openMessageId = typeof input === 'object' && input !== null
    ? stringOrNull(input.openMessageId || input.open_message_id)
    : null;

  if (!callbackData) {
    return { ok: false, error: 'missing callbackData' };
  }

  const parts = callbackData.split(':');
  if (parts[0] !== 'perm') {
    return { ok: false, error: 'unsupported callbackData prefix', callbackData };
  }

  const action = parts[1] || '';
  const permissionId = parts.slice(2).join(':');
  if (!PERMISSION_ACTIONS.has(action)) {
    return { ok: false, error: `unsupported permission action: ${action || '(empty)'}`, callbackData };
  }
  if (!permissionId) {
    return { ok: false, error: 'missing permissionId', callbackData, action };
  }

  return {
    ok: true,
    callbackData,
    action,
    permissionId,
    chatId,
    openMessageId,
    command: `/perm ${action} ${permissionId}`,
  };
}

export function buildPermissionResultCard(input = {}) {
  const parsed = input.parsed?.ok
    ? input.parsed
    : parsePermissionCallbackData(input.callbackData || input);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }

  const handled = input.handled !== false;
  const selectedLabel = permissionActionLabel(parsed.action);
  const title = handled ? 'Permission Resolved' : 'Permission Already Handled';
  const summary = handled
    ? `**Selected:** ${selectedLabel}\n**Request ID:** \`${parsed.permissionId}\``
    : `**Selection ignored:** ${selectedLabel}\nThis permission request was already handled or no longer exists.\n**Request ID:** \`${parsed.permissionId}\``;

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: handled ? permissionHeaderTemplate(parsed.action) : 'grey',
      title: { tag: 'plain_text', content: title },
    },
    elements: [
      { tag: 'markdown', content: summary },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          buildResolvedButton('Allow', parsed.action === 'allow', 'primary'),
          buildResolvedButton('Allow Session', parsed.action === 'allow_session', 'primary'),
          buildResolvedButton('Deny', parsed.action === 'deny', 'danger'),
        ],
      },
    ],
  };
}

export function buildPermissionResultCardPatchArgv({
  messageId,
  callbackData,
  parsed,
  handled = true,
  larkAs = DEFAULT_LARK_AS,
  larkProfile = '',
  dryRun = false,
} = {}) {
  assertNonEmptyString(messageId, 'messageId');
  const card = buildPermissionResultCard({ callbackData, parsed, handled });

  return withDryRun(buildLarkCliArgs([
    'api',
    'PATCH',
    `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
    '--as',
    larkAs,
    '--data',
    stringify({ content: stringify(card) }),
  ], { profile: larkProfile }), dryRun);
}

export function permissionActionLabel(action) {
  switch (action) {
    case 'allow':
      return 'Allow';
    case 'allow_session':
      return 'Allow Session';
    case 'deny':
      return 'Deny';
    default:
      return String(action || 'unknown');
  }
}

function buildResolvedButton(label, selected, selectedType) {
  return {
    tag: 'button',
    text: {
      tag: 'plain_text',
      content: selected ? `${label} Selected` : `${label} Disabled`,
    },
    type: selected ? selectedType : 'default',
  };
}

function permissionHeaderTemplate(action) {
  return action === 'deny' ? 'red' : 'green';
}

function withDryRun(argv, dryRun) {
  return dryRun ? [...argv, '--dry-run'] : argv;
}

function stringify(value) {
  return JSON.stringify(value);
}

function assertPermissionAction(action) {
  if (!PERMISSION_ACTIONS.has(action)) {
    throw new Error(`Unsupported permission action: ${action || '(empty)'}`);
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
}

function stringOrNull(value) {
  return typeof value === 'string' && value ? value : null;
}
