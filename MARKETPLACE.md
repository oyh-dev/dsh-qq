# dsh-qq · QQ 接入插件

> **一句话简介**：把 DeepSeek Harness 接进真实 QQ——收发消息、看图片/表情包/视频、发 QQ 空间、在授权下控制本机软件，并带一套每日自动压缩的长期记忆与主动聊天能力。

- 插件包名：`@dsh-local/dsh-qq`
- 版本：`1.0.0`
- 运行形态：DSH Host 插件（Cordis），通过 OneBot 11 连接 QQ
- 适配桥接：LLBot 8.3.2+（headless / OneBot 11 正向 WebSocket），兼容 NapCat 等 OneBot 实现

---

## 一、用途

QQ 是国内最常用的即时通讯工具，但官方没有给个人开发者开放机器人接口。本插件通过 OneBot 协议把**真实 QQ 账号**接进 DSH，让 Harness 里的助手可以：

- 在 QQ 里和主人聊天（私聊 / 群聊）
- 看懂对方发来的图片、表情包、视频
- 把内容发到 QQ 空间
- 在**主人授权**的前提下操作本机软件（列窗口、启动、截屏、键盘输入）
- 记住长期对话（每天 04:00 自动压缩），并在需要时检索
- 在限定范围内主动找主人聊天

它不是“客服机器人”模板，而是给**个人助手**用的 QQ 通道：单主人、强授权、重隐私、可长期运行。

---

## 二、功能清单

### 消息

| 能力 | 说明 |
|---|---|
| 私聊 | 文本、图片、视频、语音、文件、QQ 表情、@、引用回复 |
| 群聊 | 需 `allowedGroups` 白名单；支持 @、引用 |
| 主动发送 | `qq_send_message`，可指定私聊/群聊、目标、引用、@ |
| 被动接收 | 消息自动转发进绑定会话，图片作为附件直接可看 |
| 多消息合并 | 连发消息按静默窗口合并成一条，避免多次回复 |
| 慢速回复 | 可配置时段（如 12:00–18:00）按概率延迟 10–90 分钟再处理 |
| 主动聊天 | 每日随机 8–17 条、间隔 1–3 小时、可提问/闲聊/带图；**只发给硬白名单里的主人** |

### 多模态

- 图片 / 表情包：直接作为图片附件进入模型上下文
- 视频：默认 **5fps** 抽帧；短视频按 5fps，长视频按时长比例均匀抽样，上限 `maxVideoFrames`（默认 24 帧），无需下载完整视频
- 语音：接收并转存，不做语音转文字
- 文件：接收并保存到本地媒体目录

### QQ 空间

- 文字 + 最多 9 张图
- 可见范围：1 所有人 / 4 好友 / 16 部分好友 / 64 仅自己 / 128 部分好友不可见
- LLBot 没有 `send_qzone_msg` 时，自动降级为 QZone Web 接口（Cookie + g_tk），目前降级模式仅支持纯文字

### 软件控制（需授权）

- 列出窗口 / 进程
- 启动程序、切换前台、关闭
- 截屏
- 模拟键盘输入
- 全部走 `app_control` / `screen` / `input` 授权，Windows 实现

### 授权与配对

- 首次私聊发 6 位配对码，主人在 Harness 里确认
- 授权请求发到主人 QQ，回复「同意 123456」生效，带有效期、可撤销
- 授权范围：`app_control`、`screen`、`input`、`filesystem`、`shell`、`qzone`、`broadcast`
- 非主人私聊默认静默/固定拒绝；非主人且 24h 内无往来时禁止主动发送

### 记忆

- 每天 04:00 自动压缩前 24 小时（`D-1 04:00 → D 04:00`）
- 按会话生成结构化摘要：话题、决定、待办、偏好、未解决、重要原话
- 生成每日总览 + 关键词索引，支持按天/关键词/会话检索
- 只归档已配对私聊与白名单群聊；发送给模型前脱敏
- 记忆上下文只注入用 `qq_listen` 绑定的会话，不是全局注入

