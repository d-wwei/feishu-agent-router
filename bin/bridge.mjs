#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  createInboxEntryLike,
  normalizeInboundEvent,
} from '../lib/feishu-ingest.mjs';
import {
  buildFinalCardContent,
  buildMessageContent,
  buildStreamingCardContent,
} from '../lib/feishu-render.mjs';
import {
  buildReactionCreateArgv,
  pickPhase1Emoji,
  pickPhase2Emojis,
} from '../lib/feishu-interactions.mjs';

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
  defaultBackend: env('FTB_DEFAULT_BACKEND', 'codex-app-server'),
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
  codexPath: env('FTB_CODEX_PATH', 'codex'),
  codexAppServerPort: optionalIntEnv('FTB_CODEX_APP_SERVER_PORT'),
  codexRequestTimeoutMs: intEnv('FTB_CODEX_REQUEST_TIMEOUT_MS', 120_000),
  codexStartTimeoutMs: intEnv('FTB_CODEX_START_TIMEOUT_MS', 8_000),
  codexModel: env('FTB_CODEX_MODEL', ''),
  codexReasoningEffort: env('FTB_CODEX_REASONING_EFFORT', 'medium'),
  codexSandbox: env('FTB_CODEX_SANDBOX', 'danger-full-access'),
  codexApprovalPolicy: env('FTB_CODEX_APPROVAL_POLICY', 'never'),
  codexNetworkAccess: boolEnv('FTB_CODEX_NETWORK_ACCESS', true),
  codexAutoApproveRequests: boolEnv('FTB_CODEX_AUTO_APPROVE_REQUESTS', true),
  feishuRichReplies: boolEnv('FTB_FEISHU_RICH_REPLIES', true),
  feishuReactions: boolEnv('FTB_FEISHU_REACTIONS', true),
  feishuStreaming: boolEnv('FTB_FEISHU_STREAMING', true),
  feishuStreamPatchMs: intEnv('FTB_FEISHU_STREAM_PATCH_MS', 2_000),
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

function optionalIntEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
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
      backend: cfg.defaultBackend,
      agent: cfg.defaultAgent,
      threadId: null,
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
  const normalized = normalizeInboundEvent(event);
  const messageId = normalized.messageId || event.message_id || event.id;
  const dedupKey = normalized.eventId || event.event_id || messageId;
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

  const content = normalized.text || String(event.content || '').trim();
  audit('inbound', event, {
    content: content.slice(0, 500),
    messageType: normalized.messageType,
    downloadPlans: normalized.downloadPlans.length,
    mergeForward: normalized.mergeForward?.status || '',
  });
  log(`received message`, {
    messageId,
    sender: shortId(event.sender_id),
    chat: shortId(event.chat_id),
    type: normalized.messageType,
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

  await sendToResolvedSession(event, content, {
    normalized,
    saveInbox: shouldSaveInbox(normalized),
  });
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

function shouldSaveInbox(normalized) {
  if (!normalized) return false;
  if (normalized.messageType !== 'text') return true;
  if (normalized.downloadPlans.length > 0) return true;
  if (normalized.mergeForward) return true;
  return false;
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
  await reply(event.message_id || event.id, trimReply(await backend.capture(sessionName)));
}

async function cmdStatus(event, tokens) {
  const sessionName = tokens[0] || resolveSessionName(event);
  const session = getSession(sessionName);
  const backend = backendFor(session);
  await reply(event.message_id || event.id, await backend.status(sessionName));
}

async function cmdInterrupt(event, tokens) {
  const sessionName = tokens[0] || resolveSessionName(event);
  const backend = backendFor(getSession(sessionName));
  await backend.interrupt(sessionName);
  await reply(event.message_id || event.id, `已中断 session: ${sessionName}`);
}

async function cmdNew(event, tokens) {
  const name = tokens.shift();
  if (!name) throw new Error('用法：/new <name> [--backend codex-app-server|tmux] [--agent codex] [--cwd path] [--cmd command]');
  if (state.sessions[name]) throw new Error(`session 已存在：${name}`);

  const opts = parseOptions(tokens);
  const agent = opts.agent || 'codex';
  const backend = opts.backend || (agent === 'codex' ? cfg.defaultBackend : 'tmux');
  const cwd = opts.cwd || cfg.defaultWorkdir;
  const command = opts.cmd || defaultCommandForAgent(agent, cwd);
  state.sessions[name] = {
    backend,
    agent,
    threadId: null,
    tmuxSession: opts.tmux || `far-${name}`,
    cwd,
    command,
    state: 'stopped',
    createdAt: now(),
    updatedAt: now(),
  };
  writeJson(SESSIONS_PATH, state.sessions);
  await backendFor(state.sessions[name]).ensure(name);
  await reply(event.message_id || event.id, `已创建并启动 session: ${name}\nbackend: ${backend}\nagent: ${agent}\ncwd: ${cwd}`);
}

async function cmdStop(event, tokens) {
  const sessionName = tokens[0] || resolveSessionName(event);
  const backend = backendFor(getSession(sessionName));
  await backend.stop(sessionName);
  await reply(event.message_id || event.id, `已停止 session: ${sessionName}`);
}

async function cmdRestart(event, tokens) {
  const sessionName = tokens[0] || resolveSessionName(event);
  const backend = backendFor(getSession(sessionName));
  await backend.restart(sessionName);
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
  const inbox = opts.saveInbox ? createInboxEntry(event, opts.normalized) : null;
  const prompt = buildPrompt(event, content, sessionName, inbox?.dir);
  await maybeReactPhase1(event, content);
  const stream = cfg.feishuStreaming ? startStreamingReply(event.message_id || event.id) : null;
  const result = await runSessionWithFallback(sessionName, backend, prompt, {
    onDelta: (deltaText) => stream?.update(deltaText),
  });
  const { output, elapsedMs, stable, backendName, fallbackReason } = result;
  log('session turn completed', { sessionName, backend: backendName, elapsedMs, stable, fallback: Boolean(fallbackReason) });
  const text = output.trim()
    ? formatSessionReply(output, result)
    : `已投递到 ${sessionName}，但 ${Math.round(cfg.maxWaitMs / 1000)}s 内没有捕获到新输出。`;
  const finalText = stable ? text : `${text}\n\n[提示] 输出可能还没完全结束，可发 /capture ${sessionName} 查看。`;
  const streamDelivered = stream?.finish(finalText) || false;
  if (!streamDelivered) await reply(event.message_id || event.id, finalText);
  await maybeReactPhase2(event, content, text);
}

function formatSessionReply(output, result) {
  const body = trimReply(output);
  if (!result.fallbackReason) return body;
  return [
    body,
    '',
    `[fallback: ${result.backendName}; ${(result.elapsedMs / 1000).toFixed(1)}s]`,
    result.fallbackReason,
  ].join('\n');
}

async function runSessionWithFallback(sessionName, backend, prompt, opts = {}) {
  try {
    return await backend.run(sessionName, prompt, opts);
  } catch (error) {
    const session = getSession(sessionName);
    if (session.backend !== 'codex-app-server' || session.fallback === false) throw error;
    log('codex app-server failed; falling back to tmux', { sessionName, error: error.message || String(error) });
    const result = await tmuxBackend.run(sessionName, prompt, opts);
    return {
      ...result,
      backendName: 'tmux',
      fallbackReason: error.message || String(error),
    };
  }
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

async function ensureCodexThread(name) {
  await codexAppServer.ensureReady();
  const session = getSession(name);
  if (session.threadId && codexAppServer.hasThread(session.threadId)) return session.threadId;

  if (session.threadId) {
    try {
      await codexAppServer.threadResume({
        threadId: session.threadId,
        cwd: session.cwd || cfg.defaultWorkdir,
        approvalPolicy: cfg.codexApprovalPolicy,
        sandbox: cfg.codexSandbox,
        config: codexConfig(),
        ...(cfg.codexModel ? { model: cfg.codexModel } : {}),
      });
      return session.threadId;
    } catch (error) {
      log('codex thread resume failed; starting a new thread', {
        sessionName: name,
        threadId: session.threadId,
        error: error.message || String(error),
      });
    }
  }

  const result = await codexAppServer.threadStart({
    cwd: session.cwd || cfg.defaultWorkdir,
    approvalPolicy: cfg.codexApprovalPolicy,
    sandbox: cfg.codexSandbox,
    config: codexConfig(),
    ...(cfg.codexModel ? { model: cfg.codexModel } : {}),
  });
  const threadId = result.thread.id;
  updateSessionFields(name, { threadId, updatedAt: now() });
  return threadId;
}

function codexConfig() {
  return {
    sandbox_workspace_write: {
      network_access: Boolean(cfg.codexNetworkAccess),
    },
  };
}

class CodexAppServerClient {
  constructor() {
    this.requestId = 0;
    this.pending = new Map();
    this.turns = new Map();
    this.liveThreads = new Set();
    this.child = null;
    this.ws = null;
    this.ready = null;
    this.port = null;
  }

  async ensureReady() {
    if (this.ready) return this.ready;
    this.ready = this.start();
    return this.ready;
  }

  async start() {
    if (typeof WebSocket !== 'function') {
      throw new Error('当前 Node.js 没有全局 WebSocket，无法使用 codex-app-server backend。');
    }
    this.port = cfg.codexAppServerPort || await allocatePort();
    const listenUrl = `ws://127.0.0.1:${this.port}`;
    log('starting codex app-server', { listenUrl });
    this.child = spawn(cfg.codexPath, ['app-server', '--listen', listenUrl], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stdout?.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) log(`[codex app-server] ${text}`);
    });
    this.child.stderr?.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) log(`[codex app-server] ${text}`);
    });
    this.child.once('exit', (code, signal) => {
      log('codex app-server exited', { code, signal });
      this.rejectAll(new Error(`Codex app-server exited: ${signal || code}`));
      this.ws = null;
      this.ready = null;
      this.liveThreads.clear();
    });

    await waitForWebSocket(listenUrl, cfg.codexStartTimeoutMs);
    this.ws = new WebSocket(listenUrl);
    this.ws.addEventListener('message', (event) => this.handleMessage(event.data));
    this.ws.addEventListener('close', () => {
      this.rejectAll(new Error('Codex app-server websocket closed'));
      this.ws = null;
      this.ready = null;
      this.liveThreads.clear();
    });
    this.ws.addEventListener('error', () => log('codex app-server websocket error'));
    await waitForWebSocketOpen(this.ws, cfg.codexStartTimeoutMs);

    await this.request('initialize', {
      clientInfo: { name: 'feishu-agent-router', title: 'Feishu Agent Router', version: '0.1.0' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: null,
      },
    });
    this.notify('initialized');
  }

  hasThread(threadId) {
    return Boolean(threadId && this.liveThreads.has(threadId));
  }

  async threadStart(params) {
    const result = await this.request('thread/start', params);
    if (result.thread?.id) this.liveThreads.add(result.thread.id);
    return result;
  }

  async threadResume(params) {
    const result = await this.request('thread/resume', params);
    this.liveThreads.add(params.threadId);
    return result;
  }

  async turnStart(params, opts = {}) {
    const result = await this.request('turn/start', params);
    const turnId = result.turn.id;
    return new Promise((resolve, reject) => {
      this.turns.set(turnId, {
        threadId: params.threadId,
        text: '',
        final: '',
        lastError: null,
        onDelta: opts.onDelta,
        resolve,
        reject,
      });
      setTimeout(() => {
        const turn = this.turns.get(turnId);
        if (!turn) return;
        this.turns.delete(turnId);
        reject(new Error('Timed out waiting for turn/completed'));
      }, cfg.codexRequestTimeoutMs);
    });
  }

  interruptThread(threadId) {
    if (!threadId) return;
    for (const [turnId, turn] of this.turns.entries()) {
      if (turn.threadId === threadId) {
        this.request('turn/interrupt', { threadId, turnId }).catch((error) => {
          log('codex turn interrupt failed', { error: error.message || String(error) });
        });
      }
    }
  }

  request(method, params) {
    const id = ++this.requestId;
    this.send({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, cfg.codexRequestTimeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
    });
  }

  notify(method, params) {
    this.send(params === undefined ? { method } : { method, params });
  }

  send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Codex app-server websocket is not open');
    }
    this.ws.send(JSON.stringify(payload));
  }

  handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      log('ignoring non-json codex app-server message', { raw: String(raw).slice(0, 200) });
      return;
    }

    if (msg.id && !msg.method) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else pending.resolve(msg.result);
      return;
    }

    if (msg.id && msg.method) {
      this.handleServerRequest(msg);
      return;
    }

    if (msg.method) this.handleNotification(msg);
  }

  handleNotification(msg) {
    if (msg.method === 'item/agentMessage/delta') {
      const turn = this.turns.get(msg.params.turnId);
      if (turn) {
        turn.text += msg.params.delta || '';
        if (typeof turn.onDelta === 'function') {
          try {
            turn.onDelta(turn.text);
          } catch (error) {
            log('delta observer failed', { error: error.message || String(error) });
          }
        }
      }
      return;
    }
    if (msg.method === 'item/completed') {
      const turn = this.turns.get(msg.params.turnId);
      if (turn && msg.params.item?.type === 'agentMessage') {
        turn.final = msg.params.item.text || turn.text;
      }
      return;
    }
    if (msg.method === 'error') {
      const turn = this.turns.get(msg.params.turnId);
      if (turn) turn.lastError = msg.params.error;
      if (!msg.params.willRetry) {
        log('codex turn error', { error: msg.params.error?.message || 'unknown error' });
      }
      return;
    }
    if (msg.method === 'turn/completed') {
      const turnId = msg.params.turn.id;
      const turn = this.turns.get(turnId);
      if (!turn) return;
      this.turns.delete(turnId);
      if (msg.params.turn.status === 'failed') {
        turn.reject(new Error(msg.params.turn.error?.message || turn.lastError?.message || 'Codex turn failed'));
      } else {
        turn.resolve(turn.final || turn.text || '');
      }
      return;
    }
    if (msg.method === 'warning') {
      log('codex warning', { message: msg.params.message || JSON.stringify(msg.params) });
    }
  }

  handleServerRequest(msg) {
    if (
      msg.method === 'item/commandExecution/requestApproval' ||
      msg.method === 'item/fileChange/requestApproval' ||
      msg.method === 'item/permissions/requestApproval'
    ) {
      this.send({ id: msg.id, result: { decision: cfg.codexAutoApproveRequests ? 'accept' : 'decline' } });
      return;
    }
    if (msg.method === 'item/tool/requestUserInput' || msg.method === 'mcpServer/elicitation/request') {
      this.send({ id: msg.id, result: { answers: {} } });
      return;
    }
    this.send({ id: msg.id, error: { code: -32000, message: `Unsupported app-server request ${msg.method}` } });
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const [turnId, turn] of this.turns.entries()) {
      turn.reject(error);
      this.turns.delete(turnId);
    }
  }

  statusText() {
    return this.ws?.readyState === WebSocket.OPEN ? `running ws://127.0.0.1:${this.port}` : 'stopped';
  }

  close() {
    try { this.ws?.close(); } catch {}
    try { this.child?.kill(); } catch {}
  }
}

