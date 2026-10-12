import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const mode of ['silent', 'first-silent', 'health-unresponsive', 'notify-fails']) {
  test(`${mode}: silence warns once without interrupting, retrying or releasing the turn`, async (t) => {
    const h = await harness(t, mode);
    await h.wait(() => h.log().includes('codex turn inactive; continuing'));
    await sleep(500);
    assert.equal(h.requests('turn/interrupt').length, 0);
    assert.equal(h.requests('thread/start').length, 1);
    assert.equal(h.requests('turn/start').length, 1);
    assert.equal(h.requests('thread/read').length, 1);
    assert.ok(h.active());
    assert.ok(!h.log().includes('session turn failed'));
    if (mode === 'health-unresponsive') assert.match(h.log(), /"health":"unconfirmed"/);
    if (mode !== 'notify-fails') {
      assert.equal(h.replies().filter((text) => text.includes('没有自动中断')).length, 1);
    }
    h.finish();
    await h.wait(() => h.replies().includes('READY'));
    await h.wait(() => !h.active());
    assert.match(h.log(), /session turn completed/);
  });
}

test('zero disables both silence detectors in the actual bridge config parser', async (t) => {
  const h = await harness(t, 'first-silent', { first: 0, idle: 0 });
  await h.wait(() => h.requests('turn/start').length === 1);
  await sleep(650);
  assert.equal(h.requests('thread/read').length, 0);
  assert.equal(h.requests('turn/interrupt').length, 0);
  assert.ok(h.active());
  h.finish();
  await h.wait(() => h.replies().includes('READY'));
});

test('command output and reasoning progress keep a long-running turn active', async (t) => {
  const h = await harness(t, 'progress');
  await h.wait(() => h.requests('turn/start').length === 1);
  await sleep(650);
  assert.equal(h.requests('thread/read').length, 0);
  assert.equal(h.requests('turn/interrupt').length, 0);
  assert.ok(!h.log().includes('private-progress-payload'));
  h.finish();
  await h.wait(() => h.replies().includes('READY'));
});

test('late health response does not send a stale warning after completion', async (t) => {
  const h = await harness(t, 'health-late');
  await h.wait(() => h.replies().includes('READY'));
  await sleep(350);
  assert.equal(h.requests('thread/read').length, 1);
  assert.ok(!h.replies().some((text) => text.includes('没有自动中断')));
  assert.equal(h.requests('turn/interrupt').length, 0);
});

test('turn-start response and immediate completion in one packet are not lost', async (t) => {
  const h = await harness(t, 'burst-complete');
  await h.wait(() => h.replies().includes('READY'));
  await h.wait(() => !h.active());
  assert.equal(h.requests('thread/read').length, 0);
  assert.equal(h.requests('turn/interrupt').length, 0);
});

test('status and manual interrupt bypass the waiting ordinary-message queue', async (t) => {
  const h = await harness(t, 'silent');
  await h.wait(() => h.replies().some((text) => text.includes('没有自动中断')));
  h.send('another ordinary task', 'queued');
  h.send('/status main', 'status');
  await h.wait(() => h.replies('status').some((text) => text.includes('warning only')));
  assert.equal(h.requests('turn/start').length, 1);
  h.send('/interrupt main', 'interrupt');
  await h.wait(() => h.requests('turn/interrupt').length === 1);
  await h.wait(() => h.replies('initial').some((text) => text.includes('interrupted')));
  await h.wait(() => h.requests('turn/start').length === 2);
  h.finish();
  await h.wait(() => h.replies('queued').includes('READY'));
});

for (const mode of ['fatal-error', 'process-exit', 'transport-close']) {
  test(`${mode}: definite failure ends the turn without waiting for silence`, async (t) => {
    const h = await harness(t, mode, { first: 5000, idle: 5000 });
    await h.wait(() => h.log().includes('session turn failed'));
    await h.wait(() => !h.active());
    assert.equal(h.requests('turn/start').length, 1);
    assert.equal(h.requests('turn/interrupt').length, 0);
    assert.equal(h.requests('thread/read').length, 0);
  });
}

