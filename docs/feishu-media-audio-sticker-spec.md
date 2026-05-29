# Feishu Media, Audio, And Sticker Ingestion Spec

## Objective

Make Feishu `media`, `audio`, and `sticker` messages first-class inbound
materials for the router: download what can be downloaded, transcribe audio by
default with local engines, pass useful context to Codex, and keep all raw media
inside private inbox storage.

Default audio transcription means: for messages that have already passed router
access policy, the router attempts local-only transcription automatically. It
does not mean using Feishu STT, hosted APIs, or blocking the router's event
consumer while transcription runs.

## Problem

The router currently handles `image`, `file`, `video`, `post`, and
`merge_forward`, but real Feishu video can arrive as top-level `media`, audio is
intentionally excluded from transcription, and stickers are not treated as
downloadable image-like resources. This creates inconsistent Feishu behavior:
ordinary file/image messages work, but video/audio/sticker messages degrade to
unsupported or placeholder text.

## Scope

In scope:

- Top-level inbound `media`, `audio`, and `sticker` messages.
- `media`, `audio`, and `sticker` children inside `merge_forward`.
- `post` media elements already parsed by `parsePostContent`, preserving the
  existing behavior while aligning message type names.
- Audio resource download and local transcription.
- Local ASR engine detection and execution.
- Inbox `manifest.json` fields for media download and transcription results.
- A non-blocking material-preparation job path for media that may take longer
  than ordinary text handling.
- Tests, docs, and real Feishu canary checklist updates.

Out of scope for this change:

- Feishu `speech_to_text/v1/speech/file_recognize`; current app lacks permission
  and this path should not be attempted.
- Cloud transcription by default.
- Sending media outbound.
- Full semantic handling of `interactive`, `share_chat`, `share_user`,
  `location`, or `system` messages beyond safe placeholders.
- Real-time streaming ASR while audio is still being recorded.

## Terminology

- `media`: Feishu top-level video-like message type. Resource download uses
  `type=file` through `+messages-resources-download`.
- `video`: Normalized router type for video-like resources. Existing API-facing
  resource type remains `file`.
- `audio`: Feishu voice/audio resource. Router downloads the file and attempts
  local transcription by default.
- `sticker`: Feishu sticker/emoji asset. Router treats it as an image-like
  resource when a key is available.
- `transcript`: Local ASR output text, attached to inbound content and manifest.
- `rawMessageType`: the original Feishu `msg_type` / `message_type`.
- `materialKind`: the router canonical material category used for placeholders,
  resource download, prompt construction, and manifest fields. Examples:
  `image`, `file`, `video`, `audio`, `sticker`.
- `promptText`: private text sent to Codex. It may include transcripts.
- `logPreview`: redacted structural text allowed in router logs and audit.
- `activePreview`: redacted structural text allowed in `active-turn.json`.

## Configuration

Defaults:

```env
FTB_AUDIO_DOWNLOAD=true
FTB_AUDIO_TRANSCRIBE=local
FTB_AUDIO_TRANSCRIBE_ENGINE=auto
FTB_AUDIO_TRANSCRIBE_MODEL=small
FTB_AUDIO_TRANSCRIBE_MAX_SECONDS=120
FTB_AUDIO_TRANSCRIBE_MAX_MB=25
FTB_AUDIO_TRANSCRIBE_TIMEOUT_MS=120000
FTB_AUDIO_TRANSCRIBE_LANGUAGE=auto
FTB_AUDIO_TRANSCRIBE_REQUIRE_LOCAL=true
FTB_AUDIO_TRANSCRIBE_SEND_TO_CODEX=true
FTB_AUDIO_TRANSCRIPT_IN_MANIFEST=false
FTB_AUDIO_TRANSCRIBE_QUEUE_MAX=4
FTB_AUDIO_TRANSCRIBE_CONCURRENCY=1
FTB_AUDIO_TRANSCRIBE_PER_SENDER_PER_HOUR=20
FTB_MEDIA_MAX_DOWNLOAD_MB=100
FTB_MEDIA_INBOX_MAX_MB=2048
```

Engine-specific optional configuration:

```env
FTB_WHISPER_CPP_PATH=whisper-cli
FTB_WHISPER_CPP_MODEL=
FTB_MLX_WHISPER_BIN=python
FTB_FASTER_WHISPER_BIN=python
FTB_MLX_WHISPER_MODEL=
FTB_FASTER_WHISPER_MODEL=
FTB_AUDIO_TRANSCODER=auto
```

Semantics:

- `FTB_AUDIO_DOWNLOAD=false` disables audio download and transcription.
- `FTB_AUDIO_TRANSCRIBE=off` downloads audio but does not transcribe.
- `FTB_AUDIO_TRANSCRIBE=local` uses local engines only.
- `FTB_AUDIO_TRANSCRIBE_SEND_TO_CODEX=false` records the transcript in private
  inbox artifacts but sends only an attachment summary to Codex.
- `FTB_AUDIO_TRANSCRIPT_IN_MANIFEST=false` means `manifest.json` stores
  transcript metadata and hash, while full text lives in `content.md` or
  `transcript.txt`.
- `FTB_AUDIO_TRANSCRIBE_ENGINE=auto` tries engines in order:
  1. `whisper.cpp` command
  2. `mlx-whisper`
  3. `faster-whisper`
- `FTB_AUDIO_TRANSCRIBE_REQUIRE_LOCAL=true` forbids network transcription. This
  also forbids automatic model downloads. This must remain the default.
- Startup config validation must reject unknown engines, `timeout=0`, negative
  limits, world-writable model paths, and non-local transcription settings unless
  a future explicit dangerous opt-in is added.

Configuration categories:

- Feature: `FTB_AUDIO_DOWNLOAD`, `FTB_AUDIO_TRANSCRIBE`,
  `FTB_AUDIO_TRANSCRIBE_SEND_TO_CODEX`.
- Engine selection: `FTB_AUDIO_TRANSCRIBE_ENGINE`.
- Engine adapters: `FTB_WHISPER_CPP_*`, `FTB_MLX_WHISPER_*`,
  `FTB_FASTER_WHISPER_*`.
- Limits: `FTB_AUDIO_TRANSCRIBE_MAX_*`, queue/concurrency/rate limits,
  download/inbox budgets.
- Privacy: `FTB_AUDIO_TRANSCRIBE_REQUIRE_LOCAL`,
  `FTB_AUDIO_TRANSCRIPT_IN_MANIFEST`.

## Processing Model

Text-like messages continue through the current fast path. Media messages use a
material-preparation path.

Required stages:

1. Access policy and dedupe pass.
2. Normalize/hydrate enough metadata to identify material kind and resource keys.
3. For `media`, `audio`, `sticker`, and merge-forward messages containing those
   children, create a material job outside the global event queue.
4. The event handler returns after enqueuing the material job and optional
   lightweight feedback; it must not wait for ASR.
5. The material job downloads resources, runs eligible transcription, writes
   private inbox artifacts, builds `promptText`, and then dispatches to the
   target session.
6. `/interrupt` and `/status` must remain queue-bypass commands while material
   jobs are running.

The material job queue must be bounded. If the queue is full, the router replies
with a safe diagnostic and does not start unbounded local work.

This design preserves the product behavior that audio is transcribed by default,
while preventing one long audio file from blocking event consumption or control
commands.

## Inbound Normalization

### Top-Level Message Types

Router-recognized raw message types become:

```text
text
post
image
file
video
media
audio
sticker
merge_forward
```

Normalization rules:

- `normalized.rawMessageType` is always the original Feishu type.
- `normalized.materialKind` is the canonical router kind.
- Existing `normalized.messageType` may remain the raw Feishu type for backward
  compatibility during migration, but new download/prompt code must use
  `materialKind`.
- `media` is normalized as video-like material:
  - user-facing placeholder: `[视频: <file_key>]` or `[视频]`
  - `materialKind = "video"`
  - `downloadPlans[].messageType = "video"`
  - `downloadPlans[].resourceType = "file"`
  - `rawMessageType = "media"` is retained in manifest.