function backendFor(session) {
  if (session.backend === 'codex-app-server') return codexAppServerBackend;
  if (session.backend === 'tmux') return tmuxBackend;
  throw new Error(`不支持的 backend：${session.backend}`);
}

const codexAppServer = new CodexAppServerClient();

const codexAppServerBackend = {
  async ensure(name) {
    await codexAppServer.ensureReady();
    updateSessionState(name, 'running');
  },
  async run(name, text, opts = {}) {
    const start = Date.now();
    const threadId = await ensureCodexThread(name);
    const output = await codexAppServer.turnStart({
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      cwd: getSession(name).cwd || cfg.defaultWorkdir,
      approvalPolicy: cfg.codexApprovalPolicy,
      ...(cfg.codexModel ? { model: cfg.codexModel } : {}),
      ...(cfg.codexReasoningEffort ? { effort: cfg.codexReasoningEffort } : {}),
    }, opts);
    updateSessionFields(name, {
      state: 'running',
      lastOutput: output,
      lastBackend: 'codex-app-server',
      updatedAt: now(),
    });
    return {
      output,
      elapsedMs: Date.now() - start,
      stable: true,
      backendName: 'codex-app-server',
    };
  },
  async capture(name) {
    const session = getSession(name);
    return [
      `session: ${name}`,
      `backend: codex-app-server`,
      `app-server: ${codexAppServer.statusText()}`,
      `thread: ${session.threadId || '(new)'}`,
      `cwd: ${session.cwd || cfg.defaultWorkdir}`,
      '',
      session.lastOutput || '(no last output)',
    ].join('\n');
  },
  async status(name) {
    const session = getSession(name);
    return [
      `session: ${name}`,
      `backend: codex-app-server`,
      `app-server: ${codexAppServer.statusText()}`,
      `thread: ${session.threadId || '(new)'}`,
      `cwd: ${session.cwd || cfg.defaultWorkdir}`,
      `model: ${cfg.codexModel || '(Codex default)'}`,
      `effort: ${cfg.codexReasoningEffort || '(default)'}`,
      `sandbox: ${cfg.codexSandbox}`,
      `approval: ${cfg.codexApprovalPolicy}`,
      `fallback tmux: ${session.tmuxSession || cfg.defaultTmuxSession}`,
      `updated: ${session.updatedAt || '-'}`,
    ].join('\n');
  },
  async interrupt(name) {
    codexAppServer.interruptThread(getSession(name).threadId);
  },
  async stop(name) {
    updateSessionFields(name, { state: 'stopped', updatedAt: now() });
  },
  async restart(name) {
    updateSessionFields(name, { threadId: null, state: 'stopped', updatedAt: now() });
    await this.ensure(name);
  },
};

