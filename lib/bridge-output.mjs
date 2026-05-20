export function isFeishuSelfSendReceipt(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (text.length > 1000) return false;

  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() || '';
  const startsLikeReceipt = /^已(?:经)?回复(?:飞书|Feishu|Lark)(?:消息)?[：:]?/i.test(firstLine)
    || /^(?:sent|replied).{0,40}(?:feishu|lark)/i.test(firstLine);
  if (!startsLikeReceipt) return false;

  return /(?:消息|message)[ _-]*id\s*[：:]\s*`?om_[A-Za-z0-9_-]+`?/i.test(text)
    || /\bom_[A-Za-z0-9_-]{8,}\b/.test(text);
}