### 稳定性与安全

- **发送守卫**：频率限制（单聊 1.5s/5 条每分钟、全局 15 条每分钟）、去重（30s）、链接/手机号/高风险词拦截、连续失败熔断 10 分钟（告警只发主人）
- **聊天记录**：独立目录 `qq-chats/`，按会话/日期存 JSONL，收发双向，敏感信息脱敏
- **绑定持久化**：插件重载后自动恢复监听，不会漏消息
- **私聊不引用**：私聊正常回复，群聊被 @ 时才引用
- **主动消息白名单**：目标写死在代码里，配置改不了，注入/角色扮演也无法改目标

### 工具列表

`qq_status`、`qq_send_message`、`qq_list_contacts`、`qq_get_history`、`qq_media_fetch`、`qq_get_forward`、`qq_listen`、`qq_pair`、`qq_permission_request`、`qq_permissions`、`qq_qzone_publish`、`qq_app`、`qq_memory_search`、`qq_memory_get`、`qq_memory_timeline`、`qq_memory_run`

---

## 三、技术架构

```
dsh-qq/
├── index.js              # 插件入口：注册工具、系统提示、绑定生命周期
├── cordis.patch.yml      # 默认配置（bundle patch）
├── package.json
├── lib/
│   ├── bridge.js         # 桥接核心：事件、配对、转发、发送、主动消息、慢速回复
│   ├── onebot.js         # OneBot 11 正向 WS 客户端（断线重连、请求/响应、事件）
│   ├── media.js          # 图片识别、媒体下载、ffmpeg 抽帧
│   ├── permissions.js    # 授权码、有效期、撤销、审批文本解析
│   ├── appcontrol.js     # Windows 窗口/进程/截屏/键盘（PowerShell）
│   ├── memory.js         # 每日归档、摘要、索引、检索、上下文渲染、脱敏
│   ├── sendguard.js      # 频率/去重/内容拦截/熔断
│   └── tools.js          # 全部 qq_* 工具定义
├── locale/               # 中英文文案
├── icon.svg
├── test/
│   ├── onebot.test.mjs   # mock OneBot 收发测试
│   └── memory.test.mjs   # stub LLM 的记忆窗口/检索/脱敏测试
└── README.md
```

数据流：

```
QQ ←→ LLBot（OneBot 11 WS）←→ bridge.js
                                  ├─ 配对/授权
                                  ├─ 转发 → DSH 会话（followup）
                                  ├─ 媒体 → attachments
                                  ├─ 记忆 → memory/（04:00 压缩）
                                  ├─ 聊天记录 → qq-chats/
                                  └─ 发送 ← qq_* 工具 / 主动消息
```

---

## 四、配置示例

```yaml
- id: qq-bridge
  name: '@dsh-local/dsh-qq'
  config:
    wsUrl: 'ws://127.0.0.1:3001'
    token: 'your-onebot-token'
    account: '10000'
    dataDir: 'D:/dsh-qq-data/.qq-bridge'
    mediaDir: 'D:/dsh-qq-data/qq-media'
    ownerUins: ['10001']
    allowedGroups: []
    autoPair: true
    permissionWaitSec: 60
    approvalTimeoutSec: 300
    maxImages: 6
    maxVideoFrames: 3
    memoryEnabled: true
    memoryDir: 'D:/dsh-qq-data/.qq-bridge/memory'
    memoryContextDays: 7
    memoryRetentionDays: 90
    chatLogEnabled: true
    chatLogDir: 'D:/dsh-qq-data/qq-chats'
    mergeWindowMs: 3500
    mergeQuickMs: 1200
    maxMergeMs: 9000
    slowReply:
      enabled: true
      start: '12:00'
      end: '18:00'
      probability: 0.5
      minMinutes: 10
      maxMinutes: 90
    proactive:
      enabled: true
      target: '10001'
      dailyMin: 8
      dailyMax: 17
      gapMinMinutes: 60
      gapMaxMinutes: 180
      burstMin: 1
      burstMax: 1
      checkIntervalMinutes: 3
      quietAfterMinutes: 3
      imageDir: 'D:/dsh-qq-data/qq-proactive-images'
      imageProbability: 0.2
    sendGuard:
      ratePerMinute: 15
      ratePerChatPerMinute: 5
      minSendIntervalMs: 1500
      groupMinSendIntervalMs: 3000
      groupRatePerMinute: 3
      dedupWindowMs: 30000
      jitterMs: 800
      breakerFailures: 3
      breakerCooldownMs: 600000
      blockLinks: true
      blockPhones: true
```

