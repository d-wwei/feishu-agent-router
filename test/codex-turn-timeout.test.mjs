import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CODEX_FIRST_ACTIVITY_TIMEOUT,
  CODEX_TURN_HARD_TIMEOUT,
  CODEX_TURN_IDLE_TIMEOUT,
  CodexTurnTimeoutController,
  createCodexTurnTimeoutError,
  isCodexFirstActivityTimeout,
  isCodexHardTimeout,
  isCodexIdleTimeout,
} from '../lib/codex-turn-timeout.mjs';

test('turn activity refreshes a non-destructive idle warning', () => {
  const clock = new FakeClock();
  const turn = { threadId: 'thread_1', turnId: 'turn_1', startedAt: 0, text: 'working', timing: {} };
  const timeouts = [];
  const warnings = [];
  const controller = new CodexTurnTimeoutController({
    turn,
    firstActivityTimeoutMs: 90_000,
    idleTimeoutMs: 300_000,
    hardTimeoutMs: 900_000,
    now: () => clock.now,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    onTimeout: (kind, error) => timeouts.push({ kind, error }),
    onInactivity: (notice) => warnings.push(notice),
  });

  controller.start();
  clock.tick(89_000);
  controller.recordActivity('item/agentMessage/delta', 'hello');
  assert.equal(turn.timing.firstOutputMs, 89_000);

  clock.tick(299_000);
  controller.recordActivity('item/completed', 'tool finished');
  clock.tick(299_999);
  assert.deepEqual(timeouts, []);

  clock.tick(1);
  assert.deepEqual(timeouts, []);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'idle');
  assert.equal(warnings[0].diagnostics.lastActivityType, 'item/completed');
  assert.equal(warnings[0].thresholdMs, 300_000);
});

test('first activity silence warns once and never interrupts or repeats automatically', () => {
  const clock = new FakeClock();
  const warnings = [];
  const timeouts = [];
  const controller = new CodexTurnTimeoutController({
    turn: { startedAt: 0 },
    firstActivityTimeoutMs: 90_000,
    idleTimeoutMs: 300_000,
    now: () => clock.now,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    onInactivity: (notice) => warnings.push(notice),
    onTimeout: (kind) => timeouts.push(kind),
  });
  controller.start();
  clock.tick(24 * 60 * 60 * 1000);
  assert.deepEqual(timeouts, []);
  assert.deepEqual(warnings.map((notice) => notice.kind), ['first-activity']);
  controller.recordActivity('item/started', 'commandExecution');
  clock.tick(300_000);
  clock.tick(24 * 60 * 60 * 1000);
  assert.deepEqual(timeouts, []);
  assert.deepEqual(warnings.map((notice) => notice.kind), ['first-activity', 'idle']);
  controller.recordActivity('item/completed', 'commandExecution');
  clock.tick(300_000);
  assert.equal(warnings.length, 3);
});

test('zero disables inactivity detection and clear prevents late callbacks', () => {
  const clock = new FakeClock();
  const warnings = [];
  const controller = new CodexTurnTimeoutController({
    turn: { startedAt: 0 },
    firstActivityTimeoutMs: 0,
    idleTimeoutMs: 0,
    onInactivity: (notice) => warnings.push(notice),
    now: () => clock.now,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
  });
  controller.start();
  controller.recordActivity('item/started');
  assert.equal(clock.timers.size, 0);
  controller.idleTimeoutMs = 100;
  controller.recordActivity('item/completed');
  controller.clear();
  clock.tick(1000);
  assert.deepEqual(warnings, []);
});

test('hard timeout is disabled when configured as 0', () => {
  const clock = new FakeClock();
  const turn = { threadId: 'thread_1', turnId: 'turn_1', startedAt: 0 };
  const timeouts = [];
  const controller = new CodexTurnTimeoutController({
    turn,
    firstActivityTimeoutMs: 90_000,
    idleTimeoutMs: 300_000,
    hardTimeoutMs: 0,
    now: () => clock.now,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    onTimeout: (kind, error) => timeouts.push({ kind, error }),
  });

  controller.start();
  clock.tick(30_000);
  controller.recordActivity('item/agentMessage/delta', 'started');
  for (let i = 0; i < 8; i += 1) {
    clock.tick(250_000);
    controller.recordActivity('item/tool/call', `step ${i}`);
  }

  assert.deepEqual(timeouts, []);
});

test('explicit hard timeout is not refreshed by activity', () => {
  const clock = new FakeClock();
  const turn = { threadId: 'thread_1', turnId: 'turn_1', startedAt: 0 };
  const timeouts = [];
  const controller = new CodexTurnTimeoutController({
    turn,
    firstActivityTimeoutMs: 90_000,
    idleTimeoutMs: 300_000,
    hardTimeoutMs: 900_000,
    now: () => clock.now,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    onTimeout: (kind, error) => timeouts.push({ kind, error }),
  });

  controller.start();
  clock.tick(30_000);
  controller.recordActivity('item/tool/call', 'step 0');
  for (let i = 1; i < 4; i += 1) {
    clock.tick(250_000);
    controller.recordActivity('item/tool/call', `step ${i}`);
  }
  assert.deepEqual(timeouts, []);

  clock.tick(120_000);
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].kind, 'hard');
  assert.equal(timeouts[0].error.code, CODEX_TURN_HARD_TIMEOUT);
});

test('first activity timeout keeps legacy retry code', () => {
  const error = createCodexTurnTimeoutError('first-activity', 90_000);

  assert.equal(error.code, CODEX_FIRST_ACTIVITY_TIMEOUT);
  assert.equal(isCodexFirstActivityTimeout(error), true);
  assert.equal(isCodexIdleTimeout(createCodexTurnTimeoutError('idle', 300_000)), true);
  assert.equal(isCodexHardTimeout(createCodexTurnTimeoutError('hard', 900_000)), true);
});

class FakeClock {
  now = 0;
  nextId = 1;
  timers = new Map();

  setTimeout(fn, ms) {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  }

  clearTimeout(id) {
    this.timers.delete(id);
  }

  tick(ms) {
    const target = this.now + ms;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.now = timer.at;
      timer.fn();
    }
    this.now = target;
  }
}
