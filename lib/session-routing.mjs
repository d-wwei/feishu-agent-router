import { createHash } from 'node:crypto';

export function ensureAutoGroupSession(state, event, cfg, opts = {}) {
  if (!cfg.autoCreateGroupSessions) return null;
  if (event.chat_type !== 'group' || !event.chat_id) return null;

  const existing = state.routes.chats[event.chat_id]?.defaultSession;
  if (existing) return { sessionName: existing, changed: false, created: false };

  const sessionName = autoGroupSessionName(event.chat_id, cfg.autoGroupSessionPrefix);
  const timestamp = opts.now || new Date().toISOString();
  if (!state.sessions[sessionName]) {
    state.sessions[sessionName] = {
      backend: cfg.defaultBackend,
      agent: cfg.defaultAgent,
      threadId: null,
      tmuxSession: `far-${sessionName}`,
      cwd: cfg.defaultWorkdir,
      command: cfg.defaultCommand,
      state: 'stopped',
      createdAt: timestamp,
      updatedAt: timestamp,
      autoCreated: true,
      sourceChatId: event.chat_id,
    };
  }
  state.routes.chats[event.chat_id] = {
    defaultSession: sessionName,
    autoCreated: true,
    updatedAt: timestamp,
  };
  return { sessionName, changed: true, created: true };
}

export function shouldIgnorePlainGroupMessage(event, cfg) {
  if (event.chat_type !== 'group') return false;
  if (!cfg.groupRequireCommand) return false;
  return !cfg.autoCreateGroupSessions;
}

export function autoGroupSessionName(chatId, prefix = 'group') {
  const safePrefix = sanitizeNamePart(prefix) || 'group';
  const digest = createHash('sha1').update(String(chatId)).digest('hex').slice(0, 10);
  return `${safePrefix}-${digest}`;
}

function sanitizeNamePart(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
