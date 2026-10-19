import path from 'node:path';
import { SCOPES } from './permissions.js';
import { lastClosedDigestKey } from './memory.js';
import { truncate } from './util.js';

const SCOPE_ENUM = Object.keys(SCOPES);

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

function textOutput(description = 'JSON 结果') {
  return {
    schema: {
      type: 'object',
      additionalProperties: true,
      description,
    },
    render: renderJson,
  };
}

export function registerQqTools(ctx, bridge) {
  const register = (definition) => ctx.tools.register(definition);

  register({
    name: 'qq_status',
    description: '查看 QQ 桥接状态：OneBot 连接、登录账号、已绑定会话、授权有效期、待授权请求、配对码、媒体目录、ffmpeg 是否可用，以及最近的桥接日志。排查 QQ 相关问题时先调用它。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: textOutput('QQ 桥接状态'),
    async execute() {
      return bridge.status();
    },
    presentCall: () => ({ card: 'generic', title: '查看 QQ 状态', kind: 'other' }),
  });

  register({
    name: 'qq_send_message',
    description: [
      '通过 QQ 主动发送消息（私聊或群聊）。文本、图片、视频、语音、文件、QQ表情、@、回复都支持。',
      'target_type 传 auto 时回复最近一次收到的 QQ 消息；也可以显式指定 private/group 和 target_id。',
      '图片/视频/文件可以传本地绝对路径或 http(s) URL；发送前会做 file:// 转换。',
      '私聊直接回复即可，不要引用；群聊里有人 @ 你时才用 reply_to 引用那条消息。群聊 @ 某人用 at 参数。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target_type: {
          type: 'string',
          enum: ['auto', 'private', 'group'],
          description: 'auto=回复最近会话；private=私聊；group=群聊。',
        },
        target_id: {
          type: 'string',
          description: 'QQ号（私聊）或群号（群聊）。target_type=auto 时可省略。',
        },
        text: { type: 'string', description: '文本内容（可省略，只要有媒体也行）。' },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: '图片路径或 URL 列表。',
        },
        videos: {
          type: 'array',
          items: { type: 'string' },
          description: '视频路径或 URL 列表。',
        },
        records: {
          type: 'array',
          items: { type: 'string' },
          description: '语音文件路径或 URL 列表。',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: '要作为群/私聊文件发送的本地路径列表。',
        },
        faces: {
          type: 'array',
          items: { type: 'string' },
          description: 'QQ 表情 ID 列表，例如 ["14"]。',
        },
        at: { type: 'string', description: '群聊中要 @ 的 QQ 号。' },
        reply_to: { type: 'string', description: '要引用的 message_id。私聊会被忽略；群聊里有人 @ 你时才用。' },
      },
    },
    output: textOutput('发送结果'),
    timeoutMs: 120000,
    async execute(args) {
      return bridge.sendMessage(args);
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `QQ 发消息 → ${args.target_type || 'auto'} ${args.target_id || ''}`.trim(),
      kind: 'other',
      rawInput: { text: truncate(args.text || '', 500) },
    }),
  });

  register({
    name: 'qq_listen',
    description: [
      '绑定/解绑当前 Harness 会话与 QQ 消息的被动转发。',
      'start 后，来自已授权联系人（或 allowedGroups 里的群）的新消息会自动进入本会话并唤醒你；你可以直接用 qq_send_message(target_type="auto") 回复。',
      'types 可限制只转发 private 或 group。stop 停止转发。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'status'], description: 'start 开始转发；stop 停止；status 查看绑定。' },
        types: {
          type: 'array',
          items: { type: 'string', enum: ['private', 'group'] },
          description: '要转发的消息类型，默认两种都转发。',
        },
      },
      required: ['action'],
    },
    output: textOutput('监听状态'),
    async execute(args, exec) {
      if (args.action === 'start') {
        if (!exec.agent) throw new Error('qq_listen 必须在有会话的 Agent 中调用');
        return { ok: true, ...bridge.bindAgent(exec.agent, { types: args.types }) };
      }
      if (args.action === 'stop') {
        const sessionId = exec.agent?.id;
        if (!sessionId) throw new Error('qq_listen 必须在有会话的 Agent 中调用');
        return { ok: true, stopped: bridge.unbindAgent(sessionId) };
      }
      return {
        ok: true,
        bindings: [...bridge.bindings.entries()].map(([sessionId, binding]) => ({
          sessionId,
          types: [...binding.types],
          since: binding.since,
        })),
      };
    },
    presentCall: (args) => ({ card: 'generic', title: `QQ 消息监听：${args.action}`, kind: 'other' }),
  });

  register({
    name: 'qq_list_contacts',
    description: '列出机器人 QQ 的好友和群（用于确认 target_id）。返回 QQ 号、昵称、群号和群名。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['all', 'friends', 'groups'], description: '默认 all。' },
      },
    },
    output: textOutput('好友/群列表'),
    timeoutMs: 60000,
    async execute(args) {
      return bridge.listContacts(args.kind || 'all');
    },
  });

  register({
    name: 'qq_get_history',
    description: '读取某个私聊或群聊的最近消息记录。返回发送者、时间、文本和原始 message 段，可用于理解上下文或下载其中的媒体。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target_type: { type: 'string', enum: ['private', 'group'], description: '私聊或群聊。' },
        target_id: { type: 'string', description: 'QQ号或群号。' },
        count: { type: 'integer', minimum: 1, maximum: 100, description: '条数，默认 20。' },
      },
      required: ['target_type', 'target_id'],
    },
    output: textOutput('历史消息'),
    timeoutMs: 60000,
    async execute(args) {
      return bridge.getHistory(args);
    },
  });

  register({
    name: 'qq_get_forward',
    description: '展开一条合并转发消息（聊天记录）。message_id 来自收到的 forward 段。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        message_id: { type: 'string', description: '合并转发消息的 id。' },
      },
      required: ['message_id'],
    },
    output: textOutput('合并转发内容'),
    timeoutMs: 60000,
    async execute(args) {
      return bridge.getForward(args.message_id);
    },
  });

  register({
    name: 'qq_media_fetch',
    description: [
      '把 QQ 消息里的媒体或任意 URL 下载到本地，并把图片（含表情包、视频抽帧）作为图片附件返回给你直接观看。',
      '两种用法：url="https://..."；或 message_id + index（index 是这条消息里第几个图片/视频/文件，从 0 开始）。',
      '视频会自动抽帧；表情包/贴纸按图片处理。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: '要下载的 http(s) 或 file:// 地址。' },
        message_id: { type: 'string', description: '从某条 QQ 消息里取媒体。' },
        index: { type: 'integer', minimum: 0, description: '第几个媒体段，默认 0。' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, description: '下载的文件和图片附件' },
      render(_args, value) {
        const blocks = [{ type: 'text', text: JSON.stringify({ files: value.files ?? [], errors: value.errors ?? [] }, null, 2) }];
        for (const attachment of value.attachments ?? []) blocks.push({ type: 'image', attachment });
        return blocks;
      },
    },
    timeoutMs: 180000,
    async execute(args) {
      return bridge.fetchMedia(args);
    },
  });

  register({
    name: 'qq_qzone_publish',
    description: [
      '在机器人 QQ 的 QQ空间发表说说（文字 + 最多 9 张图）。',
      '这是公开发布行为，必须先获得用户授权：先调用 qq_permission_request(scope="qzone")，用户QQ回复“同意 <码>”后本工具才能执行。',
      'ugc_right: 1=所有人 4=好友 16=部分好友 64=仅自己 128=部分好友不可见（16/128 需 target_uins）。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        content: { type: 'string', description: '说说正文。' },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: '图片路径或 URL，最多 9 张。',
        },
        ugc_right: { type: 'integer', enum: [1, 4, 16, 64, 128], description: '可见范围，默认 1。' },
        target_uins: {
          type: 'array',
          items: { type: 'string' },
          description: 'ugc_right=16/128 时生效的 QQ 号列表。',
        },
      },
      required: ['content'],
    },
    output: textOutput('说说发布结果'),
    timeoutMs: 180000,
    async execute(args) {
      bridge.requirePermission('qzone', '在QQ空间发表说说');
      return bridge.publishQzone(args);
    },
    presentCall: (args) => ({ card: 'generic', title: '发表 QQ 空间说说', kind: 'other', rawInput: { content: truncate(args.content || '', 300) } }),
  });

  register({
    name: 'qq_permission_request',
    description: [
      '向用户申请本机软件/敏感操作授权。授权请求会发到用户的 QQ 私聊；用户回复“同意 <授权码>”后授权生效。',
      '可用 scope：' + SCOPE_ENUM.map((scope) => `${scope}(${SCOPES[scope].label})`).join('、') + '。',
      'wait_seconds 默认 60，最多 180；等待期间用户确认会直接返回 granted。若返回 pending，可稍后用 qq_permissions 查看，或让用户回复授权码。',
      '规则：启动/关闭/切换软件、截屏、模拟输入、读取工作区外文件、执行命令、发QQ空间之前，必须先拿到对应授权；不要绕过。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: { type: 'string', enum: SCOPE_ENUM, description: '权限作用域。' },
        reason: { type: 'string', description: '向用户说明用途（会显示在QQ消息里）。' },
        minutes: { type: 'integer', minimum: 1, maximum: 1440, description: '授权时长（分钟），默认按作用域。' },
        wait_seconds: { type: 'integer', minimum: 0, maximum: 180, description: '等待用户确认的秒数，默认 60。0=立即返回。' },
      },
      required: ['scope', 'reason'],
    },
    output: textOutput('授权结果'),
    timeoutMs: 200000,
    async execute(args) {
      return bridge.requestPermission(args);
    },
    presentCall: (args) => ({ card: 'generic', title: `申请授权：${SCOPES[args.scope]?.label ?? args.scope}`, kind: 'other', rawInput: { reason: args.reason } }),
  });

  register({
    name: 'qq_permissions',
    description: '查看当前有效的 QQ 授权和待确认请求；action=revoke 时按 scope 撤销某个授权。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['status', 'revoke'], description: '默认 status。' },
        scope: { type: 'string', enum: SCOPE_ENUM, description: 'revoke 时必填。' },
      },
    },
    output: textOutput('授权列表'),
    async execute(args) {
      if ((args.action || 'status') === 'revoke') {
        if (!args.scope) throw new Error('revoke 需要 scope');
        return { ok: true, revoked: bridge.revokePermission(args.scope), ...bridge.permissionStatus() };
      }
      return bridge.permissionStatus();
    },
  });

  register({
    name: 'qq_pair',
    description: [
      'QQ 配对管理。用户第一次私聊机器人时，机器人会回一个 6 位配对码；用户把配对码告诉你后，用 action=confirm, code="123456" 完成绑定。',
      'action=pending 列出未使用的配对码。配对成功后该 QQ 成为授权人，可以接收授权请求、与助手对话。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['pending', 'confirm'], description: 'pending 或 confirm。' },
        code: { type: 'string', description: 'confirm 时的 6 位配对码。' },
      },
      required: ['action'],
    },
    output: textOutput('配对结果'),
    async execute(args) {
      if (args.action === 'pending') return { pending: bridge.pendingPairs(), owners: [...bridge.owners], approvalPeer: bridge.approvalPeer || null };
      if (!args.code) throw new Error('confirm 需要 code');
      const result = await bridge.confirmPair(args.code);
      return { ok: true, ...result, owners: [...bridge.owners], approvalPeer: bridge.approvalPeer };
    },
    presentCall: (args) => ({ card: 'generic', title: `QQ 配对：${args.action}`, kind: 'other' }),
  });

  register({
    name: 'qq_app',
    description: [
      '控制本机软件：枚举窗口、启动、切换到前台、关闭、截屏、模拟键盘输入。',
      '所有动作都需要先获得授权（app_control / screen / input），否则会提示先调用 qq_permission_request。',
      'action=list 返回进程、PID、窗口标题；launch 的 target 是 exe 路径或命令名；activate/close 用 pid 或 title（模糊匹配）。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'launch', 'activate', 'close', 'screenshot', 'sendkeys'], description: '要执行的动作。' },
        target: { type: 'string', description: 'launch 时的程序路径或名称。' },
        args: { type: 'array', items: { type: 'string' }, description: 'launch 时的命令行参数。' },
        cwd: { type: 'string', description: 'launch 时的工作目录。' },
        pid: { type: 'integer', description: 'activate/close/sendkeys 的目标进程 PID。' },
        title: { type: 'string', description: 'activate/close/sendkeys 的窗口标题关键字。' },
        force: { type: 'boolean', description: 'close 时是否强制结束进程。' },
        text: { type: 'string', description: 'sendkeys 时要输入的文本。' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true, description: '软件控制结果' },
      render(_args, value) {
        const { attachment, ...rest } = value ?? {};
        const blocks = [{ type: 'text', text: JSON.stringify(rest, null, 2) }];
        if (attachment) blocks.push({ type: 'image', attachment });
        return blocks;
      },
    },
    timeoutMs: 90000,
    async execute(args) {
      return bridge.appAction(args);
    },
    presentCall: (args) => ({ card: 'generic', title: `QQ 软件控制：${args.action}`, kind: 'execute' }),
  });

  register({
    name: 'qq_memory_search',
    description: [
      '搜索 QQ 的「每日记忆」（每天 04:00 自动压缩的摘要）。用户提到以前的事、旧话题、之前说过/答应过什么时，先用它，不要翻全部聊天记录。',
      '返回按相关度排序的每日总览和各会话摘要；需要某天原文时再用 qq_memory_get 或 qq_get_history。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '关键词/人名/话题，例如“上次说的插件”“空间”“图片”。留空则返回最近几天。' },
        from: { type: 'string', description: '起始日期 YYYY-MM-DD（可选）。' },
        to: { type: 'string', description: '结束日期 YYYY-MM-DD（可选）。' },
        chat_type: { type: 'string', enum: ['private', 'group'], description: '只看私聊或群聊（可选）。' },
        chat_id: { type: 'string', description: '只看某个 QQ 号/群号（可选）。' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: '返回天数，默认 3。' },
      },
    },
    output: textOutput('每日记忆搜索结果'),
    async execute(args) {
      if (!bridge.memory) throw new Error('记忆库未启用');
      return bridge.memory.search(args.query || '', {
        from: args.from,
        to: args.to,
        chatType: args.chat_type,
        chatId: args.chat_id,
        limit: args.limit || 3,
      });
    },
    presentCall: (args) => ({ card: 'generic', title: `搜索 QQ 记忆：${truncate(args.query || '最近', 30)}`, kind: 'search' }),
  });

  register({
    name: 'qq_memory_get',
    description: '读取某一天的完整每日记忆（总览 + 各会话摘要 + 决定/待办/偏好/原话）。日期格式 YYYY-MM-DD。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        date: { type: 'string', description: '日期 YYYY-MM-DD。' },
      },
      required: ['date'],
    },
    output: textOutput('每日记忆'),
    async execute(args) {
      if (!bridge.memory) throw new Error('记忆库未启用');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(args.date || ''))) throw new Error('date 必须是 YYYY-MM-DD');
      const digest = await bridge.memory.get(args.date);
      if (!digest) throw new Error(`没有 ${args.date} 的记忆`);
      return digest;
    },
  });

  register({
    name: 'qq_memory_timeline',
    description: '按天列出最近的 QQ 记忆总览（一行一天），用于快速回忆“这几天聊了什么”。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 60, description: '天数，默认 7。' },
      },
    },
    output: textOutput('记忆时间线'),
    async execute(args) {
      if (!bridge.memory) throw new Error('记忆库未启用');
      return { days: bridge.memory.timeline(args.days || 7) };
    },
  });

  register({
    name: 'qq_memory_run',
    description: '手动补跑某天的记忆压缩（一般不需要，定时任务每天 04:00 自动跑）。date 省略时补跑最近一个已结束的窗口；force=true 会覆盖已有记忆。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        date: { type: 'string', description: '要补跑的日期 YYYY-MM-DD（该日 04:00 结束的 24 小时窗口）。' },
        force: { type: 'boolean', description: '覆盖已存在的每日记忆，默认 false。' },
      },
    },
    output: textOutput('记忆压缩结果'),
    timeoutMs: 600000,
    async execute(args) {
      if (!bridge.memory) throw new Error('记忆库未启用');
      const date = String(args.date || lastClosedDigestKey(new Date()));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date 必须是 YYYY-MM-DD');
      return bridge.memory.runDaily(date, { force: args.force === true });
    },
  });

  register({
    name: 'qq_bili_watch',
    description: '手动触发一次 B 站浏览（正常每天自动跑，这里用于测试）。会从常用号历史、小号历史或热门里挑一条视频，抽帧并记录。digest=true 时立刻把今天的日报发到主人 QQ。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        digest: { type: 'boolean', description: '立即发送今日日报，默认 false。' },
      },
    },
    output: textOutput('B站浏览结果'),
    timeoutMs: 300000,
    async execute(args) {
      return bridge.runBiliNow({ digest: args.digest === true });
    },
  });
}
