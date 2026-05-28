import {
  isCodexFirstActivityTimeout,
  isCodexHardTimeout,
  isCodexIdleTimeout,
  isCodexTurnTimeoutError,
} from './codex-turn-timeout.mjs';

const QUEUE_BYPASS_COMMANDS = new Set(['/interrupt', '/status']);
export const STOPPED_SESSION_ERROR_CODE = 'FTB_SESSION_STOPPED';

export function shouldUseTmuxFallback(session, cfg, error = null) {
  if (isCodexTimeoutOrInterruptError(error)) return false;
  return session?.backend === 'codex-app-server' &&
    session.fallback !== false &&
    cfg?.enableTmuxFallback === true;
}

export function isCodexFirstOutputTimeout(error) {
  return isCodexFirstActivityTimeout(error);
}

export function isCodexTurnTimeout(error) {
  return isCodexTurnTimeoutError(error);
}

export function isCodexTimeoutOrInterruptError(error) {
  if (!error) return false;
  if (isCodexFirstOutputTimeout(error) || isCodexTurnTimeout(error)) return true;
  const message = String(error?.message || error || '');
  const code = String(error?.code || '');
  const name = String(error?.name || '');
  if (/timeout|timed out|etimedout/i.test(`${name} ${code} ${message}`)) return true;
  return /\binterrupt(?:ed| requested|ion)?\b/i.test(message) ||
    /\bturn\/interrupt\b/i.test(message);
}

export function shouldBypassGlobalQueue(content) {
  return QUEUE_BYPASS_COMMANDS.has(commandNameFromContent(content));
}

export function commandNameFromContent(content) {
  return String(content || '').trim().split(/\s+/, 1)[0]?.toLowerCase() || '';
}

export function isManuallyStoppedSession(session) {
  return session?.backend === 'codex-app-server' &&
    session.state === 'stopped' &&
    session.stopReason === 'manual';
}

export function stoppedSessionError(sessionName) {
  const error = new Error(`session ${sessionName} is stopped`);
  error.code = STOPPED_SESSION_ERROR_CODE;
  error.sessionName = sessionName;
  return error;
}

export function isStoppedSessionError(error) {
  return error?.code === STOPPED_SESSION_ERROR_CODE;
}

export function userFacingSessionError(error, sessionName) {
  if (isStoppedSessionError(error)) {
    return [
      `session=${sessionName} 已停止，普通消息不会投递到 Codex app-server。`,
      `请发 /restart ${sessionName} 恢复后再发送。`,
    ].join('\n');
  }
  if (isCodexFirstOutputTimeout(error)) {
    return [
      'Codex 这轮没有及时开始活动，我已经中断并重置了会话。',
      `你可以直接重发刚才那句，session=${sessionName}。`,
    ].join('\n');
  }
  if (isCodexIdleTimeout(error)) {
    const last = error?.diagnostics?.lastActivityType
      ? `最后活动：${error.diagnostics.lastActivityType}。`
      : '';
    return [
      'Codex 这轮长时间没有新活动，我已经中断当前 turn，避免卡住后续消息。',
      last,
      `session=${sessionName} 仍然保留在 Codex app-server；你可以继续追问或拆小任务继续。`,
    ].filter(Boolean).join('\n');
  }
  if (isCodexHardTimeout(error)) {
    return [
      'Codex 这轮运行超过最长时限，我已经中断当前 turn。',
      `session=${sessionName} 仍然保留在 Codex app-server；建议把任务拆成更小步骤，或改成后台任务模式。`,
    ].join('\n');
  }
  if (isCodexTurnTimeout(error)) {
    return [
      'Codex 这轮处理超时，我已经中断这次 turn，但不会切到 tmux fallback。',
      `session=${sessionName} 仍然保留在 Codex app-server；请重发或拆小任务继续。`,
    ].join('\n');
  }
  return [
    `投递到 ${sessionName} 失败。`,
    '',
    error?.message || String(error),
    '',
    '桥接服务仍在运行；请稍后重试，或发 /status 查看 session 状态。',
  ].join('\n');
}
