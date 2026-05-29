# 飞书 Media / Audio / Sticker 入站处理实现规格

## 目标

让飞书 `media`、`audio`、`sticker` 成为 router 的一等入站材料：
能下载的资源要下载；语音默认走本地转写；Codex 能拿到可用上下文；
原始媒体、转写文本和诊断材料只落在私有 inbox 中。

这里的“默认转写”含义是：消息已经通过 router allowlist 之后，router
会自动尝试本地转写。它不代表调用飞书 STT，不代表调用云端 API，也不
允许把 router 的事件消费主循环卡在转写过程里。

## 背景问题

当前 router 已支持 `image`、`file`、`video`、`post`、`merge_forward`。
但真实飞书视频可能以顶层 `media` 类型到达；`audio` 当前被明确排除转
写；`sticker` 也没有按图片类资源下载。因此用户侧会看到：

- 普通文件/图片正常。
- 视频可能显示为“不支持的飞书消息类型：media”。
- 语音无法像文本一样驱动 Codex。
- 表情/动图只能占位，不能作为材料保存。

## 范围

包含：

- 顶层 `media`、`audio`、`sticker` 消息。
- `merge_forward` 子消息中的 `media`、`audio`、`sticker`。
- `post` 里的 media 元素继续沿用现有解析，但消息类型命名要统一。
- 音频资源下载和本地转写。
- 本地 ASR 引擎发现、调用和错误归一。
- inbox `manifest.json` 中记录下载、转写状态。
- 非阻塞 material job 队列，用于处理耗时媒体材料。
- 单元测试、集成测试、真实飞书 canary 清单更新。

不包含：

- 飞书 `speech_to_text/v1/speech/file_recognize`，当前应用没有权限，本实现不得尝试调用。
- 默认云端转写。
- 出站发送媒体。
- 对 `interactive`、`share_chat`、`share_user`、`location`、`system`
  等非文件类消息做完整语义处理；最多提供安全占位。
- 边录边转写的实时流式 ASR。

## 术语

- `media`：飞书顶层视频类消息。资源下载实际走 `type=file`。
- `video`：router 里的视频类材料类型。对 API 下载仍然是 `file`。
- `audio`：飞书语音/音频资源。router 下载后默认尝试本地转写。
- `sticker`：飞书表情/贴纸资源。能拿到 key 时按图片类资源处理。
- `transcript`：本地 ASR 生成的转写文本。
- `rawMessageType`：飞书原始 `msg_type` / `message_type`。
- `materialKind`：router 归一后的材料类型，例如 `image`、`file`、
  `video`、`audio`、`sticker`。
- `promptText`：私有内容，可包含 transcript，用于发给 Codex。
- `privateContent`：私有内容，写入 inbox。
- `logPreview`：脱敏结构摘要，只能写入 `router.log` / `audit.jsonl`。
- `activePreview`：脱敏结构摘要，只能写入 `active-turn.json`。

## 配置

默认配置：

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

引擎相关配置：

```env
FTB_WHISPER_CPP_PATH=whisper-cli
FTB_WHISPER_CPP_MODEL=
FTB_MLX_WHISPER_BIN=python
FTB_FASTER_WHISPER_BIN=python
FTB_MLX_WHISPER_MODEL=
FTB_FASTER_WHISPER_MODEL=
FTB_AUDIO_TRANSCODER=auto
```

语义：

- `FTB_AUDIO_DOWNLOAD=false`：不下载 audio，也不转写。
- `FTB_AUDIO_TRANSCRIBE=off`：下载 audio，但不转写。
- `FTB_AUDIO_TRANSCRIBE=local`：只使用本地转写引擎。
- `FTB_AUDIO_TRANSCRIBE_SEND_TO_CODEX=false`：转写文本写入私有 inbox，
  但发给 Codex 的 prompt 只包含附件摘要。
- `FTB_AUDIO_TRANSCRIPT_IN_MANIFEST=false`：`manifest.json` 只保存
  transcript 元数据和 hash，全文放在 `content.md` 或 `transcript.txt`。
- `FTB_AUDIO_TRANSCRIBE_ENGINE=auto`：按顺序尝试：
  1. `whisper.cpp`
  2. `mlx-whisper`
  3. `faster-whisper`
