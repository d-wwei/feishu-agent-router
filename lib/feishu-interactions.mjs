import { buildLarkCliArgs } from './lark-cli.mjs';

const DEFAULT_LARK_AS = 'bot';

const PHASE1_RULES = [
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

const LOW_SIGNAL_SOCIAL_TEXT = new Set([
  'hi',
  'hi there',
  'hello',
  'hey',
  '你好',
  '您好',
  '早上好',
  '晚上好',
  '早安',
  '晚安',
  'morning',
  'evening',
  'bye',
  'bye bye',
  'goodbye',
  'see you',
  '再见',
  '拜拜',
  '回头见',
  '晚点聊',
]);

export function pickPhase1Emoji(text) {
  const normalized = String(text || '');
  if (isLowSignalSocialText(normalized)) return null;
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

function isLowSignalSocialText(text) {
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/[，。,.!！?？~～]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return LOW_SIGNAL_SOCIAL_TEXT.has(normalized);
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

function withDryRun(argv, dryRun) {
  return dryRun ? [...argv, '--dry-run'] : argv;
}

function stringify(value) {
  return JSON.stringify(value);
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
}
