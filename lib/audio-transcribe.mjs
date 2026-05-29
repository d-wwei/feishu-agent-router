import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_STDIO = 4 * 1024 * 1024;
const SHELL_META = /[;&|`$<>(){}[\]*?~!#\n\r]/;

export function transcribeAudioFile({ file, cfg = {}, spawnSync: runner = spawnSync, now = Date.now } = {}) {
  const startedAt = now();
  if (!cfg.audioTranscribe || cfg.audioTranscribe === 'off') {
    return skipped('audio_transcription_disabled', '语音消息已下载，本地转写已关闭。', startedAt, now);
  }

  const validation = validateInputFile(file, cfg);
  if (!validation.ok) return { ...validation.result, elapsedMs: now() - startedAt };

  const detected = detectAudioTranscriptionEngine(cfg);
  if (!detected.ok) {
    return skipped(detected.reason || 'local_transcription_engine_unavailable', userMessageForReason(detected.reason), startedAt, now);
  }

  const timeoutMs = positiveInt(cfg.audioTranscribeTimeoutMs, 120_000);
  const command = commandForEngine(detected, file, cfg);
  if (!command.ok) {
    return skipped(command.reason, userMessageForReason(command.reason), startedAt, now);
  }

  const result = runner(command.file, command.args, {
    cwd: cfg.cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: cfg.maxBuffer || DEFAULT_MAX_STDIO,
    env: minimalEnv(),
  });

  if (result.error?.code === 'ETIMEDOUT' || result.signal) {
    return {
      status: 'timeout',
      engine: detected.engine,
      model: detected.model,
      reason: 'transcription_timeout',
      userVisibleMessage: userMessageForReason('transcription_timeout'),
      retryable: true,
      elapsedMs: now() - startedAt,
    };
  }

  if (result.status !== 0) {
    return {
      status: 'failed',
      engine: detected.engine,
      model: detected.model,
      reason: 'transcription_failed',
      userVisibleMessage: userMessageForReason('transcription_failed'),
      retryable: true,
      elapsedMs: now() - startedAt,
    };
  }

  const text = parseTranscriptOutput(result.stdout, detected.engine);
  if (!text) {
    return {
      status: 'failed',
      engine: detected.engine,
      model: detected.model,
      reason: 'empty_transcript',
      userVisibleMessage: userMessageForReason('empty_transcript'),
      retryable: true,
      elapsedMs: now() - startedAt,
    };
  }

  return {
    status: 'ok',
    text,
    engine: detected.engine,
    model: detected.model,
    reason: 'ok',
    userVisibleMessage: '转写完成',
    retryable: false,
    elapsedMs: now() - startedAt,
  };
}

export function detectAudioTranscriptionEngine(cfg = {}) {
  const engine = cfg.audioTranscribeEngine || 'auto';
  if (engine === 'fake') return detectFakeEngine(cfg);
  if (engine === 'whisper-cpp' || engine === 'whisper.cpp') return detectWhisperCpp(cfg);
  if (engine === 'mlx-whisper') return detectPythonEngine('mlx-whisper', cfg.mlxWhisperBin, cfg.mlxWhisperModel);
  if (engine === 'faster-whisper') return detectPythonEngine('faster-whisper', cfg.fasterWhisperBin, cfg.fasterWhisperModel);
  if (engine !== 'auto') return { ok: false, engine: null, model: null, reason: 'unknown_engine' };

  for (const detector of [detectWhisperCpp, detectMlxWhisper, detectFasterWhisper]) {
    const detected = detector(cfg);
    if (detected.ok) return detected;
  }
  return { ok: false, engine: null, model: null, reason: 'local_transcription_engine_unavailable' };
}

function detectFakeEngine(cfg) {
  const executable = cfg.fakeAudioTranscribePath;
  if (!isSafeExecutable(executable, { allowBasename: false })) {
    return { ok: false, engine: null, model: null, reason: 'local_transcription_engine_unavailable' };
  }
  return { ok: true, engine: 'fake', model: 'fake', executable };
}

function detectWhisperCpp(cfg) {
  const executable = cfg.whisperCppPath || findCommand(['whisper-cli', 'whisper-cpp']);
  if (!isSafeExecutable(executable)) return { ok: false, engine: null, model: null, reason: 'local_transcription_engine_unavailable' };
  const model = cfg.whisperCppModel || cfg.audioTranscribeModelPath || '';
  if (!isSafeModelPath(model)) return { ok: false, engine: 'whisper.cpp', model: null, reason: 'local_model_missing' };
  return { ok: true, engine: 'whisper.cpp', model, executable };
}

function detectMlxWhisper(cfg) {
  return detectPythonEngine('mlx-whisper', cfg.mlxWhisperBin, cfg.mlxWhisperModel);
}

function detectFasterWhisper(cfg) {
  return detectPythonEngine('faster-whisper', cfg.fasterWhisperBin, cfg.fasterWhisperModel);
}

function detectPythonEngine(engine, bin, model) {
  const executable = bin || 'python';
  if (!isSafeExecutable(executable)) return { ok: false, engine: null, model: null, reason: 'local_transcription_engine_unavailable' };
  if (!isSafeModelPath(model)) return { ok: false, engine, model: null, reason: 'local_model_missing' };
  return { ok: true, engine, model, executable };
}

function commandForEngine(detected, file, cfg) {
  if (detected.engine === 'fake') {
    return { ok: true, file: detected.executable, args: [file] };
  }
  if (detected.engine === 'whisper.cpp') {
    return { ok: true, file: detected.executable, args: ['-m', detected.model, '-f', file, '-nt', ...languageArgs(cfg)] };
  }
  if (detected.engine === 'mlx-whisper') {
    return { ok: true, file: detected.executable, args: ['-m', 'mlx_whisper', file, '--model', detected.model, ...languageArgs(cfg, '--language')] };
  }
  if (detected.engine === 'faster-whisper') {
    return { ok: true, file: detected.executable, args: ['-m', 'faster_whisper', file, '--model', detected.model, ...languageArgs(cfg, '--language')] };
  }
  return { ok: false, reason: 'unknown_engine' };
}

function languageArgs(cfg, flag = '-l') {
  const language = String(cfg.audioTranscribeLanguage || '').trim();
  return language ? [flag, language] : [];
}

function validateInputFile(file, cfg) {
  if (!file || typeof file !== 'string') {
    return { ok: false, result: limited('audio_file_missing', '收到语音消息，但无法找到本地音频文件。') };
  }
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { ok: false, result: limited('audio_file_missing', '收到语音消息，但无法找到本地音频文件。') };
  }
  if (!stat.isFile()) {
    return { ok: false, result: limited('audio_file_invalid', '收到语音消息，但本地音频路径无效。') };
  }
  if ((stat.mode & 0o002) !== 0) {
    return { ok: false, result: limited('audio_file_world_writable', '语音消息已下载，但本地文件权限不安全。') };
  }
  const maxBytes = positiveInt(cfg.audioTranscribeMaxMb, 25) * 1024 * 1024;
  if (stat.size > maxBytes) {
    return { ok: false, result: limited('audio_too_large', userMessageForReason('audio_too_large')) };
  }
  return { ok: true };
}

function parseTranscriptOutput(stdout, engine) {
  const text = String(stdout || '').trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.text === 'string') return parsed.text.trim();
    if (typeof parsed.transcript === 'string') return parsed.transcript.trim();
  } catch {}
  if (engine === 'whisper.cpp') {
    return text.split(/\r?\n/).filter((line) => !/^\s*\[.*?-->/ .test(line)).join('\n').trim();
  }
  return text;
}

function skipped(reason, message, startedAt, now) {
  return {
    status: 'skipped',
    reason,
    userVisibleMessage: message,
    retryable: reason !== 'audio_transcription_disabled',
    elapsedMs: now() - startedAt,
  };
}

function limited(reason, message) {
  return {
    status: 'limited',
    reason,
    userVisibleMessage: message,
    retryable: false,
  };
}

export function userMessageForReason(reason) {
  const messages = {
    audio_transcription_disabled: '语音消息已下载，本地转写已关闭。',
    local_transcription_engine_unavailable: '语音消息已下载，但本地转写引擎不可用。请安装 whisper.cpp / mlx-whisper，或关闭转写。',
    local_model_missing: '语音消息已下载，但本地转写模型未配置或不存在。',
    transcription_timeout: '语音消息已下载，但本地转写超时。',
    audio_too_large: '语音消息已下载，但超过本地转写大小限制。',
    audio_too_long: '语音消息已下载，但超过本地转写时长限制。',
    download_failed: '收到语音消息，但附件下载失败：权限不足、资源过期或缺少 file_key。',
    key_missing: '收到语音消息，但无法从 Feishu 消息中取得 file_key。',
    transcoder_unavailable: '语音消息已下载，但缺少可用转码器。',
    transcription_failed: '语音消息已下载，但本地转写失败。',
    empty_transcript: '语音消息已下载，但本地转写结果为空。',
    unknown_engine: '语音消息已下载，但本地转写引擎配置无效。',
  };
  return messages[reason] || '语音消息已下载，但本地转写失败。';
}

function findCommand(names) {
  for (const name of names) {
    if (commandExists(name)) return name;
  }
  return '';
}

function commandExists(command) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 3000,
  });
  return result.status === 0;
}

function isSafeExecutable(value, options = {}) {
  if (!value || typeof value !== 'string') return false;
  if (SHELL_META.test(value)) return false;
  if (path.isAbsolute(value)) {
    try {
      const stat = fs.statSync(value);
      return stat.isFile() && (stat.mode & 0o002) === 0;
    } catch {
      return false;
    }
  }
  return options.allowBasename !== false && /^[A-Za-z0-9._-]+$/.test(value) && commandExists(value);
}

function isSafeModelPath(value) {
  if (!value || typeof value !== 'string') return false;
  if (SHELL_META.test(value)) return false;
  try {
    const stat = fs.statSync(value);
    return stat.isFile() && (stat.mode & 0o002) === 0;
  } catch {
    return false;
  }
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function minimalEnv() {
  return {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || '',
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
  };
}