const tmuxBackend = {
  async ensure(name) {
    const session = getSession(name);
    const tmuxSession = session.tmuxSession || cfg.defaultTmuxSession;
    const cwd = session.cwd || cfg.defaultWorkdir;
    const command = session.command || cfg.defaultCommand;
    if (hasTmuxSession(tmuxSession)) {
      updateSessionState(name, 'running');
      return;
    }
    log(`creating tmux session`, { name, tmuxSession, cwd });
    run('tmux', ['new-session', '-d', '-s', tmuxSession, '-c', cwd, 'sh', '-lc', command]);
    updateSessionState(name, 'running');
  },
  async run(name, text) {
    await this.ensure(name);
    const before = await this.capture(name);
    await this.send(name, text);
    const result = await this.waitForOutput(name, before);
    updateSessionFields(name, {
      state: 'running',
      lastOutput: result.output,
      lastBackend: 'tmux',
      updatedAt: now(),
    });
    return { ...result, backendName: 'tmux' };
  },
  async send(name, text) {
    const session = getSession(name);
    const tmuxSession = session.tmuxSession || cfg.defaultTmuxSession;
    run('tmux', ['load-buffer', '-b', 'feishu-agent-router', '-'], { input: text });
    run('tmux', ['paste-buffer', '-b', 'feishu-agent-router', '-t', tmuxSession]);
    sleepSync(250);
    run('tmux', ['send-keys', '-t', tmuxSession, 'Enter']);
  },
  async capture(name) {
    const session = getSession(name);
    const tmuxSession = session.tmuxSession || cfg.defaultTmuxSession;
    if (!hasTmuxSession(tmuxSession)) return `[session stopped] ${name}`;
    return run('tmux', ['capture-pane', '-t', tmuxSession, '-p', '-S', `-${cfg.captureLines}`]);
  },
  async status(name) {
    const session = getSession(name);
    const tmuxSession = session.tmuxSession || cfg.defaultTmuxSession;
    const running = hasTmuxSession(tmuxSession);
    return [
      `session: ${name}`,
      `backend: ${session.backend}`,
      `agent: ${session.agent}`,
      `tmux: ${tmuxSession} ${running ? 'running' : 'stopped'}`,
      `cwd: ${session.cwd || cfg.defaultWorkdir}`,
      `command: ${session.command || cfg.defaultCommand}`,
      `updated: ${session.updatedAt || '-'}`,
    ].join('\n');
  },
  async interrupt(name) {
    const session = getSession(name);
    const tmuxSession = session.tmuxSession || cfg.defaultTmuxSession;
    if (hasTmuxSession(tmuxSession)) {
      run('tmux', ['send-keys', '-t', tmuxSession, 'C-c']);
    }
  },
  async stop(name) {
    const session = getSession(name);
    spawnSync('tmux', ['kill-session', '-t', session.tmuxSession || cfg.defaultTmuxSession], { encoding: 'utf8' });
    updateSessionState(name, 'stopped');
  },
  async restart(name) {
    await this.stop(name);
    await this.ensure(name);
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

function updateSessionFields(name, fields) {
  state.sessions[name] = {
    ...state.sessions[name],
    ...fields,
  };
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
      Promise.resolve(backendFor(session).stop(name)).catch((error) => {
        log(`idle stop failed`, { name, error: stackOf(error) });
      });
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

function createInboxEntry(event, normalized) {
  const entry = createInboxEntryLike(event, {
    inboxRoot: INBOX_DIR,
    larkAs: cfg.larkAs,
    download: true,
  });
  const effective = normalized || entry.normalized;
  const manifest = {
    ...entry.manifest,
    attachments: entry.manifest.downloads || [],
    genericDownloadFallbacks: [],
  };

  if (needsGenericDownloadFallback(effective, manifest)) {
    for (const type of genericResourceTypes(effective.messageType)) {
      const result = spawnSync(
        'lark-cli',
        ['im', '+messages-resources-download', '--as', cfg.larkAs, '--message-id', effective.messageId, '--type', type],
        { cwd: entry.attachmentsDir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      );
      const record = { type, stdout: result.stdout.trim(), stderr: result.stderr.trim(), status: result.status };
      if (result.status === 0) manifest.genericDownloadFallbacks.push(record);
      else manifest.downloadErrors.push(record);
    }
  }

  writeJson(path.join(entry.dir, 'manifest.json'), manifest);
  return { ...entry, manifest };
}

function needsGenericDownloadFallback(normalized, manifest) {
  if (!normalized?.messageId) return false;
  if (!['image', 'file', 'video'].includes(normalized.messageType)) return false;
  return (manifest.downloads?.length || 0) === 0 && (manifest.genericDownloadFallbacks?.length || 0) === 0;
}

function genericResourceTypes(messageType) {
  if (messageType === 'image') return ['image'];
  if (messageType === 'file' || messageType === 'video') return ['file'];
  return [];
}

async function maybeReactPhase1(event, content) {
  if (!cfg.feishuReactions) return;
  const emojiType = pickPhase1Emoji(content);
  if (!emojiType) return;
  createReaction(event.message_id || event.id, emojiType, 'phase1');
}

async function maybeReactPhase2(event, content, response) {
  if (!cfg.feishuReactions) return;
  for (const emojiType of pickPhase2Emojis(content, response)) {
    createReaction(event.message_id || event.id, emojiType, 'phase2');
  }
}

function createReaction(messageId, emojiType, phase) {
  if (!messageId || !emojiType) return;
  const args = buildReactionCreateArgv({ messageId, emojiType, larkAs: cfg.larkAs });
  const result = spawnSync('lark-cli', args, {
    encoding: 'utf8',
    cwd: ROOT,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) {
    log('reaction failed', {
      messageId,
      emojiType,
      phase,
      stderr: result.stderr.trim(),
      stdout: result.stdout.trim(),
    });
    return;
  }
  log('reaction created', { messageId, emojiType, phase });
}

function startStreamingReply(parentMessageId) {
  if (!parentMessageId) return null;
  const initial = buildStreamingCardContent('正在处理...');
  const result = sendReplyPayload(parentMessageId, initial);
  if (!result.ok || !result.messageId) {
    log('streaming reply start failed', {
      parentMessageId,
      stderr: result.stderr || '',
      stdout: result.stdout || '',
    });
    return null;
  }

  let lastPatchAt = 0;
  let lastText = '';
  let closed = false;

  return {
    update(text) {
      if (closed) return false;
      const body = trimReply(text);
      if (!body || body === lastText || body === '(empty)') return true;
      const nowMs = Date.now();
      if (nowMs - lastPatchAt < cfg.feishuStreamPatchMs) return true;
      lastPatchAt = nowMs;
      lastText = body;
      const payload = buildStreamingCardContent(body);
      const patched = patchMessagePayload(result.messageId, payload);
      if (!patched.ok) {
        log('streaming reply patch failed', {
          messageId: result.messageId,
          stderr: patched.stderr,
          stdout: patched.stdout,
        });
      }
      return patched.ok;
    },
    finish(text) {
      if (closed) return false;
      closed = true;
      const payload = buildFinalCardContent(trimReply(text));
      const patched = patchMessagePayload(result.messageId, payload);
      if (!patched.ok) {
        log('streaming reply final patch failed', {
          messageId: result.messageId,
          stderr: patched.stderr,
          stdout: patched.stdout,
        });
        deleteMessage(result.messageId);
      }
      return patched.ok;
    },
  };
}

async function reply(messageId, text) {
  const body = trimReply(text);
  const rendered = cfg.feishuRichReplies ? buildMessageContent(body) : null;
  const result = rendered
    ? sendReplyPayload(messageId, rendered)
    : sendTextReply(messageId, body);
  if (result.status !== 0) {
    log(`rich reply failed; falling back to text`, {
      messageId,
      msgType: rendered?.msg_type || 'text',
      stderr: result.stderr.trim(),
      stdout: result.stdout.trim(),
    });
    const fallback = sendTextReply(messageId, body);
    if (fallback.status !== 0) {
      log(`reply failed`, { messageId, stderr: fallback.stderr.trim(), stdout: fallback.stdout.trim() });
      audit('reply_failed', { message_id: messageId }, { stderr: fallback.stderr.trim(), stdout: fallback.stdout.trim() });
      return;
    }
  }
  log(`replied`, { messageId, msgType: rendered?.msg_type || 'text' });
  audit('outbound', { message_id: messageId }, { text: body.slice(0, 500), msgType: rendered?.msg_type || 'text' });
}

function sendTextReply(messageId, text) {
  return spawnSync(
    'lark-cli',
    ['im', '+messages-reply', '--as', cfg.larkAs, '--message-id', messageId, '--text', text],
    { encoding: 'utf8', cwd: ROOT, maxBuffer: 8 * 1024 * 1024 },
  );
}

function sendReplyPayload(messageId, payload) {
  const result = spawnSync(
    'lark-cli',
    ['im', '+messages-reply', '--as', cfg.larkAs, '--message-id', messageId, '--msg-type', payload.msg_type, '--content', payload.content],
    { encoding: 'utf8', cwd: ROOT, maxBuffer: 8 * 1024 * 1024 },
  );
  return {
    ...result,
    ok: result.status === 0,
    messageId: parseReturnedMessageId(result.stdout),
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function patchMessagePayload(messageId, payload) {
  const result = spawnSync(
    'lark-cli',
    ['api', 'PATCH', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, '--as', cfg.larkAs, '--data', JSON.stringify({ content: payload.content })],
    { encoding: 'utf8', cwd: ROOT, maxBuffer: 8 * 1024 * 1024 },
  );
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
}

function deleteMessage(messageId) {
  const result = spawnSync(
    'lark-cli',
    ['im', 'messages', 'delete', '--as', cfg.larkAs, '--params', JSON.stringify({ message_id: messageId })],
    { encoding: 'utf8', cwd: ROOT, maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    log('delete message failed', {
      messageId,
      stderr: String(result.stderr || '').trim(),
      stdout: String(result.stdout || '').trim(),
    });
  }
}

function parseReturnedMessageId(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed?.data?.message_id || parsed?.message_id || parsed?.data?.message?.message_id || null;
  } catch {
    const match = text.match(/om_[A-Za-z0-9_-]+/);
    return match ? match[0] : null;
  }
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
    const running = session.backend === 'tmux'
      ? hasTmuxSession(session.tmuxSession || cfg.defaultTmuxSession)
      : session.state === 'running';
    const detail = session.backend === 'codex-app-server'
      ? `thread=${session.threadId || '(new)'}`
      : `tmux=${session.tmuxSession || cfg.defaultTmuxSession}`;
    return `${name}: ${session.agent}/${session.backend} ${running ? 'running' : 'stopped'} cwd=${session.cwd || cfg.defaultWorkdir} ${detail}`;
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
    '/new <name> [--backend codex-app-server|tmux] [--agent codex|claude|gemini|script] [--cwd path] [--cmd command]',
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

async function allocatePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  return port;
}

async function waitForWebSocket(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const ws = new WebSocket(url);
      await waitForWebSocketOpen(ws, 500);
      ws.close();
      return;
    } catch (error) {
      lastError = error;
      await sleep(150);
    }
  }
  throw new Error(`Codex app-server did not become ready: ${lastError?.message || lastError || 'timeout'}`);
}

function waitForWebSocketOpen(ws, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('websocket open timeout'));
    }, timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener('error', (error) => {
      clearTimeout(timer);
      reject(error);
    }, { once: true });
  });
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
  codexAppServer.close();
  process.exit(0);
}
