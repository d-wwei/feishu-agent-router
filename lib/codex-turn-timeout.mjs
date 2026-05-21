export const CODEX_FIRST_ACTIVITY_TIMEOUT = 'CODEX_FIRST_OUTPUT_TIMEOUT';
export const CODEX_TURN_IDLE_TIMEOUT = 'CODEX_TURN_IDLE_TIMEOUT';
export const CODEX_TURN_HARD_TIMEOUT = 'CODEX_TURN_HARD_TIMEOUT';

const TIMEOUT_CODES = new Set([
  CODEX_FIRST_ACTIVITY_TIMEOUT,
  CODEX_TURN_IDLE_TIMEOUT,
  CODEX_TURN_HARD_TIMEOUT,
]);

export function createCodexTurnTimeoutError(kind, timeoutMs, diagnostics = {}) {
  const seconds = Math.round(timeoutMs / 1000);
  const error = new Error(messageForTimeout(kind, seconds));
  error.code = codeForKind(kind);
  error.timeoutKind = kind;
  error.timeoutMs = timeoutMs;
  error.diagnostics = diagnostics;
  return error;
}

export function isCodexTurnTimeoutError(error) {
  return TIMEOUT_CODES.has(error?.code) ||
    /Timed out waiting for turn\/completed/i.test(error?.message || '');
}

export function isCodexFirstActivityTimeout(error) {
  return error?.code === CODEX_FIRST_ACTIVITY_TIMEOUT ||
    /Timed out waiting for first Codex output event/i.test(error?.message || '') ||
    /Timed out waiting for first Codex activity/i.test(error?.message || '');
}

export function isCodexIdleTimeout(error) {
  return error?.code === CODEX_TURN_IDLE_TIMEOUT ||
    /Codex turn idle timeout/i.test(error?.message || '');
}

export function isCodexHardTimeout(error) {
  return error?.code === CODEX_TURN_HARD_TIMEOUT ||
    /Codex turn hard timeout/i.test(error?.message || '');
}

export function summarizeTurnDiagnostics(turn = {}, nowMs = Date.now()) {
  return {
    threadId: turn.threadId,
    turnId: turn.turnId,
    elapsedMs: Number.isFinite(turn.startedAt) ? nowMs - turn.startedAt : undefined,
    idleMs: Number.isFinite(turn.lastActivityAt) ? nowMs - turn.lastActivityAt : undefined,
    lastActivityAt: turn.lastActivityAt ?? null,
    lastActivityType: turn.lastActivityType ?? null,
    lastActivityDetail: turn.lastActivityDetail ?? null,
    lastAgentTextPreview: preview(turn.final || turn.text || ''),
  };
}

export class CodexTurnTimeoutController {
  constructor(options = {}) {
    this.turn = options.turn;
    this.firstActivityTimeoutMs = options.firstActivityTimeoutMs || 0;
    this.idleTimeoutMs = options.idleTimeoutMs || 0;
    this.hardTimeoutMs = options.hardTimeoutMs || 0;
    this.onTimeout = options.onTimeout;
    this.now = options.now || Date.now;
    this.setTimer = options.setTimeout || setTimeout;
    this.clearTimer = options.clearTimeout || clearTimeout;
    this.firstActivityTimer = null;
    this.idleTimer = null;
    this.hardTimer = null;
  }

  start() {
    if (this.firstActivityTimeoutMs > 0) {
      this.firstActivityTimer = this.arm('first-activity', this.firstActivityTimeoutMs);
    }
    if (this.hardTimeoutMs > 0) {
      this.hardTimer = this.arm('hard', this.hardTimeoutMs);
    }
  }

  recordActivity(type, detail = null) {
    const nowMs = this.now();
    this.turn.lastActivityAt = nowMs;
    this.turn.lastActivityType = type || 'unknown';
    this.turn.lastActivityDetail = detail ? preview(detail, 240) : null;
    if (this.turn.timing && this.turn.timing.firstOutputMs === undefined) {
      this.turn.timing.firstOutputMs = nowMs - this.turn.startedAt;
    }
    if (this.firstActivityTimer) {
      this.clearTimer(this.firstActivityTimer);
      this.firstActivityTimer = null;
    }
    if (this.idleTimeoutMs > 0) {
      if (this.idleTimer) this.clearTimer(this.idleTimer);
      this.idleTimer = this.arm('idle', this.idleTimeoutMs);
    }
  }

  clear() {
    if (this.firstActivityTimer) this.clearTimer(this.firstActivityTimer);
    if (this.idleTimer) this.clearTimer(this.idleTimer);
    if (this.hardTimer) this.clearTimer(this.hardTimer);
    this.firstActivityTimer = null;
    this.idleTimer = null;
    this.hardTimer = null;
  }

  arm(kind, timeoutMs) {
    const timer = this.setTimer(() => {
      const error = createCodexTurnTimeoutError(
        kind,
        timeoutMs,
        summarizeTurnDiagnostics(this.turn, this.now()),
      );
      this.onTimeout?.(kind, error);
    }, timeoutMs);
    timer?.unref?.();
    return timer;
  }
}

function codeForKind(kind) {
  if (kind === 'first-activity') return CODEX_FIRST_ACTIVITY_TIMEOUT;
  if (kind === 'idle') return CODEX_TURN_IDLE_TIMEOUT;
  if (kind === 'hard') return CODEX_TURN_HARD_TIMEOUT;
  return 'CODEX_TURN_TIMEOUT';
}

function messageForTimeout(kind, seconds) {
  if (kind === 'first-activity') {
    return `Timed out waiting for first Codex activity after ${seconds}s`;
  }
  if (kind === 'idle') {
    return `Codex turn idle timeout after ${seconds}s without activity; interrupt requested`;
  }
  if (kind === 'hard') {
    return `Codex turn hard timeout after ${seconds}s; interrupt requested`;
  }
  return `Codex turn timeout after ${seconds}s`;
}

function preview(text, max = 500) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
}
