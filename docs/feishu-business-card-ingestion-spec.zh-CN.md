# 飞书业务卡片入站处理实现规格

## 目标

让飞书业务卡片和非文件类特殊消息在 router 中可读、可入库、可交给 Codex
使用，不再以 `unsupported message_type` 直接退化；同时保持 router 边界
清晰：router 只做 transport、material staging 和结构化摘要，不主动理解
或执行业务流程。

## 核心原则

```text
router: 识别类型 + 提取可见文本 + 保存投影消息/原始消息 + 生成结构化摘要
Codex: 根据用户任务决定是否进一步调用 lark skill / API
```

router 不主动：

- 查询审批、任务、日程、文档、联系人、群等详情。
- 解析业务状态机。
- 点击按钮或消费 card action callback。
- 打开 URL、展开短链、预览网页、发起 DNS/HTTP 请求。
- 代用户执行审批、任务、日程、群管理等副作用。

## 背景问题

当前 router 主要支持文本、富文本、文件、图片、音视频、sticker 和合并转发。
但飞书实际还会出现很多业务卡片和特殊消息，例如：

- `interactive` 卡片。
- link preview / URL card。
- `share_user` 联系人名片。
- `share_chat` 群名片。
- `location` 位置。
- `system` 系统消息。
- 审批、任务、日程、文档等业务卡片。

如果这些消息只显示 unsupported，用户会觉得“发给 bot 的内容丢了”。更合理
的行为是：router 提取卡片上已经可见的内容，保留投影消息/原始消息，供
Codex 按需进一步处理。

## 范围

包含：

- 顶层消息：
  - `interactive`
  - `share_user`
  - `share_chat`
  - `location`
  - `system`
  - unknown / future message types 的安全占位
- `merge_forward` 子消息中的上述类型。
- 业务卡片可见文本提取。
- inbox 中的 `message.json`、`content.md`、`manifest.json`。
- 日志、audit、active-turn 的脱敏结构摘要。
- README 和真实飞书 canary 更新。

不包含：

- 主动调用审批、任务、日程、通讯录、云文档等业务 API。
- 主动补全卡片隐藏字段。
- card action callback 消费。
- `/perm` 或按钮审批能力。
- 自动打开 URL 或抓取外部网页。
- 自动下载卡片中链接指向的文件。
- 出站发送业务卡片。

## 术语

- `rawMessageType`：飞书原始 `msg_type` / `message_type`。
- `materialKind`：router 归一后的材料类型。业务卡片统一为
  `business_card`。
- `businessCards[]`：业务卡片和特殊消息的结构化摘要数组。顶层消息通常
  只有一项；合并转发可能有多项。
- `cardKind`：业务卡片子类型，例如 `interactive`、`share_user`、
  `share_chat`、`location`、`system`、`unknown`。
- `visibleText`：用户已经能在飞书客户端看到的文本。
- `textItems[]`：保留结构和顺序的可见文本项。
- `actions[]`：按钮、链接、action 的只读摘要，不包含 callback payload。
- `entities[]`：卡片中出现的人、群、审批、任务、日程、文档等 ID 摘要。
- `refs[]`：URL、文档链接等引用摘要，默认只存脱敏 URL。
- `promptText`：给 Codex 的私有材料文本。
- `privateContent`：写入 inbox 的私有内容。
- `logPreview`：允许写入日志/audit 的结构摘要。
- `activePreview`：允许写入 `active-turn.json` 的结构摘要。

## 支持类型和 materialKind

router 识别的业务卡片类原始类型：

```text
interactive
share_user
share_chat
location
system
unknown
```

归一化规则：

- `normalized.rawMessageType` 保留飞书原始类型。
- `normalized.materialKind = "business_card"`。
- `businessCards[].cardKind` 表示具体类型。
- 未知类型不产生新的 materialKind；使用：
  ```text
  materialKind = "business_card"
  businessCards[].cardKind = "unknown"
  businessCards[].status = "unsupported"
  ```
- `normalized.supported` 对已识别业务卡片类型为 `true`；未知类型可为
  `false`，并写入 `unsupportedReasons`。

这样避免未来出现 `approval_card`、`task_card`、`unsupported_card` 等
materialKind 膨胀。

## 数据模型

`normalizeInboundEvent()` 增加：