---

## 五、环境要求

- DeepSeek Harness（Host 插件）
- LLBot 8.3.2+，`--headless --qq=<账号>`，OneBot 11 正向 WS 开启
- ffmpeg（视频抽帧，可选；可指定路径）
- Windows（仅软件控制需要；消息/记忆/QZone 跨平台）
- 一个专用 QQ 小号（第三方协议有封号风险，不要用主号）

---

## 六、隐私与安全

- 插件**不读取** DeepSeek API key；摘要通过 `ctx.llm` 调用，密钥由 DSH 凭证服务管理
- 插件**不读取** LLBot 的 `auth_token.txt`；OneBot token 只在本地配置，`qq_status` 不回显
- 归档只覆盖已配对私聊与白名单群聊；陌生人私聊不进模型、不写聊天记录
- 发给模型前脱敏：`sk-`、`Bearer`、`Authorization`、`Cookie`、GitHub/Slack/AWS/Google token、私钥、`api_key/token/password/密码/密钥`
- 记忆与聊天记录都存本地；原始日志默认保留 90 天
- 主动消息目标写死白名单，配置无法改；非主人主动私聊被发送层硬拦截

---

## 七、使用示例

- 主人在 QQ 私聊：「帮我看看这个视频里是什么」→ 插件抽帧 → 助手描述画面
- 主人在 QQ 私聊：「发条空间，庆祝一下」→ 助手走 `qzone` 授权 → 发布（可设仅自己可见）
- 主人在 Harness：「把微信窗口切到前台并截图」→ 助手发授权码 → 主人 QQ 回「同意 123456」→ 执行
- 主人问：「上次说的那个插件叫什么」→ 助手先 `qq_memory_search`，不翻全部聊天记录
- 助手在许可范围内主动发一条：「喂，今天怎么这么安静」

---

## 八、限制与已知问题

- 第三方 QQ 协议本身有封号风险；插件通过频率限制、内容拦截、熔断降低概率，但无法归零
- LLBot 不支持 `send_qzone_msg`；QZone 走 Web 降级，目前只支持纯文字
- 语音只接收/转存，不做语音转文字
- 群聊功能默认关闭，需要手动加 `allowedGroups`
- 软件控制仅 Windows
- 慢速回复/主动消息均为可选配置，默认值可按需调整

---

## 九、测试

```powershell
cd <repo>
node test\onebot.test.mjs
node test\memory.test.mjs
```

- `onebot.test.mjs`：mock OneBot 连接、请求/响应、事件转发
- `memory.test.mjs`：stub LLM，验证记忆窗口、归档、摘要、索引、搜索、脱敏，不消耗真实 token

---

## 十、市场标签（可直接用于收录申请）

- 分类：社交 / IM 接入
- 标签：QQ、OneBot、聊天机器人、多模态、QQ空间、长期记忆、授权控制、隐私
- 短描述（≤120 字）：把 DeepSeek Harness 接进真实 QQ。支持私聊/群聊、图片/表情包/视频理解、QQ空间、授权下的软件控制、每日记忆压缩与主动聊天；单主人、强授权、重隐私、可长期运行。

---

*文档生成：2026-10-19 · 对应代码版本 1.0.0*