- `FTB_AUDIO_TRANSCRIBE_REQUIRE_LOCAL=true`：禁止网络转写，也禁止自动下
  载模型。模型不存在时跳过转写。

启动时配置校验必须拒绝：

- 未知 ASR engine。
- `timeout=0` 或负数限制。
- world-writable 模型路径。
- 非本地转写配置，除非未来新增显式危险开关。

## 处理模型

文本类消息继续走当前 fast path。媒体类消息走 material-preparation path。

阶段：

1. 通过 access policy 和 dedupe。
2. 归一化/补取足够元数据，识别 `materialKind` 和资源 key。
3. 对 `media`、`audio`、`sticker`，以及包含这些子消息的
   `merge_forward`，创建 material job。
4. 事件处理函数只负责入队和轻量反馈，不等待 ASR。
5. material job 下载资源、执行符合条件的转写、写私有 inbox、生成
   `promptText`，再投递给目标 session。
6. material job 运行期间，`/interrupt` 和 `/status` 必须仍可旁路响应。

material job 队列必须有界。队列满时，router 返回安全诊断，不启动无界
本地工作。

这样既满足“语音默认转写”的产品体验，也避免一条长语音阻塞飞书事件消费
和控制命令。

## 入站归一化

router 识别的原始消息类型：

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

归一化规则：

- `normalized.rawMessageType` 始终保存飞书原始类型。
- `normalized.materialKind` 保存 router 归一后的材料类型。
- 迁移期内 `normalized.messageType` 可继续保存原始类型，但新的下载、
  prompt、manifest 逻辑必须使用 `materialKind`。
- `media` 归一为视频类材料：
  - 占位：`[视频: <file_key>]` 或 `[视频]`
  - `materialKind = "video"`
  - `downloadPlans[].messageType = "video"`
  - `downloadPlans[].resourceType = "file"`
  - manifest 保留 `rawMessageType = "media"`
- `audio`：
  - 占位：`[语音: <file_key>]` 或 `[语音]`
  - `materialKind = "audio"`
  - `downloadPlans[].messageType = "audio"`
  - `downloadPlans[].resourceType = "file"`
  - 转写成功且 `FTB_AUDIO_TRANSCRIBE_SEND_TO_CODEX=true` 时，
    `promptText` 包含：
    ```text
    [语音转写]
    <transcript>
    ```
  - 转写失败但下载成功时，`promptText` 包含可操作诊断，不让整条消息失败。
- `sticker`：
  - 能提取 key 时生成下载计划。
  - `messageType = "sticker"`。
  - key 明确是 `img_*` 或 `resourceTypeHint=image` 时用 `resourceType=image`，
    否则用 `file`。
  - 占位：`[表情: <file_key>]` 或 `[表情]`。
  - 如果首选 resource type 下载失败，且存在另一个合理类型，允许重试一次，
    并记录 fallback。

## 资源 key 提取

`extractAttachmentInfo()` 支持：

```text
image_key, file_key, video_key, media_key, sticker_key, key
imageKey, fileKey, videoKey, mediaKey, stickerKey
```

XML/tag 内容支持对应属性名。

返回结构：

```json
{
  "fileKey": "file_xxx",
  "fileName": "optional.ext",
  "keyField": "file_key",
  "resourceTypeHint": "file"
}
```

`resourceTypeHint` 用于避免 sticker/media 只靠 key 前缀猜测。

当顶层 `media/audio/sticker` 的 event content 是 lark-cli 渲染文本且不含
key 时，`hydrateAttachmentEvent()` 必须调用：

```text
GET /open-apis/im/v1/messages/{message_id}
```

然后用返回的 `body.content` 重新归一化。

## 合并转发子消息

`parseMergeForwardItems()` 必须支持：

- `media` / `video`：占位 `[视频: key]`，生成 video download plan。
- `audio`：占位 `[语音: key]`，生成 audio download plan，并标记：
  - `transcriptionEligible=true`
  - `origin="merge_forward"`
- `sticker`：占位 `[表情: key]`，生成 sticker download plan。

合并转发中的 audio 也进入同一套 material job pipeline。若受本地资源保护
限制（队列长度、并发、大小、时长、超时、限流）无法完成转写，prompt 必须
包含 skipped 诊断，manifest 必须记录原因；不能静默退化为普通占位。

