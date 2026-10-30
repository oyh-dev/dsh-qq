# dsh-qq · QQ 接入插件

把 [DeepSeek Harness](https://github.com/deepseek-ai) 接进真实 QQ：收发消息、看图/视频、发 QQ 空间、在授权下控制本机软件，并带一套**每日自动压缩的长期记忆**、**加权记忆**、**情绪与生理层**和**关系边界机制**。

> 适合**个人助手**：单主人、强授权、重隐私、可长期无人值守运行。不是客服机器人模板。

**全部功能按子系统列出（含设计取舍）→ [FEATURES.md](./FEATURES.md)**

**版本变化 → [CHANGELOG.md](./CHANGELOG.md)**

## 它能做什么

| 类别 | 一句话 |
|---|---|
| 消息 | 私聊/群聊，文本、图片、视频、语音、文件、表情、@、引用、骰子、猜拳；长回复自动拆条 |
| 多模态 | 图片与表情包直接看；视频读流抽帧，不下载整条 |
| 记忆 | 每天 09:30 压前 24 小时对话成摘要；另有艾宾浩斯加权记忆（会淡忘）与认知层（我的判断，可被推翻） |
| 情绪 | 五维（愉悦/唤醒/支配/依恋/良知）+ 能量槽 + 睡眠（深睡/浅睡/失眠/小纸条）+ 昼夜节律 + 做梦 |
| 关系 | 粘人机制（有上限、有代价）、拒绝锁定（说过不接的事锁 7 天）、边界与自保 |
| 自我表达 | 人格文件、梗笔记本、表情库、日记、图片记忆、视频笔记、天气、拍一拍 |
| 授权 | 启动软件/截屏/模拟输入/执行命令/发空间前必须授权；QQ 私聊回“同意 授权码”生效 |
| 面板 | Web UI 里的状态卡片（能量、睡眠、情绪、绑定、授权）与热改配置 |

工具共 **49 个**，前缀统一 `qq_`，清单见 [FEATURES.md#10-工具清单](./FEATURES.md#10-工具清单)。

## 环境要求

- DeepSeek Harness（Host 插件，Node.js >= 20）
- OneBot 11 实现：推荐 [LLBot](https://github.com/LLOneBot/LuckyLilliaBot) 8.3.2+，`--headless` 模式开启正向 WebSocket（NapCat / Lagrange.OneBot 同样可用）
- ffmpeg（视频抽帧，可选）
- 一个专用 QQ 小号——第三方协议有封号风险，不要用主号
- 软件控制、截屏、模拟输入仅 Windows；消息/记忆/空间跨平台

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

3. 编辑 profile 的 `cordis.patch.yml`（或把本仓库 `cordis.patch.yml` 的条目合并进去），把所有 `<...>` 换成自己的：

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

4. 启动 OneBot 实现（以 LLBot 为例）：

```powershell
LuckyLillia.exe --headless --qq=<bot-uin>
```

首次扫码登录，把 OneBot WS 地址与 token 填进配置。

5. 私聊机器人拿到 6 位配对码，然后在 Harness 里执行 `qq_pair(action="confirm", code="...")`。

## 配置说明

完整示例见 [`cordis.patch.yml`](./cordis.patch.yml)，字段逐个说明见 [FEATURES.md#12-配置项](./FEATURES.md#12-配置项)。常用的几个：

| 字段 | 说明 |
|---|---|
| `wsUrl` / `token` | OneBot 正向 WebSocket 地址与 token |
| `account` | 机器人 QQ 号 |
| `ownerUins` | 授权主人 QQ；为空时需配对 |
| `allowedGroups` | 允许处理的群号；空表示不接群 |
| `dataDir` / `mediaDir` | 运行数据与媒体目录 |
| `memoryEnabled` / `memoryDir` | 每日记忆（09:30） |
| `memoryContextDays` | 每次回复注入几天的记忆（默认 3） |
| `ebb.*` | 加权记忆：整理时间、回忆条数与字数预算 |
| `proactive` | 主动消息：每日条数、间隔、静默时段 |
| `attachment` | 粘人：闲置多久算晾着、每日追问上限、冷却 |
| `voice.*` | 语音引擎与音色（`breeze` / `edge` / `sapi`） |
| `tools.trim` | 在助手的会话里隐藏哪些工具（省钱用） |

> 配置 schema 是白名单：YAML 里没进 schema 的键会被**静默丢弃**。改完用 `qq_status` 确认真的生效。

## 记忆怎么用

- 每天 **09:30** 自动压缩上一个 09:30 到现在的对话（`raw/` 原文、`daily/` 摘要、`index.json` 关键词）。
- 提到以前的事先查记忆，不翻全量聊天记录：`qq_memory_search` → `qq_memory_get` → 必要时 `qq_get_history`。
- 记忆上下文只注入用 `qq_listen` 绑定的会话，不是全局注入。
- 加权记忆（`ebb`）负责“该忘的忘掉”：按艾宾浩斯曲线衰减，边界层（`bounds.json`）单独存，不参与衰减。

## 隐私

- 只归档：已配对联系人的私聊、`allowedGroups` 内的群聊。
- 发送给模型前脱敏：`sk-`、`Bearer`、`Authorization`、`Cookie`、`ghp_/github_pat_`、`xox[baprs]-`、`AKIA`、`AIza`、私钥块、`api_key/token/password/密码/密钥` 键值。
- 插件**不读取**模型 API key（摘要走 `ctx.llm`，密钥由 DSH 凭证服务管理），也**不读取** OneBot 的 `auth_token.txt`。
- 不查 IP、不追踪位置；`qq_status` 只保留最近 20 条桥接日志，不含消息正文与密钥。
- 详细边界见 [FEATURES.md#14-隐私与红线](./FEATURES.md#14-隐私与红线)。

## 测试

```powershell
node --test "test/*.test.mjs"
```

47 个文件、348 条用例，全部离线（stub LLM / stub fetch / 临时目录），不消耗真实 token、不联网。

## 已知限制

- 第三方 QQ 协议有封号风险；发送守卫只能降低概率，不能归零。
- QQ 空间图片依赖 Web 降级接口，可能随前端改动失效。
- 语音只发给主人私聊，且默认不做语音转文字（需另装 whisper.cpp）。
- 群聊默认关闭，需手动加 `allowedGroups`。
- 软件控制仅 Windows。
- B 站日常需要单独扫码保存 Cookie，过期需重扫。

## License

MIT
