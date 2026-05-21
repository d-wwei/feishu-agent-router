#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  createInboxEntryLike,
  normalizeInboundEvent,
} from '../lib/feishu-ingest.mjs';
import {
  buildFinalCardContent,
  hasComplexMarkdown,
  buildMessageContent,
  buildStreamingCardContent,
} from '../lib/feishu-render.mjs';
import {
  buildReactionCreateArgv,
  pickPhase1Emoji,
  pickPhase2Emojis,
} from '../lib/feishu-interactions.mjs';
import {
  buildCodexCliConfigArgs,
  buildCodexThreadParams,
  buildCodexTurnParams,
} from '../lib/codex-config.mjs';
import {
  ensureAutoGroupSession,
  shouldIgnorePlainGroupMessage,
} from '../lib/session-routing.mjs';
import { evaluateAllowlist } from '../lib/allowlist-policy.mjs';
import {
  buildLarkCliArgs,
  parseLarkProfileList,
  resolveLarkBotIdentity,
  safeLarkBotLockKey,
} from '../lib/lark-cli.mjs';
import { isFeishuSelfSendReceipt } from '../lib/bridge-output.mjs';
import {
  bridgeDeveloperInstructions,
  buildPrompt,
} from '../lib/bridge-prompt.mjs';
import {
  shouldUseTmuxFallback,
  isCodexFirstOutputTimeout,
  userFacingSessionError,
} from '../lib/bridge-fallback.mjs';
import {
  assistantOutput,
  diffText,
  hasAssistantOutput,
} from '../lib/tmux-output.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const ENV_PATH = process.env.FTB_ENV_PATH
  ? path.resolve(process.env.FTB_ENV_PATH)
  : path.join(ROOT, '.env');

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
  larkProfile: env('FTB_LARK_PROFILE', ''),
  larkAppId: env('FTB_LARK_APP_ID', ''),
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
  autoCreateGroupSessions: boolEnv('FTB_AUTO_CREATE_GROUP_SESSIONS', false),
  autoGroupSessionPrefix: env('FTB_AUTO_GROUP_SESSION_PREFIX', 'group'),
  maxWaitMs: intEnv('FTB_MAX_WAIT_MS', 90_000),
  stableMs: intEnv('FTB_STABLE_MS', 3_500),
  pollMs: intEnv('FTB_POLL_MS', 1_000),
  captureLines: intEnv('FTB_CAPTURE_LINES', 1_200),
  replyMaxChars: intEnv('FTB_REPLY_MAX_CHARS', 3_500),
  restartDelayMs: intEnv('FTB_RESTART_DELAY_MS', 3_000),
  idleStopMs: intEnv('FTB_IDLE_STOP_MS', 0),
  codexPath: env('FTB_CODEX_PATH', 'codex'),
  codexAppServerListen: env('FTB_CODEX_APP_SERVER_LISTEN', ''),
  codexRequestTimeoutMs: intEnv('FTB_CODEX_REQUEST_TIMEOUT_MS', 120_000),
  codexStartTimeoutMs: intEnv('FTB_CODEX_START_TIMEOUT_MS', 8_000),
  codexFirstOutputTimeoutMs: intEnv('FTB_CODEX_FIRST_OUTPUT_TIMEOUT_MS', 90_000),
  codexExecTimeoutMs: intEnv('FTB_CODEX_EXEC_TIMEOUT_MS', 120_000),
  codexProfile: env('FTB_CODEX_PROFILE', ''),
  codexModel: env('FTB_CODEX_MODEL', ''),
  codexModelProvider: env('FTB_CODEX_MODEL_PROVIDER', ''),
  codexServiceTier: env('FTB_CODEX_SERVICE_TIER', ''),
  codexReasoningEffort: env('FTB_CODEX_REASONING_EFFORT', 'medium'),
  codexSandbox: env('FTB_CODEX_SANDBOX', 'danger-full-access'),
  codexApprovalPolicy: env('FTB_CODEX_APPROVAL_POLICY', 'never'),
  codexNetworkAccess: boolEnv('FTB_CODEX_NETWORK_ACCESS', true),
  codexAutoApproveRequests: boolEnv('FTB_CODEX_AUTO_APPROVE_REQUESTS', true),
  codexResponsesWebSockets: boolEnv('FTB_CODEX_RESPONSES_WEBSOCKETS', false),
  codexForceResponsesHttp: boolEnv('FTB_CODEX_FORCE_RESPONSES_HTTP', true),
  codexHttpProviderId: env('FTB_CODEX_HTTP_PROVIDER_ID', 'chatgpt_http'),
  codexHttpProviderName: env('FTB_CODEX_HTTP_PROVIDER_NAME', 'ChatGPT HTTP'),
  codexHttpProviderBaseUrl: env('FTB_CODEX_HTTP_PROVIDER_BASE_URL', 'https://chatgpt.com/backend-api/codex'),
  enableTmuxFallback: boolEnv('FTB_ENABLE_TMUX_FALLBACK', false),
  prewarmCodex: boolEnv('FTB_PREWARM_CODEX', true),
  prewarmSessions: csvEnv('FTB_PREWARM_SESSIONS', env('FTB_DEFAULT_SESSION', 'main')),
  prewarmTurn: boolEnv('FTB_PREWARM_TURN', false),
  feishuRichReplies: boolEnv('FTB_FEISHU_RICH_REPLIES', true),
  feishuReactions: boolEnv('FTB_FEISHU_REACTIONS', true),
  feishuStreamingMode: streamingModeEnv('FTB_FEISHU_STREAMING', 'auto'),
  coldStartCardDelayMs: intEnv('FTB_COLD_START_CARD_DELAY_MS', 1_500),
  feishuStreamStartDelayMs: intEnv('FTB_FEISHU_STREAM_START_DELAY_MS', 5_000),
  feishuStreamMinChars: intEnv('FTB_FEISHU_STREAM_MIN_CHARS', 240),
  feishuStreamPatchMs: intEnv('FTB_FEISHU_STREAM_PATCH_MS', 2_000),
};