key 提取失败时保留占位，并在 manifest 中记录 child-level unsupported
reason，不影响其他子消息解析。

## 下载行为

| materialKind | Feishu resource type | 说明 |
| --- | --- | --- |
| image | image | 现有行为 |
| file | file | 现有行为 |
| video | file | 包含顶层 `media` |
| audio | file | 先下载，再转写 |
| sticker | image 或 file | 优先依据 `resourceTypeHint`，再依据 key |

下载仍使用：

```text
lark-cli im +messages-resources-download
```

失败行为：

- 下载失败写入 `manifest.downloadErrors`。
- audio 下载失败时跳过转写，并给 Codex 一个安全诊断。
- 下载失败也不能让用户没有反馈；即使没有文本和附件，也要路由或回复
  类似：
  ```text
  [语音消息下载失败：权限不足或资源已过期]
  ```

下载结果契约：

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

转写前必须确认：

- `localPath` 在当前私有 inbox entry 内。
- 文件存在。
- 是 regular file。
- 不可 world-writable。
- 大小符合限制。

## 音频转写

### 默认行为

audio 下载成功后默认尝试本地转写。合并转发里的 audio 也默认转写，但运行
在 bounded material job 内；若受本地资源保护限制无法执行，必须记录
skipped 诊断。

转写不得同步跑在全局事件队列里。它必须在 bounded material job queue 中
执行。job 在转写成功/失败/跳过后生成 `promptText`，再投递给 Codex。

没有本地 ASR 引擎时：

- 音频文件仍保存在 inbox。
- 转写状态为 `skipped`。
- Codex prompt 包含：
  ```text
  [语音消息已下载，但本地转写引擎不可用]
  ```

### 引擎选择

`auto` 顺序：

1. `whisper.cpp`
   - 命令候选：
     - `FTB_WHISPER_CPP_PATH`
     - `whisper-cli`
     - `whisper-cpp`
     - `main` 仅在显式配置时允许
   - 模型路径：
     - `FTB_WHISPER_CPP_MODEL`
     - 可检测常见本地路径，但必须安全且确定。
2. `mlx-whisper`
   - 执行文件来自 `FTB_MLX_WHISPER_BIN`
   - 默认仅在 macOS Apple Silicon 上考虑。
   - 必须使用本地模型路径或 cache-only/offline 模式。
3. `faster-whisper`
   - 执行文件来自 `FTB_FASTER_WHISPER_BIN`
   - Python 环境可用时作为 fallback。
   - 必须使用本地模型路径或 cache-only/offline 模式。

不得调用云端 API，不得自动下载模型。模型本地不存在时跳过对应 engine。

### `lib/audio-transcribe.mjs` 接口

新增 adapter registry，ingest/download 层不得知道引擎细节。

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

adapter 规则：

- 只能用 `spawn(file, args)` 或 `spawnSync(file, args)`，禁止 shell string。
- 配置的可执行路径中出现 shell metachar 必须拒绝。
- 默认只允许可信绝对路径或白名单 basename。
- 子进程只能拿最小环境变量集合。
- 不记录 raw stdout/stderr。
- 只解析已知输出格式，并映射为安全 reason code。
- timeout 时尽可能 kill 整个子进程树。
- fake engine 测试协议：
  ```json
  {"text":"hello","language":"zh","duration":1.2}
  ```

### 转码

转码只做预处理：

- ASR 引擎能直接吃原文件时，不转码。
- 不支持原格式时，用 `FTB_AUDIO_TRANSCODER` 或自动检测：
  1. `ffmpeg`
  2. `/opt/homebrew/bin/ffmpeg`
  3. `/usr/bin/afconvert`
- 只在私有临时目录中转成 WAV/PCM。
- temp dir 使用 `mkdtemp` + `0700`。
- temp file 使用 `0600`。
- 文件名随机生成，不直接使用用户输入。
- 不把 temp path 写入日志。
- 成功、失败、timeout、SIGTERM 时都 best-effort 清理中间文件。

### 资源限制

转写前必须检查：

