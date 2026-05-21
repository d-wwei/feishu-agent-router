export function shouldUseTmuxFallback(session, cfg) {
  return session?.backend === 'codex-app-server' &&
    session.fallback !== false &&
    cfg?.enableTmuxFallback === true;
}

export function isCodexFirstOutputTimeout(error) {
  return error?.code === 'CODEX_FIRST_OUTPUT_TIMEOUT' ||
    /Timed out waiting for first Codex output event/i.test(error?.message || '');
}

export function isCodexTurnTimeout(error) {
  return /Timed out waiting for turn\/completed/i.test(error?.message || '');
}

export function userFacingSessionError(error, sessionName) {
  if (isCodexFirstOutputTimeout(error)) {
    return [
      'Codex 这轮没有及时开始输出，我已经中断并重置了会话。',
      `你可以直接重发刚才那句，session=${sessionName}。`,
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
