const DEFAULT_LOCALE = 'zh_cn';

/**
 * Detect markdown that Feishu post messages do not render reliably.
 *
 * Code blocks and tables should be sent as interactive cards with schema 2.0
 * markdown elements. Simple markdown can use post content with an md tag.
 */
export function hasComplexMarkdown(value) {
  const text = String(value ?? '');

  if (/```[\s\S]*?```/.test(text)) return true;
  if (/~~~[\s\S]*?~~~/.test(text)) return true;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (looksLikeTableHeader(lines[i]) && looksLikeTableSeparator(lines[i + 1])) {
      return true;
    }
  }

  return false;
}

/**
 * Keep Feishu markdown predictable without changing code fence language tags.
 */
export function preprocessFeishuMarkdown(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/([^\n])(```|~~~)/g, '$1\n$2');
}

/**
 * Build a Feishu post payload using the rich-text md tag.
 */
export function buildPostContent(value, options = {}) {
  const locale = options.locale || DEFAULT_LOCALE;
  return {
    msg_type: 'post',
    content: stringifyContent({
      [locale]: {
        content: [[{ tag: 'md', text: preprocessFeishuMarkdown(value) }]],
      },
    }),
  };
}

/**
 * Build a Feishu interactive card payload with a schema 2.0 markdown body.
 */
export function buildCardContent(value, options = {}) {
  const card = buildSchemaCard(
    [{
      tag: 'markdown',
      content: preprocessFeishuMarkdown(value),
      text_align: 'left',
      text_size: 'normal',
    }],
    options,
  );

  return interactivePayload(card);
}

/**
 * Pick the best outbound payload for the supplied text.
 */
export function buildMessageContent(value, options = {}) {
  const text = preprocessFeishuMarkdown(value);
  return hasComplexMarkdown(text)
    ? buildCardContent(text, options)
    : buildPostContent(text, options);
}

/**
 * Build a streaming card payload. The body can also be reused with CardKit v2
 * update APIs by reading JSON.parse(payload.content).body.elements.
 */
export function buildStreamingCardContent(value = '', options = {}) {
  return interactivePayload(buildSchemaCard(buildStreamingCardBody(value, options), {
    ...options,
    streamingMode: options.streamingMode ?? true,
  }));
}

/**
 * Build the final card payload after streaming completes.
 */
export function buildFinalCardContent(value = '', options = {}) {
  return interactivePayload(buildSchemaCard(buildFinalCardBody(value, options), {
    ...options,
    streamingMode: false,
  }));
}

/**
 * Build a non-actionable permission notice card.
 *
 * Supports either:
 *   buildPermissionCardContent(text, permissionRequestId, chatId)
 * or:
 *   buildPermissionCardContent({ text, permissionRequestId, chatId, toolName })
 *
 * Feishu card callbacks are not wired in the router runtime, so this card must
 * not expose approval buttons or fallback commands as available controls.
 */
export function buildPermissionCardContent(input, permissionRequestId, chatId) {
  const options = normalizePermissionOptions(input, permissionRequestId, chatId);
  if (!options.permissionRequestId) {
    throw new Error('permissionRequestId is required');
  }

  const card = {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template: options.template || 'orange',
      title: {
        tag: 'plain_text',
        content: options.title || 'Permission Required',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content: preprocessFeishuMarkdown(options.text || buildPermissionText(options)),
      },
      {
        tag: 'markdown',
        content: [
          'This request was handled by the router runtime.',
          `Request ID: \`${options.permissionRequestId}\``,
        ].join('\n'),
        text_size: 'notation',
      },
    ],
  };

  return interactivePayload(card);
}

export function buildStreamingCardBody(value = '', options = {}) {
  const content = buildStreamingMarkdown(value, options);
  return [{
    tag: 'markdown',
    content,
    text_align: 'left',
    text_size: 'normal',
  }];
}

export function buildFinalCardBody(value = '', options = {}) {
  const elements = [];
  const content = preprocessFeishuMarkdown(value);

  if (content.trim()) {
    elements.push({
      tag: 'markdown',
      content,
      text_align: 'left',
      text_size: 'normal',
    });
  }

  const footer = buildFooterMarkdown(options);
  if (footer) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: footer,
      text_size: 'notation',
    });
  }

  return elements.length > 0
    ? elements
    : [{ tag: 'markdown', content: options.emptyText || 'Done.', text_size: 'normal' }];
}

