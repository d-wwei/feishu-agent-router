#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLarkCliArgs, parseLarkProfileList } from '../lib/lark-cli.mjs';
import { extractIgnoredPolicyEvents } from '../lib/allowlist-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = parseCli(process.argv.slice(2));
const envPath = cli.options.env
  ? path.resolve(cli.options.env)
  : process.env.FTB_ENV_PATH
    ? path.resolve(process.env.FTB_ENV_PATH)
    : path.join(root, '.env');
const envFile = readDotEnv(envPath);
const cfg = {
  larkAs: env('FTB_LARK_AS', 'bot'),
  larkProfile: env('FTB_LARK_PROFILE', ''),
  larkAppId: env('FTB_LARK_APP_ID', ''),
  home: cli.options.home
    ? path.resolve(cli.options.home)
    : env('FTB_HOME', path.join(process.env.HOME || root, '.feishu-agent-router')),
  instanceName: cli.options.name || process.env.FTB_INSTANCE_NAME || envFile.FTB_INSTANCE_NAME || '',
  allowedSenders: csvEnv('FTB_ALLOWED_SENDERS'),
  allowedChats: csvEnv('FTB_ALLOWED_CHATS'),
};

function checkBin(name) {
  const result = spawnSync('which', [name], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

const bins = ['node', 'lark-cli', 'tmux', 'codex'];
for (const bin of bins) {
  const found = checkBin(bin);
  console.log(`${found ? 'ok' : 'missing'} ${bin}${found ? ` -> ${found}` : ''}`);
}

const appServer = spawnSync('codex', ['app-server', '--help'], { encoding: 'utf8' });
console.log(`${appServer.status === 0 ? 'ok' : 'missing'} codex app-server`);
const appServerHelp = `${appServer.stdout || ''}\n${appServer.stderr || ''}`;
const hasModernTransport = appServerHelp.includes('stdio://') && appServerHelp.includes('unix://');
console.log(`${hasModernTransport ? 'ok' : 'missing'} codex app-server stdio/unix transport`);

console.log(`${fs.existsSync(envPath) ? 'ok' : 'missing'} env -> ${envPath}`);
if (!fs.existsSync(envPath)) {
  console.log('Create it from .env.example before starting.');
  process.exit(0);
}

console.log(`${cfg.larkProfile ? 'ok' : 'missing'} FTB_LARK_PROFILE${cfg.larkProfile ? `=${cfg.larkProfile}` : ''}`);
console.log(`${cfg.larkAppId ? 'ok' : 'missing'} FTB_LARK_APP_ID${cfg.larkAppId ? `=${cfg.larkAppId}` : ''}`);
console.log(`info FTB_LARK_AS=${cfg.larkAs}`);
console.log(`info FTB_ALLOWED_SENDERS count=${cfg.allowedSenders.length}`);
console.log(`info FTB_ALLOWED_CHATS count=${cfg.allowedChats.length}`);

checkLarkProfile();
checkUserOAuth();
summarizeIgnoredPolicyLogs();

function checkLarkProfile() {
  const result = spawnSync('lark-cli', ['profile', 'list'], {
    encoding: 'utf8',
    cwd: root,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) {
    console.log(`warn lark-cli profile list failed: ${(result.stderr || result.stdout || '').trim()}`);
    return;
  }

  const profiles = parseLarkProfileList(result.stdout);
  const matched = profiles.find((item) => item.name === cfg.larkProfile);
  if (!cfg.larkProfile) {
    console.log('warn no lark profile configured; router will refuse implicit active bot usage');
    return;
  }
  if (!matched) {
    console.log(`missing lark profile ${cfg.larkProfile}`);
    return;
  }
  console.log(`ok lark profile ${cfg.larkProfile}`);
  if (cfg.larkAppId && matched.appId !== cfg.larkAppId) {
    console.log(`warn profile appId mismatch: profile has ${matched.appId || '(empty)'}, env has ${cfg.larkAppId}`);
  } else if (cfg.larkAppId) {
    console.log(`ok profile appId matches ${cfg.larkAppId}`);
  }
}

function checkUserOAuth() {
  if (!cfg.larkProfile) return;
  const result = spawnSync('lark-cli', buildLarkCliArgs(['auth', 'status'], { profile: cfg.larkProfile }), {
    encoding: 'utf8',
    cwd: root,
    maxBuffer: 4 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (result.status === 0) {
    console.log('ok lark-cli auth status');
    return;
  }
  console.log(`warn lark-cli auth status unavailable for profile ${cfg.larkProfile}`);
  if (output) console.log(`info auth status: ${output.split(/\r?\n/)[0]}`);
  console.log('info If this profile has no user OAuth, discover sender open_id with farctl allowlist-capture.');
}

function summarizeIgnoredPolicyLogs() {
  const logPath = path.join(cfg.home, 'logs', 'router.log');
  if (!fs.existsSync(logPath)) {
    console.log(`info no router log yet -> ${logPath}`);
    return;
  }
  const events = extractIgnoredPolicyEvents(fs.readFileSync(logPath, 'utf8'), { limit: 5 });
  if (!events.length) {
    console.log('ok no recent ignored event by policy entries');
    return;
  }
  console.log(`warn recent ignored event by policy entries: ${events.length}`);
  for (const event of events) {
    console.log(`  - message=${event.messageId || '-'} reason=${event.reason || 'unknown'} sender=${event.sender || '-'} chat=${event.chat || '-'}`);
  }
  console.log('remediation sender_id is open_id and app-scoped; after changing bot/app, recapture it.');
  console.log(`remediation run: farctl${cfg.instanceName ? ` --name ${cfg.instanceName}` : ''} --env "${envPath}" --home "${cfg.home}" allowlist-capture --timeout 120s`);
}

function parseCli(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--env') {
      options.env = argv[++i] || '';
    } else if (token.startsWith('--env=')) {
      options.env = token.slice('--env='.length);
    } else if (token === '--home') {
      options.home = argv[++i] || '';
    } else if (token.startsWith('--home=')) {
      options.home = token.slice('--home='.length);
    } else if (token === '--name') {
      options.name = argv[++i] || '';
    } else if (token.startsWith('--name=')) {
      options.name = token.slice('--name='.length);
    }
  }
  return { options };
}

function readDotEnv(file) {
  const result = {};
  if (!fs.existsSync(file)) return result;
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
    result[key] = value.replace(/\\"/g, '"');
  }
  return result;
}

function env(name, fallback) {
  const value = process.env[name] ?? envFile[name];
  return value && String(value).trim() ? String(value).trim() : fallback;
}

function csvEnv(name) {
  return env(name, '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}
