export function evaluateAllowlist(event = {}, cfg = {}) {
  const allowedSenders = Array.isArray(cfg.allowedSenders) ? cfg.allowedSenders : [];
  const allowedChats = Array.isArray(cfg.allowedChats) ? cfg.allowedChats : [];
  const senderId = String(event.sender_id || '');
  const chatId = String(event.chat_id || '');

  if (!cfg.allowUnrestricted && allowedSenders.length === 0 && allowedChats.length === 0) {
    return buildDeniedResult({
      reason: 'missing FTB_ALLOWED_SENDERS or FTB_ALLOWED_CHATS',
      field: 'allowlist',
      value: '',
      configuredCount: 0,
    });
  }

  if (allowedSenders.length && !allowedSenders.includes(senderId)) {
    return buildDeniedResult({
      reason: 'sender not in FTB_ALLOWED_SENDERS',
      field: 'sender_id',
      value: senderId,
      configuredCount: allowedSenders.length,
    });
  }

  if (allowedChats.length && !allowedChats.includes(chatId)) {
    return buildDeniedResult({
      reason: 'chat not in FTB_ALLOWED_CHATS',
      field: 'chat_id',
      value: chatId,
      configuredCount: allowedChats.length,
    });
  }

  return { allowed: true };
}

export function allowlistRemediation() {
  return [
    'Run farctl allowlist-capture locally to discover full sender_id/chat_id.',
    'Feishu open_id is app-scoped; update FTB_ALLOWED_SENDERS after changing bot/app.',
    'Set FTB_ALLOW_UNRESTRICTED=true only for an explicitly public bridge.',
  ];
}

export function extractIgnoredPolicyEvents(logText, { limit = 5 } = {}) {
  const events = [];
  for (const line of String(logText || '').split(/\r?\n/)) {
    if (!line.includes('ignored event by policy')) continue;
    const jsonStart = line.indexOf('{');
    if (jsonStart < 0) continue;
    try {
      events.push(JSON.parse(line.slice(jsonStart)));
    } catch {
      events.push({ raw: line });
    }
  }
  return events.slice(Math.max(0, events.length - limit));
}

function buildDeniedResult({ reason, field, value, configuredCount }) {
  return {
    allowed: false,
    reason,
    field,
    value,
    configuredCount,
    remediation: allowlistRemediation(),
  };
}