- 文件大小不超过 `FTB_AUDIO_TRANSCRIBE_MAX_MB`。
- 如果能低成本获取时长，时长不超过 `FTB_AUDIO_TRANSCRIBE_MAX_SECONDS`。
- 总耗时不超过 `FTB_AUDIO_TRANSCRIBE_TIMEOUT_MS`。
- 队列长度不超过 `FTB_AUDIO_TRANSCRIBE_QUEUE_MAX`。
- 并发不超过 `FTB_AUDIO_TRANSCRIBE_CONCURRENCY`。
- 每 sender/chat 有速率限制。
- 下载前检查 Content-Length。
- 检查 inbox 总磁盘预算。
- 限制转码后输出大小，防止膨胀攻击。
- 失败后对 sender/chat 做短退避。

## Manifest

新增 `transcriptions`：

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

默认不在 `manifest.json` 中存全文 transcript。全文放：

- `content.md`
- 或单独 `transcript.txt`

manifest 保存 hash、长度、engine、model、状态和路径。

## 内容通道

实现必须拆开内容通道：

```js
normalized.promptText       // 私有，可包含 transcript，发送给 Codex
normalized.privateContent   // 私有，写入 inbox content.md
normalized.logPreview       // 脱敏，只写 router.log/audit
normalized.activePreview    // 脱敏，只写 active-turn.json
```

`normalized.text` 是兼容旧字段。转写支持落地后，日志和 active-turn 不得再
直接使用 `normalized.text`。

audio 的要求：

- `promptText` 可按配置包含 transcript。
- `privateContent` 包含 transcript 和本地材料摘要。
- `logPreview` / `activePreview` 只能包含：
  ```text
  [audio] status=<ok|skipped|failed> download=<ok|failed> transcript=<ok|skipped|failed>
  ```

## Codex Prompt 行为

转写成功：

```text
[语音转写]
...

本地附件目录：...
```

转写跳过/失败：

```text
[语音消息已下载，但本地转写失败：本地转写引擎不可用]
本地附件目录：...
```

视频、sticker、文件类材料：

- 传 inbox 目录和 manifest 路径。
- 不 inline 二进制内容。

必须支持的用户可见诊断：

| 条件 | 文案 |
| --- | --- |
| 本地引擎不可用 | `语音消息已下载，但本地转写引擎不可用。请安装 whisper.cpp / mlx-whisper，或关闭转写。` |
| 模型缺失 | `语音消息已下载，但本地转写模型未配置或不存在。` |
| 超时 | `语音消息已下载，但本地转写超时。` |
| 文件过大 | `语音消息已下载，但超过本地转写大小限制。` |
| 时长过长 | `语音消息已下载，但超过本地转写时长限制。` |
| 下载失败 | `收到语音消息，但附件下载失败：权限不足、资源过期或缺少 file_key。` |
| 缺 key | `收到语音消息，但无法从 Feishu 消息中取得 file_key。` |
| 缺转码器 | `语音消息已下载，但缺少可用转码器。` |
| 转写关闭 | `语音消息已下载，本地转写已关闭。` |

测试应优先断言稳定 reason code，而不是完整自然语言。

## 隐私与安全

- 不调用云端转写，除非未来新增明确危险开关。
- 不调用飞书 STT。
- 不自动下载模型。
- temp 音频文件必须在私有目录中创建并清理。
- `router.log`、`audit.jsonl`、`active-turn.json` 只能包含结构摘要，不得包
  含 transcript、原始 message body、子进程 stdout/stderr。
- inbox 是唯一持久敏感材料存储区，权限保持 `0700/0600`。
- 错误 reason 必须枚举化；不能把子进程 stderr、stdout、完整路径、
  transcript 或飞书原始 body 透传到用户或日志。

## 实现计划

1. 扩展消息类型常量，引入 `rawMessageType` / `materialKind`。
2. 支持顶层 `media`、`audio`、`sticker`。
3. 扩展 attachment hydration，覆盖 `media/audio/sticker`。
4. 扩展 merge-forward 子消息解析，覆盖 `media/audio/sticker` 和
   transcription eligibility。
5. 拆模块：
   - normalize/hydrate keys：纯解析。
   - download resources：落盘并返回 `localPath` / `relativePath`。
   - audio-transcribe：读取本地文件，返回结构化转写结果。
   - bridge orchestration：排 material job，构建 prompt/private/log 内容通道，投递 Codex。