let state = loadState();
let queue = Promise.resolve();
let shuttingDown = false;
let prewarmState = {
  status: cfg.prewarmCodex ? 'pending' : 'disabled',
  startedAt: null,
  completedAt: null,
  sessions: [],
  error: null,
};
validateExplicitLarkBotConfig();
const larkBotLock = acquireLarkBotLock();

log(`starting router`, { root: ROOT, home: HOME_DIR, larkProfile: cfg.larkProfile || undefined, larkAppId: cfg.larkAppId || undefined });
if (cfg.idleStopMs > 0) {
  setInterval(stopIdleSessions, Math.min(cfg.idleStopMs, 60_000)).unref?.();
}
startEventConsumer();
scheduleCodexPrewarm();

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', releaseLarkBotLock);

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
    if (process.env[key] === undefined) {
      process.env[key] = value.replace(/\\"/g, '"');
    }
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

function streamingModeEnv(name, fallback) {
  const raw = env(name, fallback).toLowerCase();
  if (['0', 'false', 'no', 'off', 'disabled'].includes(raw)) return 'off';
  if (['1', 'true', 'yes', 'on', 'always'].includes(raw)) return 'always';
  return 'auto';
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

function logCodexAppServerStderr(chunk) {
  for (const rawLine of chunk.toString().split(/\r?\n/)) {
    const text = rawLine.trim();
    if (!text) continue;
    const compact = text.length > 1200 ? `${text.slice(0, 1200)} ... [truncated]` : text;
    log(`[codex app-server] ${compact}`);
  }
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

function validateExplicitLarkBotConfig() {
  if (cfg.larkProfile && cfg.larkAppId) return;
  throw new Error([
    'Explicit Feishu bot binding is required.',
    'Set FTB_LARK_PROFILE to a lark-cli profile name and FTB_LARK_APP_ID to the Feishu/Lark app id.',
    'Refusing to use the active lark-cli bot implicitly.',
  ].join(' '));
}

function acquireLarkBotLock() {
  const identity = resolveRuntimeLarkBotIdentity();
  const lockDir = path.join(os.homedir(), '.feishu-agent-router', 'locks');
  const lockPath = path.join(lockDir, `lark-bot-${safeLarkBotLockKey(identity.key)}.lock`);
  fs.mkdirSync(lockDir, { recursive: true });

  const payload = {
    pid: process.pid,
    instanceName: process.env.FTB_INSTANCE_NAME || '',
    envPath: ENV_PATH,
    home: HOME_DIR,
    larkAs: cfg.larkAs,
    larkProfile: identity.profile,
    larkAppId: identity.appId,
    key: identity.key,
    startedAt: now(),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
      fs.closeSync(fd);
      return { path: lockPath, payload };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = readJson(lockPath, {});
      if (!existing.pid || !isPidAlive(existing.pid)) {
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      throw new Error([
        `Feishu bot is already bridged by another router process: ${identity.key}`,
        `existing pid: ${existing.pid}`,
        `existing instance: ${existing.instanceName || '(default)'}`,
        `existing env: ${existing.envPath || '(unknown)'}`,
        'Stop that router before starting another bridge for the same bot.',
      ].join('\n'));
    }
  }

  throw new Error(`Could not acquire Feishu bot lock: ${lockPath}`);
}

function resolveRuntimeLarkBotIdentity() {
  if (cfg.larkAppId) {
    return resolveLarkBotIdentity({ profile: cfg.larkProfile, appId: cfg.larkAppId });
  }

  const result = spawnSync('lark-cli', ['profile', 'list'], {
    encoding: 'utf8',
    cwd: ROOT,
    maxBuffer: 4 * 1024 * 1024,
  });
  const profiles = result.status === 0 ? parseLarkProfileList(result.stdout) : [];
  return resolveLarkBotIdentity({ profiles, profile: cfg.larkProfile });
}

function releaseLarkBotLock() {
  if (!larkBotLock?.path) return;
  try {
    const existing = readJson(larkBotLock.path, {});
    if (existing.pid === process.pid) fs.rmSync(larkBotLock.path, { force: true });
  } catch {}
}

function isPidAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
}

function larkCliArgs(args) {
  return buildLarkCliArgs(args, { profile: cfg.larkProfile });
}

function startEventConsumer() {
  const args = larkCliArgs([
    'event',
    'consume',
    'im.message.receive_v1',
    '--as',
    cfg.larkAs,
    '--jq',
    '{event_id,message_id,id,chat_id,chat_type,sender_id,message_type,content,create_time,timestamp,thread_id}',
  ]);
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

function scheduleCodexPrewarm() {
  if (!cfg.prewarmCodex) {
    log('codex prewarm disabled');
    return;
  }
  setTimeout(() => {
    prewarmCodex().catch((error) => {
      prewarmState = {
        ...prewarmState,
        status: 'failed',
        completedAt: now(),
        error: error.message || String(error),
      };
      log('codex prewarm failed', { error: stackOf(error) });
    });
  }, 0).unref?.();
}

async function prewarmCodex() {
  if (!cfg.prewarmCodex || prewarmState.status === 'running' || prewarmState.status === 'ready') {
    return;
  }
  const startedAt = Date.now();
  prewarmState = {
    status: 'running',
    startedAt: now(),
    completedAt: null,
    sessions: [],
    error: null,
  };
  log('codex prewarm starting', {
    sessions: cfg.prewarmSessions,
    warmupTurn: cfg.prewarmTurn,
    listenUrl: cfg.codexAppServerListen || 'stdio://',
  });

  reloadState();
  const appServerStartedAt = Date.now();
  await codexAppServer.ensureReady();
  const appServerReadyMs = Date.now() - appServerStartedAt;
  const sessions = [];

  for (const sessionName of cfg.prewarmSessions) {
    const session = state.sessions[sessionName];
    if (!session) {
      sessions.push({ sessionName, skipped: 'missing' });
      continue;
    }
    if (session.backend !== 'codex-app-server') {
      sessions.push({ sessionName, skipped: `backend:${session.backend}` });
      continue;
    }
    const timing = {};
    const threadId = await ensureCodexThread(sessionName, timing);
    updateSessionFields(sessionName, { state: 'running', updatedAt: now() });
    sessions.push({
      sessionName,
      threadId,
      appServerReadyMs: timing.appServerReadyMs,
      threadReadyMs: timing.threadReadyMs,
    });
  }

  let warmupTurnMs = null;
  if (cfg.prewarmTurn) {
    warmupTurnMs = await runCodexWarmupTurn();
  }

  prewarmState = {
    status: 'ready',
    startedAt: prewarmState.startedAt,
    completedAt: now(),
    sessions,
    error: null,
  };
  log('codex prewarm completed', {
    appServerReadyMs,
    sessions,
    warmupTurnMs,
    totalMs: Date.now() - startedAt,
  });
}

async function runCodexWarmupTurn() {
  const startedAt = Date.now();
  const result = await codexAppServer.threadStart({
    cwd: cfg.defaultWorkdir,
    ...buildCodexThreadParams(cfg),
    developerInstructions: bridgeDeveloperInstructions(),
    experimentalRawEvents: false,
    persistExtendedHistory: false,
  });
  await codexAppServer.turnStart({
    threadId: result.thread.id,
    input: [{ type: 'text', text: 'Warm up the Codex transport. Reply READY only.', text_elements: [] }],
    cwd: cfg.defaultWorkdir,
    approvalPolicy: cfg.codexApprovalPolicy,
    ...buildCodexTurnParams(cfg),
  }, { timing: {} });
  return Date.now() - startedAt;
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

  const policy = evaluateAllowlist(event, cfg);
  if (!policy.allowed) {
    log(`ignored event by policy`, {
      messageId,
      reason: policy.reason,
      field: policy.field,
      configuredCount: policy.configuredCount,
      sender: shortId(event.sender_id),
      chat: shortId(event.chat_id),
      remediation: policy.remediation,
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

  if (shouldIgnorePlainGroupMessage(event, cfg)) {
    log(`ignored plain group message`, { messageId, chat: shortId(event.chat_id) });
    return;
  }

  await sendToResolvedSession(event, content, {
    normalized,
    saveInbox: shouldSaveInbox(normalized),
  });
}

function isAdmin(event) {
  if (!cfg.adminUsers.length) return true;
  return cfg.adminUsers.includes(event.sender_id);
}

function isCommand(content) {
  return content.startsWith('/');
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
  const timing = createTurnTiming();
  let backendName = session.backend;
  let stream = null;
  try {
    const inbox = opts.saveInbox ? createInboxEntry(event, opts.normalized) : null;
    const prompt = buildPrompt(event, content, sessionName, inbox?.dir);
    await maybeReactPhase1(event, content);
    stream = createStreamingReplyController(event.message_id || event.id, content, {
      coldStart: shouldShowColdStartCard(sessionName, session),
    });
    const result = await runSessionWithFallback(sessionName, backend, prompt, {
      onDelta: (deltaText) => stream?.update(deltaText),
      timing,
    });
    const { output, elapsedMs, stable, backendName: resultBackendName, fallbackReason } = result;
    backendName = resultBackendName || backendName;
    log('session turn completed', { sessionName, backend: backendName, elapsedMs, stable, fallback: Boolean(fallbackReason) });
    if (looksLikeDirectFeishuReplyConfirmation(output)) {
      stream?.discard();
      timing.routerReplySuppressed = true;
      log('suppressed router reply because agent already replied through Feishu', { sessionName });
      await maybeReactPhase2(event, content, output);
      logTurnTiming(sessionName, backendName, timing, { suppressedRouterReply: true });
      return;
    }
    const text = output.trim()
      ? formatSessionReply(output, result)
      : `已投递到 ${sessionName}，但 ${Math.round(cfg.maxWaitMs / 1000)}s 内没有捕获到新输出。`;
    const finalText = stable ? text : `${text}\n\n[提示] 输出可能还没完全结束，可发 /capture ${sessionName} 查看。`;
    const replyStartedAt = Date.now();
    const streamDelivered = stream?.finish(finalText) || false;
    if (!streamDelivered) await reply(event.message_id || event.id, finalText);
    timing.feishuReplyMs = Date.now() - replyStartedAt;
    await maybeReactPhase2(event, content, text);
    logTurnTiming(sessionName, backendName, timing);
  } catch (error) {
    const messageId = event.message_id || event.id;
    const body = userFacingSessionError(error, sessionName);
    const replyStartedAt = Date.now();
    const streamDelivered = stream?.finish(body) || false;
    if (!streamDelivered) await reply(messageId, body);
    timing.feishuReplyMs = Date.now() - replyStartedAt;
    logTurnTiming(sessionName, backendName, timing, {
      failed: true,
      error: error.message || String(error),
    });
    log('session turn failed and user was notified', {
      sessionName,
      backend: backendName,
      error: error.message || String(error),
    });
  }
}

function createTurnTiming() {
  return { totalStartedAt: Date.now() };
}

function logTurnTiming(sessionName, backendName, timing, extra = {}) {
  const metrics = { ...timing };
  const totalStartedAt = metrics.totalStartedAt;
  delete metrics.totalStartedAt;
  log('session turn timing', {
    sessionName,
    backend: backendName,
    ...metrics,
    totalMs: totalStartedAt ? Date.now() - totalStartedAt : undefined,
    ...extra,
  });
}

function shouldShowColdStartCard(sessionName, session) {
  if (cfg.feishuStreamingMode === 'off') return false;
  if (session.backend !== 'codex-app-server') return false;
  if (prewarmState.status !== 'ready') return true;
  if (!session.threadId) return true;
  return !codexAppServer.hasThread(session.threadId);
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

function looksLikeDirectFeishuReplyConfirmation(output) {
  return isFeishuSelfSendReceipt(output);
}

async function runSessionWithFallback(sessionName, backend, prompt, opts = {}) {
  try {
    return await backend.run(sessionName, prompt, opts);
  } catch (error) {
    const session = getSession(sessionName);
    if (!shouldUseTmuxFallback(session, cfg)) throw error;
    log('codex app-server failed; falling back to tmux', { sessionName, error: error.message || String(error) });
    updateSessionFields(sessionName, { threadId: null, state: 'stopped', updatedAt: now() });
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
  if (threadRoute || userCurrent || chatRoute || userRoute) {
    return threadRoute || userCurrent || chatRoute || userRoute;
  }

  const autoGroup = ensureAutoGroupSession(state, event, cfg, { now: now() });
  if (autoGroup?.changed) {
    writeJson(SESSIONS_PATH, state.sessions);
    writeJson(ROUTES_PATH, state.routes);
    log('auto-created group session', {
      sessionName: autoGroup.sessionName,
      chat: shortId(event.chat_id),
    });
  }
  return autoGroup?.sessionName || cfg.defaultSession;
}

function getSession(name) {
  const session = state.sessions[name];
  if (!session) throw new Error(`找不到 session：${name}`);
  return session;
}

async function ensureCodexThread(name, timing) {
  const appServerStartedAt = Date.now();
  await codexAppServer.ensureReady();
  if (timing) timing.appServerReadyMs = Date.now() - appServerStartedAt;
  const threadStartedAt = Date.now();
  const session = getSession(name);
  if (session.threadId && codexAppServer.hasThread(session.threadId)) {
    if (timing) timing.threadReadyMs = Date.now() - threadStartedAt;
    return session.threadId;
  }

  if (session.threadId) {
    try {
      await codexAppServer.threadResume({
        threadId: session.threadId,
        cwd: session.cwd || cfg.defaultWorkdir,
        ...buildCodexThreadParams(cfg),
        developerInstructions: bridgeDeveloperInstructions(),
        persistExtendedHistory: false,
      });
      if (timing) timing.threadReadyMs = Date.now() - threadStartedAt;
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
    ...buildCodexThreadParams(cfg),
    developerInstructions: bridgeDeveloperInstructions(),
    experimentalRawEvents: false,
    persistExtendedHistory: false,
  });
  const threadId = result.thread.id;
  updateSessionFields(name, { threadId, updatedAt: now() });
  if (timing) timing.threadReadyMs = Date.now() - threadStartedAt;
  return threadId;
}

class CodexAppServerClient {
  constructor() {
    this.requestId = 0;
    this.pending = new Map();
    this.turns = new Map();
    this.liveThreads = new Set();
    this.child = null;
    this.transport = null;
    this.ready = null;
    this.listenUrl = null;
  }

  async ensureReady() {
    if (this.ready) return this.ready;
    this.ready = this.start();
    return this.ready;
  }

  async start() {
    const listenUrl = this.resolveListenUrl();
    const args = ['app-server', '--listen', listenUrl, ...buildCodexCliConfigArgs(cfg)];
    log('starting codex app-server', {
      listenUrl,
      profile: cfg.codexProfile || undefined,
      model: cfg.codexModel || undefined,
      modelProvider: cfg.codexModelProvider || undefined,
      forceResponsesHttp: cfg.codexForceResponsesHttp && cfg.codexResponsesWebSockets === false,
    });
    if (listenUrl.startsWith('unix://')) {
      try { fs.unlinkSync(unixSocketPath(listenUrl)); } catch {}
    }
    this.child = spawn(cfg.codexPath, args, {
      cwd: ROOT,
      env: process.env,
      stdio: listenUrl === 'stdio://' ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    });
    this.listenUrl = listenUrl;
    this.child.once('error', (error) => {
      log('codex app-server spawn failed', { error: error.message || String(error) });
      this.rejectAll(error);
      this.transport = null;
      this.ready = null;
      this.liveThreads.clear();
    });
    this.child.stderr?.on('data', (chunk) => logCodexAppServerStderr(chunk));
    this.child.once('exit', (code, signal) => {
      log('codex app-server exited', { code, signal });
      this.rejectAll(new Error(`Codex app-server exited: ${signal || code}`));
      this.transport = null;
      this.ready = null;
      this.liveThreads.clear();
    });

    this.transport = listenUrl === 'stdio://'
      ? this.createStdioTransport()
      : await this.createUnixTransport(listenUrl);

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

  resolveListenUrl() {
    const listenUrl = cfg.codexAppServerListen || 'stdio://';
    if (listenUrl === 'stdio://') return listenUrl;
    if (listenUrl === 'unix://') return `unix://${path.join(LOG_DIR, 'codex-app-server.sock')}`;
    if (listenUrl.startsWith('unix://')) return listenUrl;
    if (listenUrl.startsWith('ws://') || listenUrl.startsWith('wss://')) {
      throw new Error('当前 Codex app-server 不再支持 ws:// 监听；请设置 FTB_CODEX_APP_SERVER_LISTEN=stdio:// 或 unix://PATH。');
    }
    if (listenUrl === 'off') {
      throw new Error('codex-app-server backend 需要可用 transport；FTB_CODEX_APP_SERVER_LISTEN 不能为 off。');
    }
    throw new Error(`不支持的 Codex app-server listen URL：${listenUrl}`);
  }

  createStdioTransport() {
    if (!this.child?.stdin || !this.child?.stdout) {
      throw new Error('Codex app-server stdio transport is unavailable');
    }
    const rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => this.handleTransportLine(line));
    this.child.stdout.on('close', () => {
      this.rejectAll(new Error('Codex app-server stdio closed'));
      this.transport = null;
      this.ready = null;
      this.liveThreads.clear();
    });
    return {
      kind: 'stdio',
      send: (payload) => this.child.stdin.write(`${JSON.stringify(payload)}\n`),
      close: () => {
        rl.close();
        try { this.child.stdin.end(); } catch {}
      },
    };
  }

  async createUnixTransport(listenUrl) {
    const socketPath = unixSocketPath(listenUrl);
    const { socket, initialData } = await connectUnixWebSocket(socketPath, cfg.codexStartTimeoutMs);
    const wsState = { buffer: Buffer.alloc(0), fragments: [] };
    const onData = (chunk) => {
      consumeWebSocketFrames(wsState, chunk, {
        onText: (text) => this.handleMessage(text),
        onPing: (payload) => sendWebSocketFrame(socket, 0xA, payload),
        onClose: () => socket.end(),
      });
    };
    socket.on('data', onData);
    if (initialData.length) onData(initialData);
    socket.on('close', () => {
      this.rejectAll(new Error('Codex app-server unix socket closed'));
      this.transport = null;
      this.ready = null;
      this.liveThreads.clear();
    });
    socket.on('error', (error) => log('codex app-server unix socket error', { error: error.message || String(error) }));
    return {
      kind: 'unix',
      send: (payload) => sendWebSocketText(socket, JSON.stringify(payload)),
      close: () => {
        socket.off('data', onData);
        try { sendWebSocketFrame(socket, 0x8, Buffer.alloc(0)); } catch {}
        socket.end();
      },
    };
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
    const turnStartedAt = Date.now();
    const result = await this.request('turn/start', params);
    const turnId = result.turn.id;
    return new Promise((resolve, reject) => {
      const firstOutputTimer = setTimeout(() => {
        const turn = this.turns.get(turnId);
        if (!turn) return;
        this.turns.delete(turnId);
        this.request('turn/interrupt', { threadId: params.threadId, turnId }).catch((error) => {
          log('codex turn interrupt failed after first-output timeout', { error: error.message || String(error) });
        });
        this.clearTurnTimers(turn);
        const error = new Error(`Timed out waiting for first Codex output event after ${Math.round(cfg.codexFirstOutputTimeoutMs / 1000)}s`);
        error.code = 'CODEX_FIRST_OUTPUT_TIMEOUT';
        reject(error);
      }, cfg.codexFirstOutputTimeoutMs);
      const completionTimer = setTimeout(() => {
        const turn = this.turns.get(turnId);
        if (!turn) return;
        this.turns.delete(turnId);
        this.request('turn/interrupt', { threadId: params.threadId, turnId }).catch((error) => {
          log('codex turn interrupt after timeout failed', { turnId, error: error.message || String(error) });
        });
        this.clearTurnTimers(turn);
        reject(new Error('Timed out waiting for turn/completed; interrupt requested'));
      }, cfg.codexRequestTimeoutMs);
      this.turns.set(turnId, {
        threadId: params.threadId,
        text: '',
        final: '',
        lastError: null,
        onDelta: opts.onDelta,
        startedAt: turnStartedAt,
        timing: opts.timing,
        firstOutputTimer,
        completionTimer,
        resolve,
        reject,
      });
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
    if (!this.transport) {
      throw new Error('Codex app-server transport is not open');
    }
    this.transport.send(payload);
  }

  handleTransportLine(line) {
    if (!line.trim()) return;
    this.handleMessage(line);
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
        this.markTurnOutputStarted(turn);
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
        this.markTurnOutputStarted(turn);
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
      this.clearTurnTimers(turn);
      if (turn.timing) turn.timing.turnCompletedMs = Date.now() - turn.startedAt;
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
      msg.method === 'item/fileChange/requestApproval'
    ) {
      this.send({ id: msg.id, result: { decision: cfg.codexAutoApproveRequests ? 'accept' : 'decline' } });
      return;
    }
    if (msg.method === 'item/permissions/requestApproval') {
      this.send({ id: msg.id, result: permissionApprovalResponse() });
      return;
    }
    if (msg.method === 'item/tool/requestUserInput') {
      this.send({ id: msg.id, result: { answers: {} } });
      return;
    }
    if (msg.method === 'mcpServer/elicitation/request') {
      this.send({ id: msg.id, result: { action: 'cancel' } });
      return;
    }
    if (msg.method === 'applyPatchApproval' || msg.method === 'execCommandApproval') {
      this.send({ id: msg.id, result: { decision: cfg.codexAutoApproveRequests ? 'approved' : 'denied' } });
      return;
    }
    if (msg.method === 'item/tool/call') {
      this.send({
        id: msg.id,
        result: {
          contentItems: [{ type: 'inputText', text: `Unsupported client tool: ${msg.params?.tool || 'unknown'}` }],
          success: false,
        },
      });
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
      this.clearTurnTimers(turn);
      turn.reject(error);
      this.turns.delete(turnId);
    }
  }

  reset(reason) {
    log('resetting codex app-server', { reason });
    this.rejectAll(new Error(`Codex app-server reset: ${reason || 'unknown'}`));
    try { this.transport?.close(); } catch {}
    try { this.child?.kill(); } catch {}
    this.transport = null;
    this.ready = null;
    this.child = null;
    this.liveThreads.clear();
  }

  markTurnOutputStarted(turn) {
    if (turn.timing && turn.timing.firstOutputMs === undefined) {
      turn.timing.firstOutputMs = Date.now() - turn.startedAt;
    }
    if (!turn.firstOutputTimer) return;
    clearTimeout(turn.firstOutputTimer);
    turn.firstOutputTimer = null;
  }

  clearTurnTimers(turn) {
    if (turn.firstOutputTimer) clearTimeout(turn.firstOutputTimer);
    if (turn.completionTimer) clearTimeout(turn.completionTimer);
    turn.firstOutputTimer = null;
    turn.completionTimer = null;
  }

  statusText() {
    return this.transport ? `running ${this.listenUrl}` : 'stopped';
  }

  close() {
    try { this.transport?.close(); } catch {}
    try { this.child?.kill(); } catch {}
  }
}

function backendFor(session) {
  if (session.backend === 'codex-app-server') return codexAppServerBackend;
  if (session.backend === 'codex-exec') return codexExecBackend;
  if (session.backend === 'tmux') return tmuxBackend;
  throw new Error(`不支持的 backend：${session.backend}`);
}

const codexAppServer = new CodexAppServerClient();

const codexAppServerBackend = {
  async ensure(name) {
    await ensureCodexThread(name);
    updateSessionState(name, 'running');
  },
  async run(name, text, opts = {}) {
    return runCodexAppServerTurn(name, text, opts, 0);
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

async function runCodexAppServerTurn(name, text, opts = {}, attempt = 0) {
  try {
    const start = Date.now();
    const threadId = await ensureCodexThread(name, opts.timing);
    const output = await codexAppServer.turnStart({
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      cwd: getSession(name).cwd || cfg.defaultWorkdir,
      approvalPolicy: cfg.codexApprovalPolicy,
      ...buildCodexTurnParams(cfg),
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
  } catch (error) {
    if (isCodexFirstOutputTimeout(error) && attempt === 0) {
      log('codex first-output timeout; restarting app-server and retrying once', {
        sessionName: name,
        error: error.message || String(error),
      });
      codexAppServer.reset('first-output timeout');
      updateSessionFields(name, { threadId: null, state: 'stopped', updatedAt: now() });
      return runCodexAppServerTurn(name, text, opts, attempt + 1);
    }
    throw error;
  }
}

const codexExecBackend = {
  async ensure(name) {
    updateSessionState(name, 'running');
  },
  async run(name, text) {
    const start = Date.now();
    const session = getSession(name);
    const cwd = session.cwd || cfg.defaultWorkdir;
    const output = await runCodexExec(text, { cwd });
    updateSessionFields(name, {
      state: 'running',
      lastOutput: output,
      lastBackend: 'codex-exec',
      updatedAt: now(),
    });
    return {
      output,
      elapsedMs: Date.now() - start,
      stable: true,
      backendName: 'codex-exec',
    };
  },
  async capture(name) {
    const session = getSession(name);
    return [
      `session: ${name}`,
      `backend: codex-exec`,
      `cwd: ${session.cwd || cfg.defaultWorkdir}`,
      '',
      session.lastOutput || '(no last output)',
    ].join('\n');
  },
  async status(name) {
    const session = getSession(name);
    return [
      `session: ${name}`,
      `backend: codex-exec`,
      `cwd: ${session.cwd || cfg.defaultWorkdir}`,
      `model: ${cfg.codexModel || '(Codex default)'}`,
      `effort: ${cfg.codexReasoningEffort || '(default)'}`,
      `sandbox: danger-full-access`,
      `updated: ${session.updatedAt || '-'}`,
    ].join('\n');
  },
  async interrupt() {},
  async stop(name) {
    updateSessionFields(name, { state: 'stopped', updatedAt: now() });
  },
  async restart(name) {
    updateSessionFields(name, { state: 'stopped', updatedAt: now() });
  },
};

function runCodexExec(prompt, { cwd }) {
  return new Promise((resolve, reject) => {
    const outputPath = path.join(LOG_DIR, `codex-exec-${Date.now()}-${process.pid}.txt`);
    const args = [
      'exec',
      '-C',
      cwd,
      '--dangerously-bypass-approvals-and-sandbox',
      '--output-last-message',
      outputPath,
      ...buildCodexCliConfigArgs(cfg),
      '-',
    ];
    log('starting codex exec', { cwd });
    const child = spawn(cfg.codexPath, args, {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Codex exec timed out after ${cfg.codexExecTimeoutMs}ms`));
    }, cfg.codexExecTimeoutMs);

    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const final = readTextIfExists(outputPath).trim() || stdout.trim();
      try { fs.unlinkSync(outputPath); } catch {}
      if (stderr.trim()) log('[codex exec stderr]', { stderr: stderr.trim().slice(-4000) });
      if (code !== 0) {
        reject(new Error(`Codex exec failed: ${signal || code}; ${stderr.trim().slice(-1000)}`));
        return;
      }
      resolve(final);
    });
    child.stdin.end(prompt);
  });
}

function readTextIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function permissionApprovalResponse() {
  if (!cfg.codexAutoApproveRequests) {
    return { permissions: {}, scope: 'turn' };
  }
  return {
    permissions: {
      fileSystem: {
        entries: [
          {
            access: 'write',
            path: { type: 'special', value: { kind: 'root' } },
          },
        ],
      },
      network: { enabled: true },
    },
    scope: 'session',
  };
}

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
    await sleep(750);
    if (!hasTmuxSession(tmuxSession)) {
      throw new Error(`tmux session ${tmuxSession} exited immediately after start; command=${command}`);
    }
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
    let last = await this.capture(name);
    let lastChangedAt = Date.now();
    let sawChange = false;

    while (Date.now() - start < cfg.maxWaitMs) {
      await sleep(cfg.pollMs);
      const current = await this.capture(name);
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

    const current = await this.capture(name);
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

function createInboxEntry(event, normalized) {
  const entry = createInboxEntryLike(event, {
    inboxRoot: INBOX_DIR,
    larkAs: cfg.larkAs,
    larkProfile: cfg.larkProfile,
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
        larkCliArgs(['im', '+messages-resources-download', '--as', cfg.larkAs, '--message-id', effective.messageId, '--type', type]),
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
  const args = buildReactionCreateArgv({ messageId, emojiType, larkAs: cfg.larkAs, larkProfile: cfg.larkProfile });
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

function createStreamingReplyController(parentMessageId, inputText, options = {}) {
  if (!parentMessageId || cfg.feishuStreamingMode === 'off') return null;
  const immediate = cfg.feishuStreamingMode === 'always';
  const coldStart = Boolean(options.coldStart);
  const startDelayMs = coldStart
    ? Math.min(cfg.coldStartCardDelayMs, cfg.feishuStreamStartDelayMs)
    : cfg.feishuStreamStartDelayMs;
  const pendingText = coldStart ? '正在连接 Codex...' : '正在处理...';
  const likelyLong = immediate || coldStart || likelyNeedsStreaming(inputText);
  let result = null;
  let started = false;
  let closed = false;
  let lastPatchAt = 0;
  let lastText = '';
  const startedAt = Date.now();
  const timer = likelyLong && !immediate
    ? setTimeout(() => ensureStarted(lastText || pendingText), startDelayMs)
    : null;
  timer?.unref?.();

  function shouldStart(body) {
    if (closed || started) return false;
    if (immediate) return true;
    if (Date.now() - startedAt < startDelayMs) return false;
    if (likelyLong) return true;
    return body.length >= cfg.feishuStreamMinChars || hasComplexMarkdown(body);
  }

  function ensureStarted(seedText) {
    if (closed) return false;
    if (started) return true;
    const body = trimReply(seedText || pendingText);
    if (!shouldStart(body)) return false;
    const initial = buildStreamingCardContent(body);
    const sent = sendReplyPayload(parentMessageId, initial);
    if (!sent.ok || !sent.messageId) {
      log('streaming reply start failed', {
        parentMessageId,
        stderr: sent.stderr || '',
        stdout: sent.stdout || '',
      });
      return false;
    }
    result = sent;
    started = true;
    lastPatchAt = Date.now();
    lastText = body;
    return true;
  }

  return {
    update(text) {
      if (closed) return false;
      const body = trimReply(text);
      if (!body || body === lastText || body === '(empty)') return true;
      lastText = body;
      if (!ensureStarted(body)) return true;
      const nowMs = Date.now();
      if (nowMs - lastPatchAt < cfg.feishuStreamPatchMs) return true;
      lastPatchAt = nowMs;
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
      if (timer) clearTimeout(timer);
      if (!started || !result?.messageId) return false;
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
    discard() {
      if (closed) return false;
      closed = true;
      if (timer) clearTimeout(timer);
      if (started && result?.messageId) deleteMessage(result.messageId);
      return true;
    },
  };
}

function likelyNeedsStreaming(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (text.length >= cfg.feishuStreamMinChars) return true;
  return /实现|开发|修改|重构|排查|诊断|分析|测试|安装|部署|迁移|规划|整理|总结|对比|review|debug|implement|refactor|analy[sz]e|install|deploy|migrate|plan|summari[sz]e|compare/i.test(text);
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
    larkCliArgs(['im', '+messages-reply', '--as', cfg.larkAs, '--message-id', messageId, '--text', text]),
    { encoding: 'utf8', cwd: ROOT, maxBuffer: 8 * 1024 * 1024 },
  );
}

function sendReplyPayload(messageId, payload) {
  const result = spawnSync(
    'lark-cli',
    larkCliArgs(['im', '+messages-reply', '--as', cfg.larkAs, '--message-id', messageId, '--msg-type', payload.msg_type, '--content', payload.content]),
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
    larkCliArgs(['api', 'PATCH', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, '--as', cfg.larkAs, '--data', JSON.stringify({ content: payload.content })]),
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
    larkCliArgs(['im', 'messages', 'delete', '--as', cfg.larkAs, '--params', JSON.stringify({ message_id: messageId })]),
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

function unixSocketPath(listenUrl) {
  if (!listenUrl.startsWith('unix://')) {
    throw new Error(`Not a unix socket URL: ${listenUrl}`);
  }
  const rawPath = listenUrl.slice('unix://'.length);
  if (!rawPath) return path.join(LOG_DIR, 'codex-app-server.sock');
  return rawPath.startsWith('/') ? rawPath : path.resolve(ROOT, rawPath);
}

async function connectUnixWebSocket(socketPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await openUnixWebSocket(socketPath, Math.max(1, Math.min(1000, deadline - Date.now())));
    } catch (error) {
      lastError = error;
      await sleep(150);
    }
  }
  throw new Error(`Codex app-server unix socket did not become ready: ${lastError?.message || lastError || 'timeout'}`);
}

function openUnixWebSocket(socketPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const key = crypto.randomBytes(16).toString('base64');
    let chunks = [];
    let totalLength = 0;
    let done = false;

    let cleanup = () => {};
    const fail = (error) => {
      if (done) return;
      done = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onError = (error) => fail(error);
    const onData = (chunk) => {
      chunks.push(chunk);
      totalLength += chunk.length;
      const buffer = Buffer.concat(chunks, totalLength);
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;

      const header = buffer.slice(0, headerEnd).toString('utf8');
      const status = header.split(/\r?\n/, 1)[0] || '';
      if (!/^HTTP\/1\.[01] 101\b/.test(status)) {
        fail(new Error(`unix websocket upgrade failed: ${status || header.slice(0, 120)}`));
        return;
      }
      const accept = header.match(/^Sec-WebSocket-Accept:\s*(.+)$/im)?.[1]?.trim();
      const expected = crypto
        .createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      if (accept && accept !== expected) {
        fail(new Error('unix websocket upgrade returned an invalid Sec-WebSocket-Accept'));
        return;
      }

      done = true;
      cleanup();
      resolve({ socket, initialData: buffer.slice(headerEnd + 4) });
    };

    const timer = setTimeout(() => {
      fail(new Error('unix websocket connect timeout'));
    }, timeoutMs);
    cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
    };

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.write([
        'GET / HTTP/1.1',
        'Host: localhost',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'));
    });
  });
}

function consumeWebSocketFrames(state, chunk, handlers) {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  while (state.buffer.length >= 2) {
    const first = state.buffer[0];
    const second = state.buffer[1];
    const fin = Boolean(first & 0x80);
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let payloadLength = second & 0x7f;
    let offset = 2;

    if (payloadLength === 126) {
      if (state.buffer.length < offset + 2) return;
      payloadLength = state.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLength === 127) {
      if (state.buffer.length < offset + 8) return;
      const bigLength = state.buffer.readBigUInt64BE(offset);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('websocket frame too large');
      }
      payloadLength = Number(bigLength);
      offset += 8;
    }

    const maskOffset = offset;
    if (masked) offset += 4;
    if (state.buffer.length < offset + payloadLength) return;

    let payload = state.buffer.slice(offset, offset + payloadLength);
    if (masked) {
      const mask = state.buffer.slice(maskOffset, maskOffset + 4);
      const unmasked = Buffer.alloc(payload.length);
      for (let index = 0; index < payload.length; index++) {
        unmasked[index] = payload[index] ^ mask[index % 4];
      }
      payload = unmasked;
    }
    state.buffer = state.buffer.slice(offset + payloadLength);

    if (opcode === 0x8) {
      handlers.onClose?.();
      return;
    }
    if (opcode === 0x9) {
      handlers.onPing?.(payload);
      continue;
    }
    if (opcode === 0xA) continue;
    if (opcode === 0x1 || opcode === 0x0) {
      state.fragments.push(payload);
      if (fin) {
        const text = Buffer.concat(state.fragments).toString('utf8');
        state.fragments = [];
        handlers.onText(text);
      }
    }
  }
}

function sendWebSocketText(socket, text) {
  sendWebSocketFrame(socket, 0x1, Buffer.from(text, 'utf8'));
}

function sendWebSocketFrame(socket, opcode, payload) {
  const mask = crypto.randomBytes(4);
  const length = payload.length;
  let header;
  if (length <= 125) {
    header = Buffer.alloc(2 + 4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | length;
    mask.copy(header, 2);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4 + 4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
    mask.copy(header, 4);
  } else {
    header = Buffer.alloc(10 + 4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
    mask.copy(header, 10);
  }

  const masked = Buffer.alloc(length);
  for (let index = 0; index < length; index++) {
    masked[index] = payload[index] ^ mask[index % 4];
  }
  socket.write(Buffer.concat([header, masked]));
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