- `video` keeps the same behavior as today.
- `audio`:
  - placeholder before transcript: `[语音: <file_key>]` or `[语音]`
  - `materialKind = "audio"`
  - `downloadPlans[].messageType = "audio"`
  - `downloadPlans[].resourceType = "file"`
  - if transcript succeeds and `FTB_AUDIO_TRANSCRIBE_SEND_TO_CODEX=true`,
    `promptText` includes:
    ```text
    [语音转写]
    <transcript>
    ```
  - if transcript fails but download succeeds, `promptText` includes an
    actionable diagnostic without failing the whole message.
- `sticker`:
  - if resource key exists, create a download plan:
    - `messageType = "sticker"`
    - `resourceType = "image"` when key looks like `img_*`
    - otherwise `resourceType = "file"`
  - placeholder: `[表情: <file_key>]` or `[表情]`
  - downloaded asset remains in `attachments/`.
  - If the first resource type fails and a second plausible type exists, retry
    once with the alternate type and record the fallback attempt.

### Resource Key Extraction

`extractAttachmentInfo()` should accept:

```text
image_key, file_key, video_key, media_key, sticker_key, key
imageKey, fileKey, videoKey, mediaKey, stickerKey
```

For XML/tag content, equivalent attribute names should be accepted.

It should return:

```json
{
  "fileKey": "file_xxx",
  "fileName": "optional.ext",
  "keyField": "file_key",
  "resourceTypeHint": "file"
}
```

`resourceTypeHint` prevents sticker/media handling from relying only on key
prefixes.

For top-level `media/audio/sticker` messages that arrive with rendered
human-readable `content` and no key, `hydrateAttachmentEvent()` must fetch
`GET /open-apis/im/v1/messages/{message_id}` and re-run normalization from
`body.content`.

### Merge-Forward Children

`parseMergeForwardItems()` must handle children:

- `media` and `video`: `[视频: key]`, create video download plan.
- `audio`: `[语音: key]`; create audio download plan and mark it
  `transcriptionEligible=true` with `origin="merge_forward"`.
- `sticker`: `[表情: key]`; create sticker download plan.

Merge-forward audio uses the same material job pipeline as top-level audio. If
local resource protection limits prevent transcription from running or
completing within queue, concurrency, size, duration, timeout, or rate limits,
the prompt must include a skipped diagnostic for that child and the manifest
must record the reason. It must not silently degrade to a plain placeholder.

If key extraction fails, keep a placeholder and add a child-level unsupported
reason in manifest without blocking text parsing.

## Download Behavior

Download plans:

| Router messageType | Feishu resource type | Notes |
| --- | --- | --- |
| image | image | Existing behavior |
| file | file | Existing behavior |
| video | file | Includes top-level `media` normalized to video |
| audio | file | Download before transcription |
| sticker | image or file | Prefer image for `img_*`; otherwise file |

`+messages-resources-download` remains the download mechanism.

Failure behavior:

- Download failures are recorded in `manifest.downloadErrors`.
- If audio download fails, transcription is skipped and the Codex prompt receives
  an actionable failure note.
- Download failures never leave the user without feedback. If the message has no
  useful text and no artifact, the router still routes or replies with a safe
  diagnostic such as `[语音消息下载失败：权限不足或资源已过期]`.

Download result contract:

```json
{
  "plan": {},
  "status": 0,
  "relativePath": "attachments/audio-file_xxx.ogg",
  "localPath": "/private/.../attachments/audio-file_xxx.ogg",
  "bytes": 12345,
  "contentType": "audio/ogg"
}
```

`localPath` is required before transcription. It must point inside the private
inbox entry, exist, be a regular file, and not be world-writable.

## Audio Transcription

### Default

Audio transcription is enabled by default for allowed top-level audio messages
after a successful download, bounded by size and duration limits. Merge-forward
audio is also transcribed by default, but runs inside the bounded material job
and may be reported as skipped if local resource protection limits prevent
execution.

Transcription must not run synchronously inside the global event queue. It runs
inside a bounded material job queue. The job produces `promptText` after
transcription succeeds/fails/skips, then dispatches to Codex.

If no local ASR engine is available:

