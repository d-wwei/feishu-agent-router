import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  detectAudioTranscriptionEngine,
  transcribeAudioFile,
} from '../lib/audio-transcribe.mjs';

test('transcribeAudioFile runs a fake local engine and parses JSON transcript', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-transcribe-'));
  const audio = path.join(tmp, 'voice.ogg');
  const engine = path.join(tmp, 'fake-asr');
  fs.writeFileSync(audio, 'not really audio', { mode: 0o600 });
  fs.writeFileSync(engine, '#!/bin/sh\nprintf \'{"text":"你好，Codex"}\\n\'\n', { mode: 0o700 });

  const result = transcribeAudioFile({
    file: audio,
    cfg: {
      audioTranscribe: 'local',
      audioTranscribeEngine: 'fake',
      fakeAudioTranscribePath: engine,
      audioTranscribeMaxMb: 25,
      audioTranscribeTimeoutMs: 5000,
    },
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.text, '你好，Codex');
  assert.equal(result.engine, 'fake');
  assert.equal(result.retryable, false);
});

test('transcribeAudioFile skips when no local engine is available', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-transcribe-'));
  const audio = path.join(tmp, 'voice.ogg');
  fs.writeFileSync(audio, 'not really audio', { mode: 0o600 });

  const result = transcribeAudioFile({
    file: audio,
    cfg: {
      audioTranscribe: 'local',
      audioTranscribeEngine: 'fake',
      fakeAudioTranscribePath: path.join(tmp, 'missing'),
    },
  });

  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'local_transcription_engine_unavailable');
  assert.match(result.userVisibleMessage, /本地转写引擎不可用/);
});

test('transcribeAudioFile rejects world-writable audio files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-transcribe-'));
  const audio = path.join(tmp, 'voice.ogg');
  fs.writeFileSync(audio, 'not really audio', { mode: 0o666 });
  fs.chmodSync(audio, 0o666);

  const result = transcribeAudioFile({
    file: audio,
    cfg: { audioTranscribe: 'local', audioTranscribeEngine: 'fake' },
  });

  assert.equal(result.status, 'limited');
  assert.equal(result.reason, 'audio_file_world_writable');
});

test('detectAudioTranscriptionEngine does not accept shell metacharacters', () => {
  const detected = detectAudioTranscriptionEngine({
    audioTranscribeEngine: 'fake',
    fakeAudioTranscribePath: '/tmp/fake; rm -rf /',
  });

  assert.equal(detected.ok, false);
});
