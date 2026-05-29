# Feishu Agent Router 审计后续优化清单

日期：2026-05-29

本文沉淀多角色审计后未在本轮直接吸收的优化项。本轮已经修复了 sender allowlist、跨 session 命令权限、普通消息结构化日志、业务卡片投影、音频下载/转写开关、`lark-cli` 超时和基础 parser 上限。以下事项仍建议后续按优先级拆分实现。

## P0/P1：可靠性与执行隔离

### 1. 外部命令全面异步化和 worker 隔离

当前已为同步 `lark-cli` 调用增加 `FTB_LARK_CLI_TIMEOUT_MS`，但下载、转写、Feishu API 调用仍会通过同步路径占用主进程事件循环。

建议：

- 将资源下载、音频转写、merge-forward 拉取迁移到独立 worker/subprocess。
- 主事件循环只负责入队、状态记录、超时取消和最终回调投递。
- 使用 async `spawn` + `AbortController`/timer，并确保超时后 kill 子进程树。
- 每个 job 记录 `queued/running/succeeded/failed/timed_out/cancelled` 状态。

验收：

- 慢下载或慢 ASR 不阻塞 `/status`、`/interrupt` 和普通文本回复。
- worker 超时后进程树被清理。
- 失败 job 有结构化 manifest/audit reason code，不泄露 stdout/stderr 原文。

### 2. 全局队列和 per-session 队列上限

当前普通消息通过全局 Promise 链串行处理，material job 另有轻量队列，但整体缺少全局背压。

建议：

- 引入 bounded global queue 和 per-session queue。
- 控制命令保留高优先级旁路，但仍要有限流。
- 同一 session 的最终 `sendToSession` 必须保持顺序。
- 超限时返回用户可见 busy/retry 提示，并写结构化 audit。

验收：

- 长 turn 期间批量事件不会导致内存无限增长。
- 同一 Feishu chat/thread 的消息按顺序投递到同一 session。
- 队列满时用户收到明确反馈。

### 3. Codex 输出缓冲上限

Codex delta、streaming transcript、session `lastOutput` 仍可能无限增长。

建议：

- 为 turn text buffer 设置硬上限。
- Streaming patch 使用 tail 或摘要，避免每次处理完整大文本。
- `sessions.json` 只保存截断输出、长度、hash 和可选本地 artifact 路径。

验收：

- 超长输出不会导致内存持续增长。
- `/capture` 能说明输出被截断，并提供 hash/长度。
- streaming card 不因大输出反复重渲染全量文本。

## P1：媒体与磁盘预算

### 4. 下载大小和 inbox 总预算

`FTB_MEDIA_MAX_DOWNLOAD_MB` 和 `FTB_MEDIA_INBOX_MAX_MB` 已存在配置，但仍需要真实执行。

建议：

- 下载前尽量通过 Feishu metadata 或资源信息获取大小。
- 下载后使用 `stat` 校验单文件大小，超限立即删除并记录 `download_too_large`。
- 按 inbox 根目录或当日目录累计预算，超限拒绝新 material job。
- 为预算拒绝提供用户可见说明和 canary 断言。

验收：

- 超大文件不会长期占用磁盘。
- manifest 记录 `download_too_large`、`inbox_budget_exceeded` 等稳定 reason code。
- 真实 canary 能验证预算生效。

### 5. 音频时长和转码边界

当前音频转写主要检查文件大小和本地命令安全，时长/转码成本边界还不完整。

建议：

- 使用本地 `ffprobe` 或等价工具获取音频时长。
- `FTB_AUDIO_TRANSCRIBE_MAX_SECONDS` 超限时跳过转写。
- 转码命令同样使用安全 executable/path 校验和超时。
- 补 timeout、非零退出、空 transcript、超大文件、模型路径权限测试。

验收：

- 超时返回 retryable reason。
- 非零退出不暴露 stdout/stderr 原文。
- 空 transcript、超大文件、时长超限都有稳定 reason code。

## P1：隐私与权限模型

### 6. 精细化 session ACL

本轮已把显式跨 session 操作收紧为 admin-only，但长期更合理的是 session 级 ACL。

建议：

