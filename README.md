# dsh-qq · QQ 接入插件

把 [DeepSeek Harness](https://github.com/deepseek-ai) 接进真实 QQ：收发消息、看图/表情包/视频、发 QQ 空间、在授权下控制本机软件，并带一套每日自动压缩的长期记忆、主动聊天和发送守卫。

> 适合**个人助手**：单主人、强授权、重隐私、可长期运行。不是客服机器人模板。

## 功能

- **消息**：主动/被动；私聊/群聊；文本、图片、视频、语音、文件、QQ 表情、@、引用
- **多模态**：图片/表情包作为附件直接看；视频默认 5fps 抽帧（长视频按时长比例，上限可配）
- **QQ 空间**：文字 + 最多 9 图；可见范围 1/4/16/64/128
- **软件控制**：列窗口、启动、切前台、关闭、截屏、键盘输入（需授权，Windows）
- **授权**：QQ 私聊回复「同意 授权码」生效，带有效期、可撤销
- **配对**：首次私聊发 6 位配对码；只接受已配对联系人；群聊需 `allowedGroups` 白名单
- **记忆**：每天 04:00 自动压缩前 24 小时对话，支持检索，不翻全量聊天记录
- **主动聊天**：可配置每天次数与间隔，只发给 allowlist 内的主人，支持结合最近对话
- **慢速回复**：可配置时段内按概率延迟回复
- **发送守卫**：频率限制、去重、链接/手机号/高风险词拦截、失败熔断（告警只发主人）
- **聊天记录**：独立目录按会话/日期存 JSONL，敏感信息脱敏
- **B 站日常**（可选）：每天浏览定额视频，抽帧复盘；需要 B 站 Cookie

## 环境要求

- DeepSeek Harness（Host 插件，Node.js >= 20）
- OneBot 11 实现：推荐 [LLBot](https://github.com/LLOneBot/LuckyLilliaBot) 8.3.2+，`--headless` 模式开启正向 WebSocket
- ffmpeg（视频抽帧，可选；可在配置里指定路径）
- 一个专用 QQ 小号（第三方协议有封号风险，不要用主号）
- Windows（仅软件控制需要；消息/记忆/空间跨平台）

## 安装

1. 把仓库放到任意目录，例如 `D:/dsh-qq`。
2. 在 DSH profile 的 `package.json` 依赖里加入本地包：

```json
{
  "dependencies": {
    "@dsh-local/dsh-qq": "link:D:/dsh-qq"
  },
  "dsh": {
    "profile": {
      "bundles": ["@dsh-local/dsh-qq"]
    }
  }
}
```

3. 编辑 profile 的 `cordis.patch.yml`（或把本仓库 `cordis.patch.yml` 的条目合并进去），把所有 `<...>` 占位符换成自己的：

```yaml
- id: qq-bridge
  name: '@dsh-local/dsh-qq'
  config:
    wsUrl: 'ws://127.0.0.1:3001'
    token: '<onebot-token>'
    account: '<bot-uin>'
    dataDir: 'D:/dsh-qq-data'
    mediaDir: 'D:/dsh-qq-data/media'
    ownerUins: ['<owner-uin>']
    allowedGroups: []
    autoPair: true
    memoryEnabled: true
```

4. 启动 LLBot：

```powershell
LuckyLillia.exe --headless --qq=<bot-uin>
```

首次扫码登录，把 LLBot 的 OneBot WS 地址/token 填进配置。

5. 在 QQ 私聊机器人，拿到 6 位配对码，然后在 Harness 里执行 `qq_pair(action="confirm", code="...")`。

## 配置说明

完整示例见 [`cordis.patch.yml`](./cordis.patch.yml)。常用项：

| 字段 | 说明 |
|---|---|
| `wsUrl` / `token` | OneBot 正向 WebSocket 地址与 token |
| `account` | 机器人 QQ 号 |
| `ownerUins` | 授权主人 QQ；为空时需要配对 |
| `allowedGroups` | 允许处理的群号；空表示不处理群 |
| `autoPair` | owners 为空时，首个私聊是否自动发配对码 |
| `dataDir` / `mediaDir` | 运行数据与媒体目录 |
| `memoryEnabled` / `memoryDir` | 每日记忆 |
| `chatLogEnabled` / `chatLogDir` | 独立聊天记录 |
| `slowReply` | 慢速时段、概率、延迟范围 |
| `proactive` | 主动聊天：`target` + `allowlist` 双重限制，仅允许白名单 |
| `sendGuard` | 频率/去重/内容拦截/熔断 |

> `proactive.allowlist` 是硬限制：`target` 必须同时出现在 allowlist 与 `ownerUins` 里，否则不会主动发送。

## 记忆系统

### 窗口

每日记忆 `D` 覆盖 **D-1 04:00 → D 04:00**（本地时区）。

- 04:00 之后的消息归入下一天
- 04:00 之前的消息归入当天
- 04:00 定时任务生成 `D` 的记忆；启动晚了会在 15 分钟内补跑

### 存储

```
memory/
  raw/2026-10-20.jsonl        # 原始消息（按天，JSONL）
  daily/2026-10-20.json       # 每日摘要（结构化）
  daily/2026-10-20.md         # 每日摘要（人读）
  weekly/2026-10-25.json      # 周报（每周日 04:00 后）
  index.json                  # 每日索引（关键词、总览、会话摘要）
  state.json                  # 上次运行、失败次数
```

### 压缩策略

1. 按会话分组，保留最近 400 条/会话；
2. 单次发给模型的对话最多约 12k 字符，超出先分段压缩再合并；
3. 每个会话输出：摘要（≤220 字）、话题、决定、待办、偏好、未解决、重要原话；
4. 再合并成当日总览（≤300 字）+ 5-8 个关键词；
5. 关键词索引额外从原文抽取高频词，保证「图片」「视频」这类具体词也能搜到。

### 检索工具

- `qq_memory_search`：关键词/日期/会话搜索
- `qq_memory_get`：读取某天完整记忆
- `qq_memory_timeline`：最近 N 天一行一天
- `qq_memory_run`：手动补跑某天（一般不需要）

### 失败与降级

- LLM 不可用/超时：该会话降级为「首尾消息 + 条数」的启发式摘要，原始日志保留
- 04:00 失败后每 15 分钟重试，不阻塞消息收发
- 原始日志默认保留 90 天，每日摘要长期保留

## 隐私

- 只归档：已配对联系人的私聊、`allowedGroups` 内的群聊
- 记忆上下文只注入用 `qq_listen` 绑定的会话，不是全局注入
- 本地存储；发送给模型前脱敏（token、密码、密钥、授权码）
- 脱敏覆盖：`sk-`、`Bearer`、`Authorization`、`Cookie`、`ghp_/github_pat_`、`xox[baprs]-`、`AKIA`、`AIza`、私钥块、`api_key/token/password/密码/密钥` 键值
- 不存图片二进制，只存「图片/视频/表情」标记
- 插件**不读取** DeepSeek API key：摘要通过 `ctx.llm` 调用，密钥由 DSH 凭证服务管理
- 插件**不读取** LLBot 的 `auth_token.txt`；OneBot token 只在本地配置里，`qq_status` 不回显

## 工具

`qq_status`、`qq_send_message`、`qq_list_contacts`、`qq_get_history`、`qq_media_fetch`、`qq_get_forward`、`qq_listen`、`qq_pair`、`qq_permission_request`、`qq_permissions`、`qq_qzone_publish`、`qq_app`、`qq_memory_search`、`qq_memory_get`、`qq_memory_timeline`、`qq_memory_run`、`qq_bili_watch`

## 测试

```powershell
node test\onebot.test.mjs
node test\memory.test.mjs
```

- `onebot.test.mjs`：mock OneBot 连接、请求/响应、事件转发
- `memory.test.mjs`：stub LLM，验证记忆窗口、归档、摘要、索引、搜索、脱敏，不消耗真实 token

## 已知限制

- 第三方 QQ 协议有封号风险；发送守卫只能降低概率，不能归零
- LLBot 没有 `send_qzone_msg`；QZone 走 Web 降级，目前只支持纯文字
- 语音只接收/转存，不做语音转文字
- 群聊默认关闭，需要手动加 `allowedGroups`
- 软件控制仅 Windows
- B 站日常需要单独扫码登录并保存 Cookie；Cookie 过期需重扫

## License

MIT