- The audio file remains downloaded.
- The transcript result is marked `skipped`.
- The Codex prompt says:
  ```text
  [语音消息已下载，但本地转写引擎不可用]
  ```

### Engine Detection

Engine auto-detection order:

1. `whisper.cpp`
   - command candidates:
     - `FTB_WHISPER_CPP_PATH`
     - `whisper-cli`
     - `whisper-cpp`
     - `main` only if explicitly configured
   - model path:
     - `FTB_WHISPER_CPP_MODEL`
     - common local model paths may be detected only if safe and deterministic.
2. `mlx-whisper`
   - executable from `FTB_MLX_WHISPER_BIN`
   - only considered on Apple Silicon/macOS unless explicitly configured.
   - must use a local model path or cache-only/offline mode.
3. `faster-whisper`
   - executable from `FTB_FASTER_WHISPER_BIN`
   - fallback when Python environment is available.
   - must use a local model path or cache-only/offline mode.

Do not call hosted APIs or auto-download models. If a model is missing locally,
the engine is skipped.

### Engine Adapter Contract

Create `lib/audio-transcribe.mjs` with an adapter registry. Ingestion/download
code must not know engine-specific details.

Public API:

```js
detectAudioTranscriptionEngine(cfg) -> {
  ok: boolean,
  engine: 'whisper.cpp' | 'mlx-whisper' | 'faster-whisper' | null,
  model: string | null,
  reason?: string
}

transcribeAudioFile({
  file,
  cfg,
  signal,
  now
}) -> {
  status: 'ok' | 'skipped' | 'failed' | 'timeout' | 'limited',
  text?: string,
  engine?: string,
  model?: string,
  elapsedMs?: number,
  reason?: string,
  userVisibleMessage: string,
  retryable: boolean
}
```

Adapter rules:

- Use `spawn(file, args)` or `spawnSync(file, args)`, never shell strings.
- Reject shell metacharacters in configured executable paths.
- Allow only trusted absolute paths or known basename commands resolved through
  a controlled PATH.
- Do not pass the full application environment to child processes; pass a
  minimal env.
- Do not log raw stdout/stderr. Parse known output formats and map failures to
  safe reason codes.
- Timeout must kill the whole child process tree when possible.
- Fake-engine protocol for tests:
  ```json
  {"text":"hello","language":"zh","duration":1.2}
  ```

### Transcoding

Transcoding is allowed as preprocessing:

- Try the ASR engine directly first when it accepts the downloaded file.
- If unsupported, use `FTB_AUDIO_TRANSCODER` or auto-detect:
  1. `ffmpeg`
  2. `/opt/homebrew/bin/ffmpeg`
  3. `/usr/bin/afconvert`
- Transcode to WAV/PCM only in a private temp directory.
- Delete temp files in `finally`.
- Temp dirs use `mkdtemp` + `0700`; temp files use `0600`.
- Use random names, never user-provided file names directly.
- Do not log temp paths.
- On exception, timeout, or SIGTERM, perform best-effort cleanup of all
  intermediate files.

### Limits

Before transcription:

- Reject or skip transcription when file size exceeds
  `FTB_AUDIO_TRANSCRIBE_MAX_MB`.
- If duration can be determined cheaply, skip transcription above
  `FTB_AUDIO_TRANSCRIBE_MAX_SECONDS`.
- Always enforce `FTB_AUDIO_TRANSCRIBE_TIMEOUT_MS`.
- Queue length must not exceed `FTB_AUDIO_TRANSCRIBE_QUEUE_MAX`.
- Concurrency must not exceed `FTB_AUDIO_TRANSCRIBE_CONCURRENCY`.
- Enforce per-sender/per-chat rate limits.
- Check available inbox disk budget before download and transcription.
- Enforce download Content-Length where available before saving large resources.
- Enforce transcoded output max bytes to prevent expansion attacks.
- Failed transcription should apply short backoff per sender/chat.

### Manifest Shape

Add `transcriptions` to `manifest.json`:

```json
{
  "transcriptions": [
    {
      "messageId": "om_xxx",
      "fileKey": "file_xxx",
      "engine": "whisper.cpp",
      "model": "small",
      "status": "ok",
      "textSha256": "hex",
      "textLength": 120,
      "transcriptPath": "transcript.txt",
      "userVisibleMessage": "转写完成",
      "retryable": false,
      "elapsedMs": 1234
    }
  ],
  "transcriptionErrors": [
    {
      "messageId": "om_xxx",
      "fileKey": "file_xxx",
      "status": "skipped",
      "reason": "local_transcription_engine_unavailable",
      "userVisibleMessage": "语音消息已下载，但本地转写引擎不可用",
      "retryable": true
    }
  ]
}
```

Transcript text is sensitive. Store full transcript text in `content.md` and/or
`transcript.txt`, not in `manifest.json` by default. `manifest.json` stores
metadata, hash, length, engine, and paths. Do not write full transcripts to
`router.log`, `audit.jsonl`, `active-turn.json`, test snapshots, child process
errors, or debug dumps.

## Content Channels

Implementation must keep separate content channels:

```js
normalized.promptText       // private, can include transcript; sent to Codex
normalized.privateContent   // private, written to inbox content.md
normalized.logPreview       // redacted, for router.log/audit
normalized.activePreview    // redacted, for active-turn.json
```

`normalized.text` remains a legacy compatibility field and must not be used as
the source for logs/previews once transcript support lands.

For audio:

- `promptText` may contain transcript when configured.
- `privateContent` contains transcript and local material summary.
- `logPreview` / `activePreview` contain only:
  ```text
  [audio] status=<ok|skipped|failed> download=<ok|failed> transcript=<ok|skipped|failed>
  ```

## Codex Prompt Behavior

For successful audio transcription:

```text
[语音转写]
...

本地附件目录：...
```

For skipped/failed transcription:

```text
[语音消息已下载，但本地转写失败：本地转写引擎不可用]
本地附件目录：...
```

Required safe user-visible messages:

| Condition | Message |
| --- | --- |
| Engine unavailable | `语音消息已下载，但本地转写引擎不可用。请安装 whisper.cpp / mlx-whisper，或关闭转写。` |
| Model missing | `语音消息已下载，但本地转写模型未配置或不存在。` |
| Timeout | `语音消息已下载，但本地转写超时。` |
| Too large | `语音消息已下载，但超过本地转写大小限制。` |
| Too long | `语音消息已下载，但超过本地转写时长限制。` |
| Download failed | `收到语音消息，但附件下载失败：权限不足、资源过期或缺少 file_key。` |
| Key missing | `收到语音消息，但无法从 Feishu 消息中取得 file_key。` |
| Transcoder unavailable | `语音消息已下载，但缺少可用转码器。` |
| Disabled | `语音消息已下载，本地转写已关闭。` |

These messages may be localized later, but tests should assert stable reason
codes rather than exact prose where possible.

For sticker/video/media:

- Pass the inbox directory and manifest path as today.
- Do not inline binary content.

## Privacy And Security

- No cloud transcription unless a future explicit setting is introduced.
- No Feishu STT calls in this implementation.
- No automatic model downloads. Local mode means existing local model files only.
- Temp audio files must be created under a private temp directory and removed.
- `router.log`, `audit.jsonl`, and `active-turn.json` must contain only
  structural summaries for media/audio/sticker, not transcripts or raw message
  bodies.
- Inbox remains the intended durable sensitive artifact store with `0700/0600`.
- Safe reason strings must be enumerated. Do not pass raw child process stderr,
  raw stdout, full file paths, transcript text, or raw Feishu message bodies into
  user-visible errors or logs.

## Implementation Plan

1. Extend message type constants and introduce `rawMessageType` /
   `materialKind`.
2. Add `media`, `audio`, and `sticker` top-level handling.
3. Extend attachment hydration to include `media/audio/sticker`.
4. Extend merge-forward child parsing for `media/audio/sticker`, including
   transcription eligibility metadata.
5. Split material handling into modules:
   - normalize/hydrate keys: pure parsing.
   - download resources: saves files and returns `localPath` / `relativePath`.
   - audio transcribe: reads local file and returns structured result.
   - bridge orchestration: queues material jobs, builds prompt/private/log
     content channels, dispatches to Codex.