6. 新增 `lib/audio-transcribe.mjs`。
7. 新增 bounded material job queue。
8. 更新 README 和 `test/REAL_FEISHU_CANARY.md`。
9. 增加单元测试、集成测试和 fake-engine 测试。

## 验收标准

- 顶层 `media` 生成 video download plan，不再产生
  `unsupported message_type: media`。
- 顶层 `audio` 下载音频，并默认尝试本地转写。
- 无本地 ASR 引擎时，audio 仍下载，继续路由，并给安全诊断。
- 顶层 `sticker` 能在 key 可用时下载图片/动图资源。
- merge-forward 中的 `media/audio/sticker` 有占位、download plan，并且
  audio 有 transcript 或 skipped/failed 诊断。
- transcript 和子消息正文不出现在 `router.log`、`audit.jsonl`、
  `active-turn.json`。
- material job 不阻塞全局事件队列；转写期间 `/interrupt`、`/status` 可响应。
- `npm test`、`npm run check`、`git diff --check` 通过。
- 真实飞书 canary 覆盖 `media`、`audio`、`sticker`。

## 测试计划

单元测试：

- `normalizeInboundEvent` 支持顶层 `media`。
- `hydrateAttachmentEvent` 能为 `media/audio/sticker` 补取 raw content。
- `parseMergeForwardItems` 支持 `media/audio/sticker`。
- `buildLarkCliResourceDownloadArgs` 对 media/audio 使用 `resourceType=file`。
- sticker 的 `img_*` 使用 `resourceType=image`。
- fake local engine 转写成功。
- 无 engine 时转写 skipped。
- timeout / size limit。
- transcript 不进入 log/active preview。
- 命令注入字符串被拒绝。
- world-writable 模型路径被拒绝。
- 模型缺失不联网。
- 子进程 stderr/stdout 不进日志和用户文案。
- timeout 会 kill 子进程。
- temp 文件成功/失败/timeout 后被清理。
- 队列限制和 sender/chat 限流。

集成测试：

- fake `lark-cli` audio event -> resource download -> fake ASR transcript -> reply。
- fake `lark-cli` media event -> download plan -> inbox manifest。
- fake long-running ASR job -> `/interrupt` 和 `/status` 仍响应。

真实飞书 canary：

- 发送 video/media。
- 发送 audio，确认 transcript 或 skipped 诊断。
- 无本地 engine 时发送 audio，确认仍继续路由。
- 发送 sticker/gif。
- 发送包含 video/audio/sticker 的 merge-forward。
- 确认 transcript 不在 `router.log`、`audit.jsonl`、`active-turn.json`。

## 已定设计决策

1. 默认 engine 顺序固定为 `whisper.cpp -> mlx-whisper -> faster-whisper`。
   理由：这个仓库可能分享给 Windows 用户，跨平台和 daemon 稳定性优先。
2. 模型路径允许安全、确定的本地路径检测；不要求全部显式配置，但严禁联网
   下载模型。
3. transcript 全文默认不写入 `manifest.json`，只写入 `content.md` 或
   `transcript.txt`。manifest 只保存 hash、长度、engine、model、状态和路径。
4. merge-forward audio 默认转写。若受本地资源保护限制无法执行，必须记录
   skipped/failed 诊断，不能静默占位。

## 待讨论决策

目前剩余需要讨论的是这些“本地资源保护限制”的具体默认值是否合适：

- `FTB_AUDIO_TRANSCRIBE_MAX_SECONDS=120`
- `FTB_AUDIO_TRANSCRIBE_MAX_MB=25`
- `FTB_AUDIO_TRANSCRIBE_TIMEOUT_MS=120000`
- `FTB_AUDIO_TRANSCRIBE_QUEUE_MAX=4`
- `FTB_AUDIO_TRANSCRIBE_CONCURRENCY=1`
- `FTB_AUDIO_TRANSCRIBE_PER_SENDER_PER_HOUR=20`
- `FTB_MEDIA_MAX_DOWNLOAD_MB=100`
- `FTB_MEDIA_INBOX_MAX_MB=2048`