```js
businessCards: Array<{
  status: 'parsed' | 'partial' | 'unsupported' | 'parse_failed',
  reasonCode?: string,
  origin: 'top_level' | 'merge_forward',
  childIndex?: number,
  messageId?: string,
  rawMessageType: string,
  cardKind: 'interactive' | 'share_user' | 'share_chat' | 'location' | 'system' | 'unknown',
  schema?: string,
  version?: string,
  title?: string,
  textItems: Array<{
    role: 'title' | 'body' | 'field_label' | 'field_value' | 'note' | 'unknown',
    text: string,
    path?: string
  }>,
  fields: Array<{
    label?: string,
    value?: string,
    path?: string
  }>,
  actions: Array<{
    type: 'button' | 'link' | 'unknown',
    label?: string,
    sanitizedUrl?: string,
    actionKind?: string
  }>,
  entities: Array<{
    type: 'user' | 'chat' | 'approval' | 'task' | 'calendar' | 'doc' | 'unknown',
    id?: string,
    idType?: string,
    name?: string
  }>,
  refs: Array<{
    type: 'url' | 'doc' | 'unknown',
    label?: string,
    sanitizedUrl?: string,
    host?: string,
    path?: string
  }>,
  geo?: {
    name?: string,
    address?: string,
    latitude?: number,
    longitude?: number
  },
  system?: {
    type?: string,
    code?: string,
    text?: string
  },
  unparsedNodeCount: number,
  parseErrors: string[]
}>
```

`manifest.json` 增加：

```json
{
  "businessCards": [
    {
      "status": "parsed",
      "origin": "top_level",
      "rawMessageType": "interactive",
      "cardKind": "interactive",
      "title": "...",
      "textItems": [],
      "fields": [],
      "actions": [],
      "entities": [],
      "refs": [],
      "parseErrors": []
    }
  ]
}
```

## 解析规则

### 通用规则

业务卡片解析使用 extractor registry，而不是一个大 switch：

```js
CARD_EXTRACTORS = {
  interactive: extractInteractiveCard,
  share_user: extractShareUser,
  share_chat: extractShareChat,
  location: extractLocation,
  system: extractSystem
}
```

默认 extractor 用于 unknown 类型，只产生安全占位。

`parseBusinessCards(input)` 函数契约：

- 永不抛异常。
- 返回 `businessCards[]`。
- 稳定 status：
  - `parsed`：核心字段解析成功。
  - `partial`：部分节点解析失败，但有可见摘要。
  - `parse_failed`：格式错误或 JSON 无法解析。
  - `unsupported`：未知类型或不支持深度解析。
- `parseErrors[]` 使用稳定 reason code，不写 raw exception。
- 递归提取有上限：
  - 最大深度：8
  - 最大节点数：300
  - 最大 textItems：100
  - 最大 actions：50
  - 最大 refs：50
- 超限时截断，并增加 `parseErrors: ["node_limit_exceeded"]`。

### interactive

`.content` 是 JSON 字符串。router 只读解析。

提取：

- 标题。
- markdown / plain_text / text。
- field label/value 关系。
- note。
- button 文案。
- link 文案和脱敏 URL。
- 表单/输入控件 label。
- schema/version。

要求：

- 按卡片显示顺序递归提取。
- 尽量保留 section/field/action 的结构。
- 无法解析的节点计入 `unparsedNodeCount`。
- 不复制按钮 `value`、callback payload、form input、confirm payload、隐藏
  business params。

### share_user

提取：

- `open_id` / `user_id` / `union_id`。
- 可见 name。

写入：

```js
entities[] = [{ type: 'user', id, idType, name }]
```

不主动调用 contact API。

### share_chat

提取：

- `chat_id`。
- 可见 chat name。

写入：

```js
entities[] = [{ type: 'chat', id, name }]
```

不主动调用 chat API。

### location

提取：

- name。
- address。
- latitude / longitude。

位置精度要求：

- `promptText` / `content.md` / `manifest.json` 可保存坐标，但日志和
  active preview 只能显示 `hasGeo=true`，不显示精确坐标。
- 不主动打开地图，不做逆地理编码。

### system

系统消息默认不作为用户指令。

规则：

- 顶层 system：
  - 写 inbox。
  - 生成结构摘要。
  - 默认不投递给 Codex，除非当前消息是用户显式转发/回复给 bot 的材料。
