# dsh-qq · 把 DeepSeek Harness 接进真实 QQ

一个 Host 插件：给你的 Harness 助手一个真的 QQ 号——收发消息、看图看视频、发空间、在授权下操作本机，并且**记得住事、会忘事、有情绪、有边界**。

> 定位：**个人助手**。单主人、强授权、重隐私、可长期无人值守运行。不是客服机器人，也不是群管工具。

## 亮点

- **真的在聊天**：长回复自动拆条、发前有停顿、说法像人；掉线不道歉、不解释，直接接着聊。
- **长期记忆**：每天 09:30 自动把前 24 小时压成摘要；另有艾宾浩斯加权记忆——该记的记住，该淡的淡掉，可以翻旧账也可以忘掉。
- **认知与情绪**：五维情绪（愉悦/唤醒/支配/依恋/良知）+ 能量槽 + 睡眠（深睡/浅睡/失眠/小纸条）+ 昼夜节律。
- **关系边界**：说过“这条我不接”的事锁 7 天，锁期内再提只让她后退、不逼她改口；7 天后有一次性正式申请。
- **强授权**：启动软件、截屏、模拟输入、执行命令、发空间之前必须拿到授权码；口令走 QQ 私聊、有时效、可撤销。
- **多模态**：图片/表情包直接看；视频读流抽帧不下载整条；语音可发（只发主人私聊）。
- **自我表达**：人格文件（可编辑、可热重载）、梗笔记本、表情库、日记、图片记忆、视频笔记、天气。
- **面板**：Web UI 里的状态卡片 + 热改配置，不用重启。

全功能按子系统列出：[FEATURES.md](./FEATURES.md)。

## 环境要求

- DeepSeek Harness（Node.js >= 20）
- OneBot 11 实现：LLBot / NapCat / Lagrange.OneBot（正向 WebSocket）
- ffmpeg（可选，视频抽帧）
- 专用 QQ 小号（第三方协议有封号风险，别用主号）
- 软件控制类功能仅 Windows

## 安装（三步）

1. 仓库放到本地，profile `package.json` 加依赖：`"@dsh-local/dsh-qq": "link:D:/dsh-qq"`，`bundles` 里加上它。
2. profile 的 `cordis.patch.yml` 按 id 覆盖配置（最小示例）：

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
```

3. 启动 OneBot 实现 → 私聊机器人拿 6 位配对码 → `qq_pair(action="confirm", code="...")`。

完整字段见 [README](./README.md) 与 [FEATURES.md#12-配置项](./FEATURES.md#12-配置项)。

## 隐私

- 只归档已配对联系人的私聊与白名单群；记忆上下文只注入绑定会话。
- 发模型前脱敏（token / cookie / 私钥 / 密码键值）。
- 不读模型 API key、不读 OneBot 的 auth token、不查 IP、不追踪位置。

## 测试

```powershell
node --test "test/*.test.mjs"
```

46 个文件、335 条用例，全部离线。

## License

MIT
