#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const ENV_PATH = path.join(ROOT, '.env');

loadDotEnv(ENV_PATH);

const HOME_DIR = env('FTB_HOME', ROOT);
const DATA_DIR = path.join(HOME_DIR, 'data');
const LOG_DIR = path.join(HOME_DIR, 'logs');
const INBOX_DIR = path.join(HOME_DIR, 'inbox');
const SEEN_PATH = path.join(DATA_DIR, 'seen.json');
const SESSIONS_PATH = path.join(DATA_DIR, 'sessions.json');
const ROUTES_PATH = path.join(DATA_DIR, 'routes.json');
const USER_CONTEXT_PATH = path.join(DATA_DIR, 'user-context.json');
const AUDIT_PATH = path.join(LOG_DIR, 'audit.jsonl');
const LOG_PATH = path.join(LOG_DIR, 'router.log');

for (const dir of [DATA_DIR, LOG_DIR, INBOX_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const cfg = {
  larkAs: env('FTB_LARK_AS', 'bot'),
  allowedSenders: csvEnv('FTB_ALLOWED_SENDERS'),
  allowedChats: csvEnv('FTB_ALLOWED_CHATS'),
  adminUsers: csvEnv('FTB_ADMIN_USERS', env('FTB_ALLOWED_SENDERS', '')),
  defaultSession: env('FTB_DEFAULT_SESSION', 'main'),
  defaultWorkdir: env('FTB_WORKDIR', process.env.HOME || '/tmp'),
  defaultTmuxSession: env('FTB_TMUX_SESSION', 'far-main'),
  defaultAgent: env('FTB_DEFAULT_AGENT', 'codex'),
  defaultCommand: env(
    'FTB_AGENT_CMD',
    env('FTB_CODEX_CMD', 'codex --no-alt-screen --sandbox danger-full-access -a never'),
  ),
  groupRequireCommand: boolEnv('FTB_GROUP_REQUIRE_COMMAND', true),
  maxWaitMs: intEnv('FTB_MAX_WAIT_MS', 90_000),
  stableMs: intEnv('FTB_STABLE_MS', 3_500),
  pollMs: intEnv('FTB_POLL_MS', 1_000),
  captureLines: intEnv('FTB_CAPTURE_LINES', 1_200),
  replyMaxChars: intEnv('FTB_REPLY_MAX_CHARS', 3_500),
  restartDelayMs: intEnv('FTB_RESTART_DELAY_MS', 3_000),
  idleStopMs: intEnv('FTB_IDLE_STOP_MS', 0),
};

let state = loadState();
let queue = Promise.resolve();
let shuttingDown = false;

log(`starting router`, { root: ROOT, home: HOME_DIR });
if (cfg.idleStopMs > 0) {
  setInterval(stopIdleSessions, Math.min(cfg.idleStopMs, 60_000)).unref?.();
}
startEventConsumer();

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value.replace(/\\"/g, '"');
  }
}

function env(name, fallback) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function csvEnv(name, fallback = '') {
  return env(name, fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function intEnv(name, fallback) {
  const value = Number.parseInt(env(name, String(fallback)), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function loadState() {
  const sessions = readJson(SESSIONS_PATH, null) || defaultSessions();
  const routes = readJson(ROUTES_PATH, null) || defaultRoutes();
  const userContext = readJson(USER_CONTEXT_PATH, {});
  const seen = readJson(SEEN_PATH, []);
  writeJson(SESSIONS_PATH, sessions);
  writeJson(ROUTES_PATH, routes);
  writeJson(USER_CONTEXT_PATH, userContext);
  writeJson(SEEN_PATH, seen);
  return { sessions, routes, userContext, seen };
}

function reloadState() {
  state = loadState();
}

function defaultSessions() {
  return {
    [cfg.defaultSession]: {
      backend: 'tmux',
      agent: cfg.defaultAgent,
      tmuxSession: cfg.defaultTmuxSession,
      cwd: cfg.defaultWorkdir,
      command: cfg.defaultCommand,
      state: 'stopped',
      createdAt: now(),
      updatedAt: now(),
    },
  };
}

function defaultRoutes() {
  return { chats: {}, threads: {}, users: {} };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function appendJsonl(file, value) {
  fs.appendFileSync(file, `${JSON.stringify({ ts: now(), ...value })}\n`);
}

function now() {
  return new Date().toISOString();
}

function log(message, extra) {
  const line = `[${now()}] ${message}${extra ? ` ${JSON.stringify(extra)}` : ''}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, `${line}\n`);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    cwd: opts.cwd || cfg.defaultWorkdir,
    input: opts.input,
    maxBuffer: opts.maxBuffer || 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function startEventConsumer() {
  const args = [
    'event',
    'consume',
    'im.message.receive_v1',
    '--as',
    cfg.larkAs,
    '--jq',
    '{event_id,message_id,id,chat_id,chat_type,sender_id,message_type,content,create_time,timestamp,thread_id}',
  ];
  log(`spawning lark event consumer`, { args: args.join(' ') });
  const child = spawn('lark-cli', args, {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.write('\n');

  readline.createInterface({ input: child.stderr, crlfDelay: Infinity })
    .on('line', (line) => log(`[event stderr] ${line}`));

  readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
    .on('line', (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        log(`skipping non-json event line`, { line, error: String(error) });
        return;
      }
      queue = queue
        .then(() => handleEvent(event))
        .catch((error) => log(`event handling failed`, { error: stackOf(error) }));
    });

  child.on('exit', (code, signal) => {
    log(`event consumer exited`, { code, signal });
    if (!shuttingDown) {
      setTimeout(startEventConsumer, cfg.restartDelayMs);
    }
  });
}

async function handleEvent(event) {
  reloadState();
  const messageId = event.message_id || event.id;
  const dedupKey = event.event_id || messageId;
  if (!messageId || !dedupKey) return;
  if (state.seen.includes(dedupKey)) {
    log(`dedup skip`, { messageId });
    return;
  }
  state.seen.push(dedupKey);
  state.seen = state.seen.slice(-1000);
  writeJson(SEEN_PATH, state.seen);

  if (!isAllowed(event)) {
    log(`ignored event by policy`, {
      messageId,
      sender: shortId(event.sender_id),
      chat: shortId(event.chat_id),
    });
    return;
  }

  const content = String(event.content || '').trim();
  audit('inbound', event, { content: content.slice(0, 500), messageType: event.message_type });
  log(`received message`, {
    messageId,
    sender: shortId(event.sender_id),
    chat: shortId(event.chat_id),
    type: event.message_type,
    content: content.slice(0, 80),
  });

  if (!content) {
    await reply(messageId, '收到空消息，已忽略。');
    return;
  }

  if (isCommand(content)) {
    await handleCommand(event, content);
    return;
  }

  if (shouldIgnorePlainMessage(event)) {
    log(`ignored plain group message`, { messageId, chat: shortId(event.chat_id) });
    return;
  }

  await sendToResolvedSession(event, content, { saveInbox: event.message_type !== 'text' });
}

function isAllowed(event) {
  if (cfg.allowedSenders.length && !cfg.allowedSenders.includes(event.sender_id)) return false;
  if (cfg.allowedChats.length && !cfg.allowedChats.includes(event.chat_id)) return false;
  return true;
}

function isAdmin(event) {
  if (!cfg.adminUsers.length) return true;
  return cfg.adminUsers.includes(event.sender_id);
}

function isCommand(content) {
  return content.startsWith('/');
}

function shouldIgnorePlainMessage(event) {
  return cfg.groupRequireCommand && event.chat_type === 'group';
}

async function handleCommand(event, content) {
  const messageId = event.message_id || event.id;
  const tokens = shellWords(content);
  const cmd = (tokens.shift() || '').toLowerCase();
  try {
    switch (cmd) {
      case '/help':
        await reply(messageId, helpText());
        break;
      case '/ping':
        await reply(messageId, 'pong');
        break;
      case '/sessions':
        await reply(messageId, sessionsText());
        break;
      case '/routes':
        await reply(messageId, routesText());
        break;
      case '/whereami':
        await reply(messageId, whereamiText(event));
        break;
      case '/use':
        await cmdUse(event, tokens);
        break;
      case '/bind':
        requireAdmin(event);
        await cmdBind(event, tokens);
        break;
      case '/unbind':
        requireAdmin(event);
        await cmdUnbind(event);
        break;
      case '/send':
        await cmdSend(event, tokens);
        break;
      case '/capture':
        await cmdCapture(event, tokens);
        break;
      case '/status':
        await cmdStatus(event, tokens);
        break;
      case '/interrupt':
        await cmdInterrupt(event, tokens);
        break;
      case '/new':
        requireAdmin(event);
        await cmdNew(event, tokens);
        break;
      case '/stop':
        requireAdmin(event);
        await cmdStop(event, tokens);
        break;
      case '/restart':
      case '/reset':
        requireAdmin(event);
        await cmdRestart(event, tokens);
        break;
      case '/file':
        await cmdFile(event, tokens);
        break;
      default:
        await reply(messageId, `未知命令：${cmd}\n\n${helpText()}`);
    }
  } catch (error) {
    await reply(messageId, `错误：${error.message || String(error)}`);
  }
}

function requireAdmin(event) {
  if (!isAdmin(event)) throw new Error('只有管理员可以执行这个命令。');
}

async function cmdUse(event, tokens) {
  const sessionName = tokens[0];
  if (!sessionName) throw new Error('用法：/use <session>');
  getSession(sessionName);
  state.userContext[event.sender_id] = {
    currentSession: sessionName,
    updatedAt: now(),
  };
  writeJson(USER_CONTEXT_PATH, state.userContext);
  await reply(event.message_id || event.id, `当前用户已切换到 session: ${sessionName}`);
}

async function cmdBind(event, tokens) {
  const sessionName = tokens[0];
  if (!sessionName) throw new Error('用法：/bind <session>');
  getSession(sessionName);
  if (event.thread_id) {
    state.routes.threads[event.thread_id] = { defaultSession: sessionName, updatedAt: now() };
  } else {
    state.routes.chats[event.chat_id] = { defaultSession: sessionName, updatedAt: now() };
  }
  writeJson(ROUTES_PATH, state.routes);
  await reply(event.message_id || event.id, `已绑定当前${event.thread_id ? '话题' : '会话'}到 session: ${sessionName}`);
}

async function cmdUnbind(event) {
  if (event.thread_id && state.routes.threads[event.thread_id]) {
    delete state.routes.threads[event.thread_id];
  } else if (event.chat_id && state.routes.chats[event.chat_id]) {
    delete state.routes.chats[event.chat_id];
  } else {
    throw new Error('当前会话没有绑定 route。');
  }
  writeJson(ROUTES_PATH, state.routes);
  await reply(event.message_id || event.id, '已解除当前会话/话题绑定。');
}

async function cmdSend(event, tokens) {
  const { sessionName, rest } = splitSessionArg(event, tokens);
  const text = rest.join(' ').trim();
  if (!text) throw new Error('用法：/send [session] <text>');
  await sendToSession(event, sessionName, text, { saveInbox: false });
}

async function cmdCapture(event, tokens) {
  const sessionName = tokens[0] || resolveSessionName(event);
  const backend = backendFor(getSession(sessionName));
  await reply(event.message_id || event.id, trimReply(backend.capture(sessionName)));
}

async function cmdStatus(event, tokens) {
  const sessionName = tokens[0] || resolveSessionName(event);
  const session = getSession(sessionName);
  const backend = backendFor(session);
  await reply(event.message_id || event.id, backend.status(sessionName));
}

async function cmdInterrupt(event, tokens) {
  const sessionName = tokens[0] || resolveSessionName(event);
  const backend = backendFor(getSession(sessionName));
  backend.interrupt(sessionName);
  await reply(event.message_id || event.id, `已中断 session: ${sessionName}`);
}

async function cmdNew(event, tokens) {
  const name = tokens.shift();
  if (!name) throw new Error('用法：/new <name> [--agent codex] [--cwd path] [--cmd command]');
  if (state.sessions[name]) throw new Error(`session 已存在：${name}`);

  const opts = parseOptions(tokens);
  const agent = opts.agent || 'codex';
  const cwd = opts.cwd || cfg.defaultWorkdir;
  const command = opts.cmd || defaultCommandForAgent(agent, cwd);
  state.sessions[name] = {
    backend: opts.backend || 'tmux',
    agent,
    tmuxSession: opts.tmux || `far-${name}`,
    cwd,
    command,
    state: 'stopped',
    createdAt: now(),
    updatedAt: now(),
  };
  writeJson(SESSIONS_PATH, state.sessions);
  backendFor(state.sessions[name]).ensure(name);
  await reply(event.message_id || event.id, `已创建并启动 session: ${name}\nagent: ${agent}\ncwd: ${cwd}`);
}

async function cmdStop(event, tokens) {
  const sessionName = tokens[0] || resolveSessionName(event);
  const backend = backendFor(getSession(sessionName));
  backend.stop(sessionName);
  await reply(event.message_id || event.id, `已停止 session: ${sessionName}`);
}

async function cmdRestart(event, tokens) {
  const sessionName = tokens[0] || resolveSessionName(event);
  const backend = backendFor(getSession(sessionName));
  backend.restart(sessionName);
  await reply(event.message_id || event.id, `已重启 session: ${sessionName}`);
}

async function cmdFile(event, tokens) {
  const { sessionName, rest } = splitSessionArg(event, tokens);
  const note = rest.join(' ').trim();
  const inbox = createInboxEntry(event);
  const prompt = [
    '飞书消息材料已保存到本地 inbox。',
    `目录：${inbox.dir}`,
    note ? `用户说明：${note}` : '',
    '请读取该目录下的 content.md、message.json、manifest.json 和 attachments/ 后处理。',
  ].filter(Boolean).join('\n');
  await sendToSession(event, sessionName, prompt, { saveInbox: false });
}

function splitSessionArg(event, tokens) {
  if (tokens[0] && state.sessions[tokens[0]]) {
    return { sessionName: tokens[0], rest: tokens.slice(1) };
  }
  return { sessionName: resolveSessionName(event), rest: tokens };
}

async function sendToResolvedSession(event, content, opts = {}) {
  return sendToSession(event, resolveSessionName(event), content, opts);
}

async function sendToSession(event, sessionName, content, opts = {}) {
  const session = getSession(sessionName);
  const backend = backendFor(session);
  backend.ensure(sessionName);
  const inbox = opts.saveInbox ? createInboxEntry(event) : null;
  const prompt = buildPrompt(event, content, sessionName, inbox?.dir);
  const before = backend.capture(sessionName);
  backend.send(sessionName, prompt);
  const { output, elapsedMs, stable } = await backend.waitForOutput(sessionName, before);
  const text = output.trim()
    ? `session: ${sessionName}\n用时 ${(elapsedMs / 1000).toFixed(1)}s\n\n${trimReply(output)}`
    : `已投递到 ${sessionName}，但 ${Math.round(cfg.maxWaitMs / 1000)}s 内没有捕获到新输出。`;
  await reply(event.message_id || event.id, stable ? text : `${text}\n\n[提示] 输出可能还没完全结束，可发 /capture ${sessionName} 查看。`);
}

function resolveSessionName(event) {
  const threadRoute = event.thread_id && state.routes.threads[event.thread_id]?.defaultSession;
  const chatRoute = event.chat_id && state.routes.chats[event.chat_id]?.defaultSession;
  const userRoute = event.sender_id && state.routes.users[event.sender_id]?.defaultSession;
  const userCurrent = event.sender_id && state.userContext[event.sender_id]?.currentSession;
  return threadRoute || userCurrent || chatRoute || userRoute || cfg.defaultSession;
}

function getSession(name) {
  const session = state.sessions[name];
  if (!session) throw new Error(`找不到 session：${name}`);
  return session;
}

function backendFor(session) {
  if (session.backend === 'tmux') return tmuxBackend;
  throw new Error(`不支持的 backend：${session.backend}`);
}

const tmuxBackend = {
  ensure(name) {
    const session = getSession(name);
    if (hasTmuxSession(session.tmuxSession)) {
      updateSessionState(name, 'running');
      return;
    }
    log(`creating tmux session`, { name, tmuxSession: session.tmuxSession, cwd: session.cwd });
    run('tmux', ['new-session', '-d', '-s', session.tmuxSession, '-c', session.cwd, 'sh', '-lc', session.command]);
    updateSessionState(name, 'running');
  },
  send(name, text) {
    const session = getSession(name);
    run('tmux', ['load-buffer', '-b', 'feishu-agent-router', '-'], { input: text });
    run('tmux', ['paste-buffer', '-b', 'feishu-agent-router', '-t', session.tmuxSession]);
    sleepSync(250);
    run('tmux', ['send-keys', '-t', session.tmuxSession, 'Enter']);
  },
  capture(name) {
    const session = getSession(name);
    if (!hasTmuxSession(session.tmuxSession)) return `[session stopped] ${name}`;
    return run('tmux', ['capture-pane', '-t', session.tmuxSession, '-p', '-S', `-${cfg.captureLines}`]);
  },
  status(name) {
    const session = getSession(name);
    const running = hasTmuxSession(session.tmuxSession);
    return [
      `session: ${name}`,
      `backend: ${session.backend}`,
      `agent: ${session.agent}`,
      `tmux: ${session.tmuxSession} ${running ? 'running' : 'stopped'}`,
      `cwd: ${session.cwd}`,
      `command: ${session.command}`,
      `updated: ${session.updatedAt || '-'}`,
    ].join('\n');
  },
  interrupt(name) {
    const session = getSession(name);
    if (hasTmuxSession(session.tmuxSession)) {
      run('tmux', ['send-keys', '-t', session.tmuxSession, 'C-c']);
    }
  },
  stop(name) {
    const session = getSession(name);
    spawnSync('tmux', ['kill-session', '-t', session.tmuxSession], { encoding: 'utf8' });
    updateSessionState(name, 'stopped');
  },
  restart(name) {
    this.stop(name);
    this.ensure(name);
  },
  async waitForOutput(name, before) {
    const start = Date.now();
    let last = this.capture(name);
    let lastChangedAt = Date.now();
    let sawChange = false;

    while (Date.now() - start < cfg.maxWaitMs) {
      await sleep(cfg.pollMs);
      const current = this.capture(name);
      if (current !== last) {
        last = current;
        lastChangedAt = Date.now();
        sawChange = current !== before;
        continue;
      }
      if (sawChange && hasAssistantOutput(before, current) && Date.now() - lastChangedAt >= cfg.stableMs) {
        return { output: assistantOutput(before, current), elapsedMs: Date.now() - start, stable: true };
      }
    }

    const current = this.capture(name);
    return {
      output: assistantOutput(before, current) || diffText(before, current),
      elapsedMs: Date.now() - start,
      stable: false,
    };
  },
};

function updateSessionState(name, value) {
  state.sessions[name].state = value;
  state.sessions[name].updatedAt = now();
  writeJson(SESSIONS_PATH, state.sessions);
}

function stopIdleSessions() {
  reloadState();
  const cutoff = Date.now() - cfg.idleStopMs;
  for (const [name, session] of Object.entries(state.sessions)) {
    if (!session.idleStop) continue;
    if (session.state !== 'running') continue;
    const updated = Date.parse(session.updatedAt || session.createdAt || 0);
    if (!Number.isFinite(updated) || updated >= cutoff) continue;
    try {
      backendFor(session).stop(name);
      log(`idle-stopped session`, { name });
    } catch (error) {
      log(`idle stop failed`, { name, error: stackOf(error) });
    }
  }
}

function hasTmuxSession(tmuxSession) {
  return spawnSync('tmux', ['has-session', '-t', tmuxSession], { encoding: 'utf8' }).status === 0;
}

function buildPrompt(event, content, sessionName, inboxDir) {
  const lines = [
    `飞书远程消息。session=${sessionName}`,
    `sender=${event.sender_id || ''}`,
    `chat=${event.chat_id || ''}`,
    inboxDir ? `inbox=${inboxDir}` : '',
    '',
    String(content).trim(),
  ].filter((line) => line !== '');
  return lines.join(' | ');
}

function createInboxEntry(event) {
  const messageId = event.message_id || event.id || `event-${Date.now()}`;
  const date = new Date().toISOString().slice(0, 10);
  const dir = path.join(INBOX_DIR, date, messageId);
  const attachmentsDir = path.join(dir, 'attachments');
  fs.mkdirSync(attachmentsDir, { recursive: true });
  writeJson(path.join(dir, 'message.json'), event);
  fs.writeFileSync(path.join(dir, 'content.md'), String(event.content || '').trim() + '\n');

  const manifest = {
    messageId,
    chatId: event.chat_id,
    senderId: event.sender_id,
    messageType: event.message_type,
    createdAt: now(),
    attachments: [],
    downloadErrors: [],
  };

  for (const type of ['image', 'file']) {
    const result = spawnSync(
      'lark-cli',
      ['im', '+messages-resources-download', '--as', cfg.larkAs, '--message-id', messageId, '--type', type],
      { cwd: attachmentsDir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    if (result.status === 0) {
      manifest.attachments.push({ type, stdout: result.stdout.trim() });
    } else {
      manifest.downloadErrors.push({ type, stderr: result.stderr.trim(), stdout: result.stdout.trim() });
    }
  }

  writeJson(path.join(dir, 'manifest.json'), manifest);
  return { dir, manifest };
}

async function reply(messageId, text) {
  const result = spawnSync(
    'lark-cli',
    ['im', '+messages-reply', '--as', cfg.larkAs, '--message-id', messageId, '--text', trimReply(text)],
    { encoding: 'utf8', cwd: ROOT, maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    log(`reply failed`, { messageId, stderr: result.stderr.trim(), stdout: result.stdout.trim() });
    audit('reply_failed', { message_id: messageId }, { stderr: result.stderr.trim(), stdout: result.stdout.trim() });
    return;
  }
  log(`replied`, { messageId });
  audit('outbound', { message_id: messageId }, { text: trimReply(text).slice(0, 500) });
}

function audit(direction, event, extra = {}) {
  appendJsonl(AUDIT_PATH, {
    direction,
    messageId: event.message_id || event.id || '',
    chatId: event.chat_id || '',
    senderId: event.sender_id || '',
    ...extra,
  });
}

function sessionsText() {
  return Object.entries(state.sessions).map(([name, session]) => {
    const running = session.backend === 'tmux' && hasTmuxSession(session.tmuxSession);
    return `${name}: ${session.agent}/${session.backend} ${running ? 'running' : 'stopped'} cwd=${session.cwd}`;
  }).join('\n') || '(no sessions)';
}

function routesText() {
  return JSON.stringify(state.routes, null, 2);
}

function whereamiText(event) {
  return [
    `chat: ${event.chat_id || '-'}`,
    `thread: ${event.thread_id || '-'}`,
    `sender: ${event.sender_id || '-'}`,
    `resolved session: ${resolveSessionName(event)}`,
  ].join('\n');
}

function helpText() {
  return [
    '/ping',
    '/sessions',
    '/routes',
    '/whereami',
    '/bind <session>',
    '/unbind',
    '/use <session>',
    '/send [session] <text>',
    '/capture [session]',
    '/status [session]',
    '/interrupt [session]',
    '/new <name> [--agent codex|claude|gemini|script] [--cwd path] [--cmd command]',
    '/stop [session]',
    '/restart [session]',
    '/file [session] [note]',
  ].join('\n');
}

function parseOptions(tokens) {
  const opts = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--agent') opts.agent = tokens[++i];
    else if (token === '--backend') opts.backend = tokens[++i];
    else if (token === '--cwd') opts.cwd = tokens[++i];
    else if (token === '--tmux') opts.tmux = tokens[++i];
    else if (token === '--cmd') {
      opts.cmd = tokens.slice(i + 1).join(' ');
      break;
    }
  }
  return opts;
}

function defaultCommandForAgent(agent, cwd) {
  switch (agent) {
    case 'codex':
      return `codex --no-alt-screen --cd ${shellQuote(cwd)} --sandbox danger-full-access -a never`;
    case 'claude':
      return 'claude';
    case 'gemini':
      return 'gemini';
    default:
      return agent;
  }
}

function shellWords(input) {
  const out = [];
  let cur = '';
  let quote = null;
  let esc = false;
  for (const ch of input) {
    if (esc) {
      cur += ch;
      esc = false;
      continue;
    }
    if (ch === '\\') {
      esc = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function hasAssistantOutput(before, after) {
  return Boolean(assistantOutput(before, after));
}

function assistantOutput(before, after) {
  const lines = String(after || '').split('\n');
  const promptStart = findLastIndex(lines, (line) => line.trim().startsWith('› 飞书远程消息'));
  const searchFrom = promptStart >= 0 ? promptStart + 1 : 0;
  const start = lines.findIndex((line, index) => index >= searchFrom && line.trim().startsWith('• '));
  if (start < 0) return '';
  const kept = [];
  for (const line of lines.slice(start)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('› ')) break;
    if (trimmed.includes('esc to interrupt')) continue;
    if (trimmed.includes('tab to queue message')) continue;
    kept.push(kept.length === 0 ? line.replace(/^(\s*)•\s?/, '$1') : line);
  }
  return kept.join('\n').trim();
}

function findLastIndex(items, predicate) {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index], index)) return index;
  }
  return -1;
}

function diffText(before, after) {
  if (after.startsWith(before)) return after.slice(before.length);
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  let overlap = Math.min(beforeLines.length, afterLines.length);
  while (overlap > 0) {
    const a = beforeLines.slice(beforeLines.length - overlap).join('\n');
    const b = afterLines.slice(0, overlap).join('\n');
    if (a === b) break;
    overlap--;
  }
  return afterLines.slice(overlap).join('\n');
}

function trimReply(text) {
  const compact = String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''))
    .join('\n')
    .trim();
  if (compact.length <= cfg.replyMaxChars) return compact || '(empty)';
  return `${compact.slice(0, cfg.replyMaxChars)}\n\n... [truncated]`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function shortId(value) {
  if (!value) return '';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function stackOf(error) {
  return error?.stack || error?.message || String(error);
}

function shutdown() {
  shuttingDown = true;
  log('shutting down');
  process.exit(0);
}