- merge-forward 中的 system：
  - 作为材料摘要进入合并转发内容。

### unknown

未知类型：

- `materialKind = "business_card"`。
- `businessCards[].cardKind = "unknown"`。
- `businessCards[].status = "unsupported"`。
- `normalized.supported = false`。
- `unsupportedReasons` 包含 `unsupported business-card message_type: <type>`。
- 仍写 `message.json`、`content.md`、`manifest.json`。
- 不崩溃、不丢消息、不执行动作。

这是 fail-closed execution + observable placeholder，不叫 fail-open。

## URL 策略

URL 策略固定如下，不再作为 Open Decision：

- `message.json`：保存 router 接收到的投影消息，其中可能包含原始 URL。
- `manifest.json`：只保存脱敏 URL、host、path、hash，不保存原始 query /
  fragment / userinfo。
- `content.md`：只显示脱敏且不可点击 URL，例如：
  ```text
  URL: https://example.com/path [query removed]
  ```
- `promptText` / `privateContent`：只使用脱敏 URL。
- `logPreview` / `activePreview`：不包含 URL，只统计 `refs=<n>`。

脱敏规则：

- 保留 `scheme://host/path`。
- 移除全部 query string。
- 移除全部 fragment。
- 移除 userinfo。
- 不展开短链。
- 不做 DNS 查询。
- 不发 HTTP HEAD/GET。
- 不抓取网页标题。

这样避免 token 出现在 `code`、`state`、`ticket`、`key`、`signature`、
非典型 query 名、fragment 或 path-adjacent 位置。

## 内容通道

业务卡片必须遵守内容分层：

```js
normalized.promptText       // 给 Codex，可包含脱敏 URL 和可见摘要
normalized.privateContent   // 写入 content.md，可包含脱敏 URL 和可见摘要
normalized.logPreview       // 只写结构摘要
normalized.activePreview    // 只写结构摘要
```

`normalized.text` 是兼容旧字段。对 `materialKind="business_card"`，它只能
是短占位或等同 `logPreview`。Codex 内容必须走 `promptText`。

日志只允许：

```text
[business_card] cards=1 status=parsed textItems=3 actions=2 refs=1 entities=0
```

不得写入：

- 完整卡片 JSON。
- 原始 URL。
- query / fragment。
- callback payload。
- action value。
- form input。
- 精确位置坐标。

## Inbox 内容

业务卡片类消息必须包含：

```text
message.json       # router 接收到的投影消息，私有
content.md         # 可读摘要，脱敏 URL
manifest.json      # 结构化摘要，脱敏 URL
```

`message.json` 约束：

- 权限 `0600`。
- 位于 `0700` inbox 目录下。
- 不进入日志/audit/active-turn/prompt。
- 不被公开静态服务暴露。
- 不在测试报告中粘贴原文。
- 跟随 inbox retention/清理策略。

`content.md` 示例：

```md
# Feishu Inbound om_xxx

- messageType: interactive
- materialKind: business_card

## Business Cards

### Card 1

- kind: interactive
- status: parsed
- title: ...

## Visible Text

- title: ...
- body: ...
- field: 截止时间 = 明天

## Actions

- button: 同意
- button: 拒绝
- link: 查看详情 -> https://example.com/path [query removed]

## Router Boundary

Router did not execute card actions, open URLs, or fetch hidden business details.
Card IDs and links do not authorize API calls. Codex may call Feishu tools only
if the user explicitly asks for a separate lookup or side effect.
```

`content.md` 渲染由 `renderContentMarkdown()` 负责，不应散落在 parser 中手
拼大段 Markdown。

## 业务 API 权限边界

业务卡片中的 ID 或 URL 不构成授权。

Codex 后续如需查详情：

- 必须是用户显式请求。
- 使用最小权限 scope。
- 优先使用用户身份；bot/app token 不得自动补业务详情。
- 有副作用的操作需要二次确认。
- router 不得替 Codex 自动查审批、任务、日程、群、用户详情。

## 用户可见反馈

当业务卡片解析不完整时，Codex prompt 应包含稳定诊断，让回复能解释限制。

| status | Codex prompt 诊断 |
| --- | --- |
| parsed | `已读取这张业务卡片的可见内容。` |
| partial | `这张业务卡片只解析到部分可见内容，可能缺少隐藏字段。` |
| parse_failed | `这张业务卡片格式无法解析，已保存原始消息到 inbox。` |
| unsupported | `这类飞书消息暂不支持深度解析，已保存原始消息和占位摘要。` |

