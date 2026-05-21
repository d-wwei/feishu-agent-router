import {
  isCodexFirstActivityTimeout,
  isCodexHardTimeout,
  isCodexIdleTimeout,
  isCodexTurnTimeoutError,
} from './codex-turn-timeout.mjs';

export function shouldUseTmuxFallback(session, cfg) {
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

export function userFacingSessionError(error, sessionName) {
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