async function harness(t, mode, { first = 150, idle = 150 } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-inactivity-'));
  const bin = path.join(tmp, 'bin');
  const home = path.join(tmp, 'runtime');
  const eventsPath = path.join(tmp, 'events.json');
  const callsPath = path.join(tmp, 'calls.jsonl');
  const requestsPath = path.join(tmp, 'requests.jsonl');
  const finishPath = path.join(tmp, 'finish');
  const envPath = path.join(tmp, 'bridge.env');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(tmp, 'user'));
  fs.writeFileSync(eventsPath, '[]');
  fs.writeFileSync(path.join(bin, 'lark-cli'), fakeLark(), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'codex'), fakeCodex(), { mode: 0o755 });
  fs.writeFileSync(envPath, [
    'FTB_LARK_AS=bot',
    'FTB_LARK_PROFILE=isolated-test',
    'FTB_LARK_APP_ID=cli_isolated_test',
    'FTB_ALLOWED_SENDERS=ou_test',
    'FTB_ADMIN_USERS=ou_test',
    `FTB_HOME=${home}`,
    `FTB_WORKDIR=${tmp}`,
    'FTB_DEFAULT_BACKEND=codex-app-server',
    'FTB_PREWARM_CODEX=false',
    'FTB_FEISHU_REACTIONS=false',
    'FTB_FEISHU_STREAMING=off',
    'FTB_FEISHU_RICH_REPLIES=false',
    'FTB_ENABLE_TMUX_FALLBACK=false',
    `FTB_CODEX_FIRST_OUTPUT_TIMEOUT_MS=${first}`,
    `FTB_CODEX_TURN_IDLE_TIMEOUT_MS=${idle}`,
    'FTB_CODEX_TURN_HARD_TIMEOUT_MS=0',
    'FTB_CODEX_REQUEST_TIMEOUT_MS=2000',
    '',
  ].join('\n'));

  const child = spawn(process.execPath, [path.join(root, 'bin/bridge.mjs')], {
    cwd: root,
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HOME: path.join(tmp, 'user'),
      FTB_ENV_PATH: envPath,
      TEST_MODE: mode,
      TEST_EVENTS: eventsPath,
      TEST_CALLS: callsPath,
      TEST_REQUESTS: requestsPath,
      TEST_FINISH: finishPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  t.after(async () => {
    child.kill('SIGTERM');
    const deadline = Date.now() + 3000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(20);
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'Test bridge failed to exit');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const readRows = (file) => fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
  const events = [];
  const h = {
    log: () => output,
    active: () => fs.existsSync(path.join(home, 'data/active-turn.json')),
    requests: (method) => readRows(requestsPath).filter((row) => row.method === method),
    replies: (id) => readRows(callsPath)
      .filter((args) => args.includes('+messages-reply') && (!id || args.includes(`om_${id}`)))
      .map((args) => args[args.indexOf('--text') + 1]),
    finish: () => fs.writeFileSync(finishPath, 'finish'),
    send: (text, id) => {
      events.push({
        event_id: `ev_${id}`,
        message_id: `om_${id}`,
        chat_id: 'oc_test',
        chat_type: 'p2p',
        sender_id: 'ou_test',
        message_type: 'text',
        content: JSON.stringify({ text }),
      });
      fs.writeFileSync(eventsPath, JSON.stringify(events));
    },
    wait: async (predicate) => {
      const deadline = Date.now() + 7000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await sleep(20);
      }
      assert.fail(`Timed out in isolated ${mode} fixture:\n${output.slice(-3500)}`);
    },
  };
  h.send('run a long task', 'initial');
  return h;
}

function fakeLark() {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify(args) + '\\n');
if (args.includes('event') && args.includes('consume')) {
  let delivered = 0;
  setInterval(() => {
    let events;
    try { events = JSON.parse(fs.readFileSync(process.env.TEST_EVENTS, 'utf8')); } catch { return; }
    for (; delivered < events.length; delivered++) console.log(JSON.stringify(events[delivered]));
  }, 20);
  process.stdin.resume();
} else if (args.includes('+messages-reply')) {
  if (process.env.TEST_MODE === 'notify-fails' && args.some(x => x.includes('没有自动中断'))) process.exit(1);
  console.log(JSON.stringify({data: {message_id: 'om_test_reply'}}));
} else {
  console.log('[]');
}
`;
}

function fakeCodex() {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const rl = require('node:readline').createInterface({input: process.stdin});
const mode = process.env.TEST_MODE;
let turnId = null, sequence = 0, progress = null;
const send = x => console.log(JSON.stringify(x));
const event = (method, params) => send({method, params});
const finish = status => {
  if (!turnId) return;
  if (status === 'completed') event('item/completed', {turnId, item: {type: 'agentMessage', text: 'READY'}});
  event('turn/completed', {turn: {id: turnId, status}});
  turnId = null;
  clearInterval(progress);
};
setInterval(() => {
  if (turnId && fs.existsSync(process.env.TEST_FINISH)) finish('completed');
}, 20);
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (!msg.id) return;
  fs.appendFileSync(process.env.TEST_REQUESTS, JSON.stringify({method: msg.method}) + '\\n');
  if (msg.method === 'initialize') send({id: msg.id, result: {}});
  else if (msg.method === 'thread/start' || msg.method === 'thread/resume') send({id: msg.id, result: {thread: {id: 'thread_test'}}});
  else if (msg.method === 'turn/start') {
    turnId = 'turn_' + (++sequence);
    if (mode === 'burst-complete') {
      process.stdout.write([
        {id: msg.id, result: {turn: {id: turnId}}},
        {method: 'item/completed', params: {turnId, item: {type: 'agentMessage', text: 'READY'}}},
        {method: 'turn/completed', params: {turn: {id: turnId, status: 'completed'}}}
      ].map(x => JSON.stringify(x)).join('\\n') + '\\n');
      turnId = null;
      return;
    }
    send({id: msg.id, result: {turn: {id: turnId}}});
    setTimeout(() => {
      if (mode === 'fatal-error') event('error', {turnId, willRetry: false, error: {message: 'definite fixture failure'}});
      else if (mode === 'process-exit') process.exit(7);
      else if (mode === 'transport-close') process.stdout.end();
      else if (mode !== 'first-silent') event('item/started', {turnId, item: {type: 'commandExecution'}});
      if (mode === 'progress') progress = setInterval(() => {
        event('item/commandExecution/outputDelta', {turnId, delta: 'private-progress-payload'});
        event('item/reasoning/textDelta', {turnId, delta: 'private-progress-payload'});
      }, 30);
    }, 15);
  } else if (msg.method === 'thread/read') {
    if (mode === 'health-unresponsive') return;
    if (mode === 'health-late') {
      finish('completed');
      setTimeout(() => send({id: msg.id, result: {thread: {id: 'thread_test'}}}), 150);
    } else send({id: msg.id, result: {thread: {id: 'thread_test'}}});
  } else if (msg.method === 'turn/interrupt') {
    send({id: msg.id, result: {}});
    finish('interrupted');
  }
});
rl.on('close', () => process.exit(0));
`;
}