- session 记录 owner sender、allowed chats、allowed threads。
- 普通用户只能访问自己或当前 chat/thread 授权的 session。
- admin 可显式授权/撤销 session ACL。
- `/capture` 默认只返回结构摘要，读取完整输出需要更高权限或明确参数。

验收：

- 普通用户无法横向读取其他群/用户 session。
- admin 能审计每次跨 session 访问。
- 兼容既有 `routes.json` 和 `user-context.json`。

### 7. 更严格 URL 脱敏策略

本轮保留了 `scheme://host/path`，去除了 query/fragment/userinfo。但 path 中也可能包含 token。

建议：

- 对 action/ref URL 默认只展示 host 和 path hash。
- 或按 allowlist host 策略决定是否展示 path。
- 原始 URL 仍只保留在私有 `message.json`。

验收：

- `/oauth/callback/<token>`、`/download/<signed-id>` 等 path-token 不进入 prompt/content/manifest。
- 业务卡片仍能给 Codex 提供足够上下文，例如 host、label、pathHash。

### 8. location 坐标暴露策略复审

当前规格允许坐标进入 private inbox/prompt，但日志只显示 `hasGeo=true`。如产品隐私策略收紧，需要调整。

建议：

- 默认 prompt/content 只展示地点名、地址和 `hasGeo=true`。
- 精确坐标只留在 `message.json`，或要求用户明确授权后暴露给 Codex。
- 为 location canary 增加坐标不进 prompt 的断言。

验收：

- 日志、audit、active-turn、prompt 均不含精确坐标。
- 用户明确要求处理位置时，有可追踪授权路径。

## P2：可观测性与数据治理

### 9. manifest schema version 和隐私分层

manifest 目前已经记录材料和结构摘要，但缺少 schema/version 和 report-safe 投影。

建议：

- 增加 `manifestSchemaVersion`。
- 区分 `privacyClass: private | report_safe`。
- download result 使用 `stdoutSha25616`、`stderrSha25616`、`exitStatus`、`errorReasonCode`，避免 raw stdout/stderr。
- 为 canary/report 输出定义安全投影。

验收：

- 测试报告不需要读取 raw manifest 字段即可判断通过/失败。
- manifest 版本变化可被 release notes 和迁移脚本识别。

### 10. canary 结果结构化

当前 canary 是 checklist，缺少可比较的结果格式。

建议：

- 新增 `test/canary-results.schema.json` 或文档化 JSONL schema。
- 字段包括 `caseId`、`gitSha`、`instance`、`timestamp`、`artifactPaths`、`redactionAssertions`、`pass`、`failureReasonCode`。
- 可以先手工记录 JSONL，再逐步自动化。

验收：

- 每次真实飞书 canary 都能产出可比较记录。
- redaction 断言能明确说明检查了哪些日志/manifest/content。

## P2：交互与上线体验

### 11. material job 入队反馈

当前 material job 入队成功后，用户可能在慢 ASR 场景下等待较久。

建议：

- 入队成功后发送“已收到媒体材料，正在本地处理”的可更新消息。
- 完成后 patch 或回复同一条消息。
- 失败、超时、队列满分别给出不同用户可见说明。

验收：

- 慢音频场景下用户能看到处理中状态。
- 最终回复不会重复刷屏。

### 12. `codex-exec` 后端的 Feishu 行为边界

`codex-app-server` 会注入 bridge developer instructions；`codex-exec` 目前主要依赖 per-turn prompt。

建议：

- 为 `codex-exec` 增加同等系统/开发者边界文本。
- 或明确该后端不应拥有 Feishu/Lark side-effect 工具。
- 补测试，确认 prompt 中包含“不直接回复当前 Feishu 消息”的边界。

验收：

- 使用 `codex-exec` 时不会因为模型自行调用 Feishu 工具导致重复回复。
- 行为边界和 app-server backend 一致。

## 建议拆分顺序

1. Worker 隔离 + bounded queue。
2. 下载/磁盘/音频时长预算。
3. session ACL。
4. manifest schema + canary JSONL。
5. 更严格 URL/path 和 location 隐私策略。
6. material job 用户反馈和 `codex-exec` 边界补齐。