export function formatStreamingTranscript(value = '') {
  const text = preprocessFeishuMarkdown(value).trim();
  if (!text) return '';

  const parts = splitMarkdownFences(text);
  return parts
    .map((part) => part.fence ? part.text.trim() : formatStreamingPlainText(part.text))
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

export function formatElapsed(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1000) return `${Math.round(value)}ms`;

  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;

  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function buildStreamingMarkdown(value, options) {
  const text = formatStreamingTranscript(value);
  return text ? `**实时进展**\n\n${text}` : options.thinkingText || 'Thinking...';
}

function splitMarkdownFences(value) {
  const parts = [];
  const fencePattern = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;
  let lastIndex = 0;
  let match;
  while ((match = fencePattern.exec(value)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ fence: false, text: value.slice(lastIndex, match.index) });
    }
    parts.push({ fence: true, text: match[0] });
    lastIndex = fencePattern.lastIndex;
  }
  if (lastIndex < value.length) {
    parts.push({ fence: false, text: value.slice(lastIndex) });
  }
  return parts.length ? parts : [{ fence: false, text: value }];
}

function formatStreamingPlainText(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const blocks = text.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  if (blocks.length > 1) return blocks.map(formatStreamingParagraph).join('\n\n');
  return formatStreamingParagraph(text);
}

function formatStreamingParagraph(value) {
  const text = String(value || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .trim();
  return text
    .replace(/([。！？!?])\s+(?=(我会|接下来|下一步|现在|收到|已|核心|但|如果|为了|This|The|I\b|I'm\b))/g, '$1\n\n')
    .replace(/([。！？!?])(?=(我会|接下来|下一步|现在|收到|已|核心|但|如果|为了|This|The|I\b|I'm\b))/g, '$1\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildSchemaCard(elements, options = {}) {
  const config = {
    wide_screen_mode: true,
    update_multi: true,
  };

  if (typeof options.streamingMode === 'boolean') {
    config.streaming_mode = options.streamingMode;
  }

  const card = {
    schema: '2.0',
    config,
    body: { elements },
  };

  if (options.title) {
    card.header = {
      template: options.template || 'blue',
      title: { tag: 'plain_text', content: String(options.title) },
    };
  }

  return card;
}

function buildFooterMarkdown(options = {}) {
  if (typeof options.footer === 'string') return options.footer.trim();

  const footer = options.footer && typeof options.footer === 'object'
    ? options.footer
    : {};
  const parts = [];

  const status = footer.status ?? options.status;
  const elapsed = footer.elapsed ?? options.elapsed ?? formatElapsed(footer.elapsedMs ?? options.elapsedMs);

  if (status) parts.push(String(status));
  if (elapsed) parts.push(String(elapsed));
  if (footer.text) parts.push(String(footer.text));

  return parts.join(' | ');
}

function buildPermissionText(options) {
  const lines = ['Permission Required'];
  if (options.toolName) lines.push('', `Tool: \`${options.toolName}\``);
  if (options.toolInput !== undefined) {
    lines.push('', 'Input:', fencedJson(options.toolInput, options.maxInputChars));
  }
  return lines.join('\n');
}

function normalizePermissionOptions(input, permissionRequestId, chatId) {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return {
      ...input,
      permissionRequestId: input.permissionRequestId ?? permissionRequestId,
      chatId: input.chatId ?? chatId,
    };
  }

  return {
    text: String(input ?? ''),
    permissionRequestId,
    chatId,
  };
}

function fencedJson(value, maxInputChars = 1200) {
  const json = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const truncated = json.length > maxInputChars
    ? `${json.slice(0, maxInputChars)}...`
    : json;
  return `\`\`\`json\n${truncated}\n\`\`\``;
}

function looksLikeTableHeader(line) {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  return trimmed.split('|').filter((cell) => cell.trim()).length >= 2;
}

function looksLikeTableSeparator(line) {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  return /^:?-{3,}:?$/.test(trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|')[0]?.trim() || '')
    && trimmed
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function interactivePayload(card) {
  return {
    msg_type: 'interactive',
    content: stringifyContent(card),
  };
}

function stringifyContent(content) {
  return JSON.stringify(content);
}
