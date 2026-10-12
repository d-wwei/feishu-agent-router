const DELTA_METHODS = new Set([
  'item/agentMessage/delta',
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
  'item/plan/delta',
  'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta',
]);

const PROGRESS_METHODS = new Set([
  'item/commandExecution/terminalInteraction',
  'item/fileChange/patchUpdated',
  'item/mcpToolCall/progress',
  'item/reasoning/summaryPartAdded',
  'turn/plan/updated',
  'turn/diff/updated',
]);

export function codexActivityDetail(msg) {
  if (msg.method === 'item/started' || msg.method === 'item/completed') {
    return msg.params?.item?.type || 'item';
  }
  if (DELTA_METHODS.has(msg.method) && msg.params?.delta) return msg.method;
  if (PROGRESS_METHODS.has(msg.method)) return msg.method;
  return null;
}

export function formatInactivityNotice(notice, sessionName) {
  const seconds = Math.round(notice.thresholdMs / 1000);
  const description = notice.kind === 'first-activity'
    ? `这轮等待了 ${seconds} 秒，尚未观察到任务活动。`
    : `这轮已有 ${seconds} 秒没有新的任务活动信号。`;
  const health = notice.health === 'responding'
    ? 'Codex app-server 可以响应状态查询，但这不代表任务已有新进展。'
    : '暂时无法确认后端状态；查询未响应不等于任务已失败。';
  return [
    description,
    '任务可能仍在运行，也可能需要检查；桥接没有自动中断、重试或重建会话。',
    health,
    `session=${sessionName} 仍然保留。`,
    `查看状态：/status ${sessionName}`,
    `需要停止时：/interrupt ${sessionName}`,
  ].join('\n');
}