6. Add `lib/audio-transcribe.mjs` with the adapter contract above.
7. Add bounded material job queue outside the global event queue.
8. Update README and `test/REAL_FEISHU_CANARY.md`.
9. Add unit, integration, and fake-engine tests.

## Acceptance Criteria

- Top-level `media` messages create a video download plan and no longer produce
  `unsupported message_type: media`.
- Top-level `audio` messages download the audio file and attempt local
  transcription by default.
- If no local ASR engine exists, audio still downloads and routing continues
  with a safe diagnostic.
- Top-level `sticker` messages download image-like resources when a key is
  available.
- Merge-forward `media/audio/sticker` children produce meaningful placeholders,
  download plans, and either transcripts or explicit skipped/failed transcript
  diagnostics for audio children.
- No transcript or child message body appears in `router.log`, `audit.jsonl`, or
  `active-turn.json`.
- Material jobs do not block the global event queue; `/interrupt` and `/status`
  continue to respond during audio transcription.
- `npm test`, `npm run check`, and `git diff --check` pass.
- Real Feishu canary includes `media`, `audio`, and `sticker` cases.

## Test Plan

Unit tests:

- `normalizeInboundEvent` supports top-level `media`.
- `hydrateAttachmentEvent` fetches raw content for `media/audio/sticker`.
- `parseMergeForwardItems` handles `media/audio/sticker`.
- `buildLarkCliResourceDownloadArgs` uses resource type `file` for media/audio.
- Sticker with `img_*` uses resource type `image`.
- Audio transcription success with a fake local engine.
- Audio transcription skip when no engine is available.
- Audio transcription timeout/size-limit behavior.
- Logs/previews redact transcript text.
- Command injection strings are rejected.
- World-writable model paths are rejected.
- Missing model does not trigger network download.
- Child process stderr/stdout does not enter logs or user-visible text.
- Timeout kills the transcriber process.
- Temp files are removed after success, failure, and timeout.
- Queue limit and per-sender/per-chat rate limit are enforced.

Integration tests:

- Fake `lark-cli` event for audio -> resource download -> fake ASR transcript ->
  reply path.
- Fake `lark-cli` event for media -> download plan -> inbox manifest.
- Fake long-running ASR job -> `/interrupt` and `/status` still respond.

Real Feishu canary:

- Send video/media.
- Send audio and verify transcript.
- Send audio with no local engine configured and verify skipped diagnostic still
  routes.
- Send sticker/gif.
- Send merge-forward containing video/audio/sticker.
- Confirm transcript text is absent from `router.log`, `audit.jsonl`, and
  `active-turn.json`.

## Decided Design Choices

- Default engine order is `whisper.cpp -> mlx-whisper -> faster-whisper`.
  Rationale: the repository may be shared with Windows users, so cross-platform
  stability comes before Apple-Silicon-specific performance.
- Model paths may be detected when detection is safe and deterministic. Explicit
  configuration is not required for every installation, but network model
  download is forbidden.
- Full transcript text is not written to `manifest.json` by default. It is
  written to `content.md` or `transcript.txt`; the manifest stores hash, length,
  engine, model, status, and path metadata.
- Merge-forward audio is transcribed by default. If local resource protection
  limits prevent execution, skipped/failed diagnostics are required.

## Remaining Decisions

The remaining discussion is about concrete defaults for local resource
protection limits:

- `FTB_AUDIO_TRANSCRIBE_MAX_SECONDS=120`
- `FTB_AUDIO_TRANSCRIBE_MAX_MB=25`
- `FTB_AUDIO_TRANSCRIBE_TIMEOUT_MS=120000`
- `FTB_AUDIO_TRANSCRIBE_QUEUE_MAX=4`
- `FTB_AUDIO_TRANSCRIBE_CONCURRENCY=1`
- `FTB_AUDIO_TRANSCRIBE_PER_SENDER_PER_HOUR=20`
- `FTB_MEDIA_MAX_DOWNLOAD_MB=100`
- `FTB_MEDIA_INBOX_MAX_MB=2048`