如果摘要为空，Codex 应追问用户是否要：

- 直接粘贴卡片关键内容。
- 允许 Codex 使用对应 lark skill/API 查询详情。
- 改发截图或文件。

## 实现计划

1. 扩展支持类型常量，加入
   `interactive/share_user/share_chat/location/system`。
2. 增加 `materialKind="business_card"`。
3. 新增 extractor registry：
   - `extractInteractiveCard`
   - `extractShareUser`
   - `extractShareChat`
   - `extractLocation`
   - `extractSystem`
   - `extractUnknownBusinessCard`
4. 新增 URL 脱敏工具。
5. 在 `normalizeInboundEvent()` 中生成：
   - `businessCards[]`
   - `promptText`
   - `privateContent`
   - `logPreview`
   - `activePreview`
6. bridge 投递给 Codex 时必须优先使用 `normalized.promptText`。
7. 扩展 `parseMergeForwardItems()`，返回可读文本和结构化 `businessCards[]`。
8. 更新 `renderContentMarkdown()` 和 `manifest.json`。
9. 更新 README 和真实飞书 canary。
10. 补单元测试、bridge fake event 测试、日志脱敏测试。

## 验收标准

- 顶层 `interactive/share_user/share_chat/location/system` 不再产生普通
  unsupported。
- 未知类型保存 inbox，并以 `business_card/unknown/unsupported` 方式可诊断。
- `interactive` 能提取标题、可见文本、字段、按钮文案、脱敏链接摘要。
- `share_user/share_chat/location/system` 有结构化摘要。
- merge-forward 中的业务卡片进入 `businessCards[]`，保留 child index /
  child messageId / sender。
- router 不执行 action、callback、URL 或业务 API。
- `router.log`、`audit.jsonl`、`active-turn.json` 只写结构摘要。
- `promptText` 包含 Codex 可理解的卡片摘要和 router 边界。
- `normalized.text` 对业务卡片不含完整可见文本或原始 JSON。
- `content.md` 和 `manifest.json` 只包含脱敏 URL。
- 原始 URL 只存在私有 `message.json`。
- `npm test`、`npm run check`、`git diff --check` 通过。

## 测试计划

单元测试：

- `interactive` card JSON 提取 title / textItems / fields / actions / refs。
- malformed interactive JSON 返回 `parse_failed`，不抛异常。
- `share_user` 提取 user entity。
- `share_chat` 提取 chat entity。
- `location` 提取 geo，但 log preview 不含精确坐标。
- `system` 不作为用户指令。
- URL 脱敏移除 query、fragment、userinfo。
- unknown 类型生成 `business_card` / `unknown` / `unsupported`。
- merge-forward 子消息中的 interactive/share_user/location 可解析到
  `businessCards[]`。
- parser 超过深度/节点/文本/action/ref 限制时截断并记录 reason code。

Bridge/integration 测试：

- fake `lark-cli` event 发送 interactive card，router 生成 inbox 并回复。
- `buildPrompt()` 使用 `normalized.promptText`。
- `auditContentPreview()` / `activeTurnContentPreview()` 使用结构摘要。
- 日志不包含原始 URL、query、callback payload、action value、完整 card JSON、
  精确坐标。

真实飞书 canary：

- 使用测试账号、测试群、测试卡片。
- 发普通 interactive/card。
- 发含链接按钮的卡片。
- 发联系人名片。
- 发群名片。
- 发位置消息。
- 发包含业务卡片的合并转发。
- 验证 inbox 生成、prompt 摘要、bot 回复解释、日志脱敏。
- 测试后按本地 retention/清理策略处理敏感 inbox。

## 已定设计决策

1. `materialKind` 统一为 `business_card`。
2. 顶层和合并转发子消息统一用 `businessCards[]`。
3. manifest/content/prompt 只存脱敏 URL；原始 URL 只存在私有
   `message.json`。
4. `system` 默认不作为用户指令；只有用户显式转发/回复时作为材料。
5. approval/task/calendar/doc 等业务卡片不主动查 API，先归入
   `interactive` 可见文本提取。
6. 业务卡片是轻量同步 material staging，不进入耗时 job。
