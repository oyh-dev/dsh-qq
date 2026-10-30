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

  /**
   * 只有绑定了 QQ 的会话才配往外发消息。
   *
   * 起因：任何会话都能调 qq_send_message，于是改代码时随手在别的会话里发一条调试的话，
   * 都会以「她说的」身份进聊天记录和记忆评分——语气就是这么被别的会话带偏的。
   * 没绑定的会话发东西，对我们来说等于别人借她的嘴说话。
   */
  const requireQqSession = (exec, tool = '这个工具') => {
    const agentId = exec?.agent?.id;
    if (!agentId) return; // 没有会话上下文（定时任务等）放行
    if (bridge.bindings?.has?.(agentId)) return;
    throw new Error(
      `${tool} 只能在绑定了 QQ 的会话里用。当前会话（${agentId}）没绑定——发出去会以她的口吻进聊天记录，把语气带偏。`
      + '要聊天请去 QQ 会话；要测试请让主人确认。',
    );
  };

  register({
    name: 'qq_bindings',
    description: [
      '查看/切换/清理 QQ 绑定会话。',
      'action=bind 可以在运行时把 QQ 改绑到指定会话（传入目标 session_id），立刻生效、不用重启；',
      '其余动作（list/unbind/block）只有已绑定 QQ 的会话才能调用。',
      'block 会把会话加进永久封禁名单（.qq-bridge/unbind.json），归档会话被点开也不会再爬回来。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'bind', 'unbind', 'block'], description: 'list 看绑定；bind 改绑到 session_id；unbind 解绑；block 解绑并永久封禁。' },
        session_id: { type: 'string', description: 'bind / unbind / block 时必填。' },
        types: {
          type: 'array',
          items: { type: 'string', enum: ['private', 'group'] },
          description: 'bind 时转发哪些类型，默认 ["private"]。',
        },
      },
      required: ['action'],
    },
    output: textOutput('绑定列表'),
    async execute(args, exec) {
      const action = String(args.action || 'list');
      // bind 是运维动作，故意允许在任意会话里调；其余动作仍然要求是 QQ 会话
      if (action !== 'bind') requireQqSession(exec, 'qq_bindings');
      if (action === 'bind') {
        const target = String(args.session_id || '').trim();
        if (!target) throw new Error('bind 需要 session_id');
        return bridge.bindAgent(target, args.types || ['private']);
      }
      const list = [...(bridge.bindings || new Map()).entries()].map(([sessionId, binding]) => ({
        sessionId,
        types: [...(binding?.types || [])],
        pending: Boolean(binding?.pending),
      }));
      if (action === 'unbind' || action === 'block') {
        const target = String(args.session_id || '').trim();
        if (!target) throw new Error(`${action} 需要 session_id`);
        if (action === 'block') {
          const result = await bridge.blockSession(target);
          return { ...result, bindings: list.filter((item) => item.sessionId !== target) };
        }
        const removed = bridge.unbindAgent(target);
        return { removed, bindings: list.filter((item) => item.sessionId !== target) };
      }
      return {
        bindings: list,
        // 每个陌生人那条聊天自己的会话（不在 bindings 里，别混着看）
        chatSessions: bridge.chatSessionsList?.() ?? [],
        blocked: [...(bridge.blockedSessions || [])],
      };
    },
  });

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
      '通过 QQ 主动发送消息（私聊或群聊）。文本、图片、视频、语音、文件、QQ表情、互动消息（骰子/石头剪刀布）、@、回复都支持。',
      'target_type 传 auto 时回复最近一次收到的 QQ 消息；也可以显式指定 private/group 和 target_id。',
      '图片/视频/文件可以传本地绝对路径或 http(s) URL；发送前会做 file:// 转换。',
      '想玩骰子或猜拳就用 dice / rps 参数传次数（1~5），QQ 会自己掷，结果随机。',
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
        dice: {
          type: 'integer',
          minimum: 1,
          maximum: 5,
          description: '发几个 QQ 随机骰子（1~5），结果由 QQ 随机掷出。',
        },
        rps: {
          type: 'integer',
          minimum: 1,
          maximum: 5,
          description: '发几个 QQ 石头剪刀布（1~5），结果由 QQ 随机出。',
        },
        at: { type: 'string', description: '群聊中要 @ 的 QQ 号。' },
        reply_to: { type: 'string', description: '要引用的 message_id。私聊会被忽略；群聊里有人 @ 你时才用。' },
      },
    },
    output: textOutput('发送结果'),
    timeoutMs: 120000,
    async execute(args, exec) {
      requireQqSession(exec, 'qq_send_message');
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
    name: 'qq_voice',
    description: [
      '用你自己的声音给主人发一条语音（只能发给他）。',
      'text 写你要念的话，一两句就好（默认上限 120 字）；语速和语气会跟着你的心情走。',
      '不想出声、只想发字就用 qq_send_message。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '要念出来的话。' },
      },
      required: ['text'],
    },
    output: textOutput('语音发送结果'),
    timeoutMs: 180000,
    async execute(args) {
      if (!args?.text) throw new Error('text 不能为空');
      return bridge.sendVoice({ text: String(args.text) });
    },
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
      '主人已授权本工具免授权调用；但公开发布是对外行为，发布前仍须先确认内容和可见范围，默认 ugc_right=4（仅好友）。',
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
        ugc_right: { type: 'integer', enum: [1, 4, 16, 64, 128], description: '可见范围，默认 4（仅好友）。' },
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
    async execute(args, exec) {
      requireQqSession(exec, 'qq_qzone_publish');
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
    description: [
      '自己翻会儿B站解闷：从主号历史、小号历史或热门里挑一条他没看过的视频，直接读流抽帧（不下载整条），整条均匀铺一遍再拼成几张图。',
      '**默认只先给你前两张拼图**——真刷视频也是点进去看两眼，不感兴趣就划走；不想看就 drop 或者干脆不理它（会记成没看完）。',
      '想接着看：{"more":true} 每次再给两张，直到看完。',
      '抽帧间隔随长度放大：短片 2 秒一帧，10 分钟约 17 秒一帧，最多 36 帧；超过 20 分钟的视频不看。',
      '这是「闲得没事干」的选项，不是任务——没有日报要交，没有任何人等你的结论。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        more: { type: 'boolean', description: '接着看手上这条（每次再给两张拼图）。' },
        drop: { type: 'boolean', description: '不看了，关掉手上这条，笔记会记成「没看完」。' },
        count: { type: 'integer', minimum: 1, maximum: 3, description: '旧参数，已废弃（一次只翻一条）。' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, description: '翻到的视频信息和拼图' },
      render(_args, value) {
        const videos = value.videos ?? [];
        if (value.closed && !videos.length) {
          const line = value.partial
            ? `关了《${value.title}》，看到第 ${value.shown}/${value.total} 张——记成没看完`
            : `《${value.title}》看完了（${value.total} 张）`;
          return [{ type: 'text', text: line }];
        }
        const head = videos.length === 0
          ? '这次没翻到新的（多半是今天都看过了，或者接口抽风）'
          : videos.map((v, i) => {
            const points = (v.points ?? []).map((line) => `     · ${line}`).join('\n');
            const progress = v.total ? `\n   看到 ${v.shown ?? 0}/${v.sheets ?? v.total} 张` : '';
            return `${i + 1}. 《${v.title}》 · ${v.author} · ${v.sourceLabel}\n   ${v.url}\n   ${v.duration ?? '?'} 秒${v.step ? `，每 ${v.step} 秒一帧` : ''}${v.frames ? `，共 ${v.frames} 帧` : ''}${v.audio ? '，口播已听' : '，只有画面'}${progress}${points ? `\n   口播要点：\n${points}` : ''}`;
          }).join('\n');
        const tail = [
          `今天翻过 ${value.watchedToday ?? 0}/${value.maxVideos ?? '?'} 条`,
          typeof value.remaining === 'number' && value.remaining > 0 ? `这条还剩 ${value.remaining} 张：想看 qq_bili_watch {"more":true}，不想看 {"drop":true}` : '',
        ].filter(Boolean).join(' · ');
        const blocks = [{ type: 'text', text: `${head}\n\n${tail}` }];
        for (const attachment of value.attachments ?? []) blocks.push({ type: 'image', attachment });
        return blocks;
      },
    },
    timeoutMs: 300000,
    async execute(args) {
      return bridge.runBiliNow({ more: args.more === true, drop: args.drop === true });
    },
  });

  register({
    name: 'qq_meme_save',
    description: [
      '把梗记进梗笔记本（同名会合并补充）。看到梗百科/名场面视频、或者聊天里遇到新梗时用：记梗名 + 含义 + 聊天里怎么用。',
      '被他纠正过之后就用这个把讨论的结果改回来——记清楚的，status 留 ok；自己也没底、只是「大概是这样」的，写 doubt，下次用到之前先查。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: '梗的名字/说法：他或视频里怎么叫就怎么写。' },
        meaning: { type: 'string', description: '这个梗是什么意思、出处是什么（一句话）。' },
        usage: { type: 'string', description: '聊天里怎么用、什么场合抛出来合适（一句话）。' },
        origin: { type: 'string', description: '来源视频标题或出处（可选）。' },
        bvid: { type: 'string', description: '来源 BV 号（可选）。' },
        status: {
          type: 'string',
          enum: ['ok', 'doubt', 'conflict'],
          description: '可选。ok=这条我有把握；doubt=还没底；conflict=听过两种打架的说法。',
        },
      },
      required: ['name', 'meaning'],
    },
    output: textOutput('梗笔记保存结果'),
    async execute(args) {
      const { entry, created, conflicted } = await bridge.memes.add({
        ...args,
        status: args.status,
      });
      return { ok: true, created, conflicted: conflicted === true, total: bridge.memes.count(), entry };
    },
  });

  register({
    name: 'qq_meme_search',
    description: '查梗笔记本：某个说法/梗是什么意思、怎么用。聊天里遇到看不懂的梗先查这个，别瞎猜。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '关键词或梗名；留空返回最近记的几条。' },
        limit: { type: 'integer', description: '返回条数，默认 5。', minimum: 1, maximum: 20 },
      },
    },
    output: textOutput('梗搜索结果'),
    async execute(args) {
      const limit = Math.max(1, Math.min(20, Number(args.limit) || 5));
      const query = String(args.query || '').trim();
      const entries = query ? bridge.memes.search(query, limit) : bridge.memes.recent(limit);
      return { total: bridge.memes.count(), query, entries };
    },
  });

  register({
    name: 'qq_meme_watch',
    description: [
      '自己挑一条梗百科视频看：直接读流抽帧（不下载整条），整条铺满后拼成几张图给你，看完想记就用 qq_meme_save 记进笔记本。',
      '抽帧比解闷那条路更密（最短 2.5 秒一帧，最多 30 帧），因为梗多半写在画面上；超过 20 分钟的视频不看。',
      '这个没有定时任务、没有人催——想看才看；看不懂、标题党、觉得没意思的，一个字都不用记。',
      'up 可以点名看某个 UP 的（比如「十万个梗百科」），不填就轮流来。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        up: { type: 'string', description: '想看哪个 UP 的梗视频，名字或 mid；不填随机。' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, description: '梗视频信息和拼图' },
      render(_args, value) {
        const head = `《${value.title}》 · ${value.author || '未知UP'}${value.upName ? ` · 来自 ${value.upName}` : ''}\n`
          + `https://www.bilibili.com/video/${value.bvid}\n`
          + `${value.duration ?? '?'} 秒、${value.frames ?? '?'} 帧${value.step ? `（每 ${value.step} 秒一帧）` : ''}`;
        const desc = value.desc ? `\n简介：${value.desc}` : '';
        const points = (value.points ?? []).map((line) => `   · ${line}`).join('\n');
        const heard = value.audio ? `\n口播要点：\n${points}` : '\n（这条没听清口播，只有画面）';
        const tail = `\n笔记本已经有 ${value.notebookSize ?? '?'} 条梗`;
        const blocks = [{ type: 'text', text: `${head}${desc}${heard}${tail}` }];
        for (const attachment of value.attachments ?? []) blocks.push({ type: 'image', attachment });
        return blocks;
      },
    },
    timeoutMs: 300000,
    async execute(args) {
      return bridge.runMemeNow({ up: args.up || '' });
    },
  });

  register({
    name: 'qq_watch_notes',
    description: [
      '翻自己看过的视频笔记：每条一条记录，存着标题、UP、时长和 3-6 条口播要点（原始音频和逐字稿存下来就是为了一步压缩，压完就删了）。',
      '这是「我看过什么」的库，跟记忆、梗笔记分开放的；平时不占上下文，想用才查。',
      'action=search（关键词）/ list（最近几条）/ get（要 bvid）。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['search', 'list', 'get'], description: '默认 search。' },
        query: { type: 'string', description: 'search 用的关键词（标题/要点/梗名都能命中）。' },
        bvid: { type: 'string', description: 'get 用的 BV 号。' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: '返回几条，默认 5。' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, description: '看过的视频笔记' },
      render(_args, value) {
        const entries = value.entries ?? [];
        if (entries.length === 0) return [{ type: 'text', text: '还没有看过的视频笔记' }];
        const lines = entries.map((item, index) => {
          const head = `${index + 1}. 《${item.title}》 · ${item.author || '未知UP'} · ${item.duration}s`;
          const points = (item.points ?? []).map((line) => `   · ${line}`).join('\n');
          const memes = (item.memes ?? []).length ? `\n   提到的梗：${item.memes.join('、')}` : '';
          const src = item.source === 'asr' ? '' : '\n   （这条没有口播记录，只有画面看过的痕迹）';
          return `${head}\n${points}${memes}${src}`;
        });
        return [{ type: 'text', text: lines.join('\n\n') }];
      },
    },
    async execute(args) {
      const action = String(args.action || 'search');
      const limit = Math.max(1, Math.min(20, Number(args.limit) || 5));
      if (action === 'get') {
        const entry = bridge.watchNotes.get(args.bvid);
        if (!entry) throw new Error(`没有 ${args.bvid} 的笔记`);
        return { entries: [entry] };
      }
      if (action === 'list') return { entries: bridge.watchNotes.list(limit) };
      return { entries: bridge.watchNotes.search(args.query || '', limit) };
    },
  });

  register({
    name: 'qq_sticker_save',
    description: '把一张图收进表情库（只存不用，自己挑着发）。可以用 message_id + index 从 QQ 消息里取，也可以给本地路径或 http(s) 链接。表情包、动图、梗图都行。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        message_id: { type: 'string', description: '从这条 QQ 消息里取图（配合 index）。' },
        index: { type: 'integer', description: '这条消息里第几张图/表情，从 0 开始，默认 0。', minimum: 0 },
        path: { type: 'string', description: '本地图片路径（与 message_id 二选一）。' },
        url: { type: 'string', description: '图片 http(s) 链接（与 path/message_id 三选一）。' },
        name: { type: 'string', description: '给表情起个短名字（方便以后按名字发），比如一个能看懂的动作或情绪。' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签，例如 ["嘲讽","可爱"]。' },
      },
    },
    output: textOutput('表情保存结果'),
    timeoutMs: 60000,
    async execute(args) {
      let image;
      if (args.message_id) image = await bridge.stickerFromMessage(args.message_id, args.index ?? 0);
      else image = await bridge.stickerFromSource(args.path || args.url || '');
      const animated = image.mediaType === 'image/gif' || /\.gif$/i.test(image.path || '');
      const result = await bridge.stickers.add({
        bytes: image.bytes,
        mediaType: image.mediaType,
        name: args.name,
        tags: args.tags,
        animated,
        source: 'manual',
      });
      return { ...result, total: bridge.stickers.count() };
    },
  });

    register({
    name: 'qq_sticker_search',
    description: '按名字/标签/hash 搜表情库；留空返回最近几条。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '关键词；hash 前几位也可以。' },
        limit: { type: 'integer', description: '条数，默认 5。', minimum: 1, maximum: 20 },
      },
    },
    output: textOutput('表情搜索结果'),
    async execute(args) {
      return { stats: bridge.stickers.stats(), entries: bridge.stickers.search(args.query, Math.max(1, Math.min(20, Number(args.limit) || 5))) };
    },
  });

  register({
    name: 'qq_sticker_send',
    description: '把表情库里的某个表情发出去（需要先 qq_sticker_search/list 拿到 hash 或名字）。私聊/群聊都行。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        key: { type: 'string', description: '表情的 hash、名字或标签。' },
        target_type: { type: 'string', enum: ['private', 'group'], description: '私聊或群聊。' },
        target_id: { type: 'string', description: 'QQ 号或群号。' },
        reply_to: { type: 'string', description: '群聊里要引用的 message_id（可选）。' },
      },
      required: ['key', 'target_type', 'target_id'],
    },
    output: textOutput('表情发送结果'),
    async execute(args, exec) {
      requireQqSession(exec, 'qq_sticker_send');
      const entry = bridge.stickers.find(args.key);
      if (!entry) throw new Error(`表情库里找不到「${args.key}」`);
      const segments = [{ type: 'image', data: { file: entry.file } }];
      if (args.target_type === 'group') {
        const result = await bridge.sendGroup(String(args.target_id), segments, args.reply_to);
        return { ok: true, sent: entry.hash, message_id: result?.message_id ?? null };
      }
      const result = await bridge.sendPrivate(String(args.target_id), segments);
      return { ok: true, sent: entry.hash, message_id: result?.message_id ?? null };
    },
  });

      register({
    name: 'qq_sticker_rename',
    description: '给表情库里的表情改名字/换标签（按 hash、名字或标签定位）。改完就能用新名字 qq_sticker_send。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        key: { type: 'string', description: '要改的表情：hash、旧名字或标签。' },
        name: { type: 'string', description: '新名字。' },
        tags: { type: 'array', items: { type: 'string' }, description: '新标签（会替换旧标签）。' },
      },
      required: ['key'],
    },
    output: textOutput('表情改名结果'),
    async execute(args) {
      const entry = await bridge.renameSticker(args.key, { name: args.name, tags: args.tags });
      return { ok: true, entry };
    },
  });

  register({
    name: 'qq_strangers',
    description: '陌生人会话名额管理：list 看当前放行/等待名单，remove 踢掉一个已放行的（释放名额）。放行和拒绝要在 QQ 私聊里回「放行 1234」/「拒绝 1234」。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'remove'], description: '默认 list。' },
        uin: { type: 'string', description: 'action=remove 时要踢掉的 QQ 号。' },
      },
    },
    output: textOutput('陌生人名单'),
    async execute(args) {
      if (args?.action === 'remove') {
        if (!args.uin) throw new Error('要给 uin');
        return bridge.removeStranger(args.uin);
      }
      return bridge.strangerList();
    },
  });

  register({
    name: 'qq_chat_session',
    description: '把某个聊天指到指定会话：list 看映射，set 挂上（chat 写 private-<QQ号> 或 group-<群号>），unset 拆掉。用于「他在 UI 里手建了一个会话，想把那个陌生人的私聊指过去」——手建的会话已经在册，侧栏看得见。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'set', 'unset'], description: '默认 list。' },
        chat: { type: 'string', description: 'private-3364610388 或 group-1005419617。' },
        session_id: { type: 'string', description: 'action=set 时的目标会话 id（session-xxxx）。' },
      },
    },
    output: textOutput('聊天→会话映射'),
    async execute(args) {
      const action = String(args?.action || 'list');
      if (action === 'set') {
        if (!args.chat || !args.session_id) throw new Error('set 需要 chat 和 session_id');
        return bridge.setChatSession(args.chat, args.session_id);
      }
      if (action === 'unset') {
        if (!args.chat) throw new Error('unset 需要 chat');
        return bridge.unsetChatSession(args.chat);
      }
      return { list: bridge.chatSessionsList?.() ?? [] };
    },
  });

  register({
    name: 'qq_sleep',
    description: '睡眠状态：status 看醒着还是睡着、欠睡多少、纸条几条；sleep 让她去睡（睡着后他的消息会压成小纸条）；wake 叫醒并把纸条放出来。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['status', 'sleep', 'wake'], description: '默认 status。' },
        reason: { type: 'string', description: 'action=sleep 时的原因（夜晚/下午觉/累了）。' },
      },
    },
    output: textOutput('睡眠状态'),
    async execute(args) {
      const action = String(args?.action || 'status');
      if (action === 'sleep') return bridge.enterSleep({ reason: String(args?.reason || '手动') });
      if (action === 'wake') return bridge.wakeUp({});
      return {
        sleep: bridge.sleep?.snapshot?.() ?? null,
        energy: bridge.energy?.snapshot?.() ?? null,
      };
    },
  });

  register({
    name: 'qq_consent',
    description: '边界与申请权：list 看有哪些我说过不接的事（还锁着几天 / 是否到了可以正式问一次）；answer 记她的回答——她答"行"就解锁，答"不"再锁 7 天。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'answer'], description: '默认 list。' },
        topic: { type: 'string', description: 'answer 时的条目名（list 里看到的那一串）。' },
        ok: { type: 'boolean', description: 'answer 时：她说可以写 true，说不写 false。' },
      },
    },
    output: textOutput('边界申请权'),
    async execute(args) {
      const action = String(args?.action || 'list');
      if (action === 'answer') {
        if (!args?.topic) throw new Error('answer 需要 topic');
        return bridge.answerConsent(String(args.topic), Boolean(args.ok));
      }
      return bridge.consentList();
    },
  });

  register({
    name: 'qq_gamble',
    description: '赌局记账（良知）：押注 bet / 赌赢 win / 赌输 lose / 收手 quit。任何赌性质的游戏（21 点、德州、押大小、抽卡梭哈……）都能用；不调用也会按关键词自动认，这一条是给说不准的时候自己报一声。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['bet', 'win', 'lose', 'quit'], description: '这一下是什么动作。' },
        weight: { type: 'number', description: '力度 0.1–1，默认按动作给（押 0.6 / 赢输 0.7 / 收手 0.8）。' },
      },
      required: ['action'],
    },
    output: textOutput('赌局记账'),
    async execute(args) {
      return bridge.recordGamble(String(args?.action || ''), { weight: args?.weight });
    },
  });

  register({
    name: 'qq_sticker_import',
    description: '从 qq-media 批量导入表情：中文命名的图片文件（mode=files，默认）或中文文件夹内的图片（mode=folders）。名字成为表情名和标签；replace=true 会先备份再清空现有表情库。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        replace: { type: 'boolean', description: '是否先清空现有表情库（会备份成 json 文件）。' },
        mode: { type: 'string', enum: ['files', 'folders', 'both'], description: 'files=只导根目录中文图片文件（默认）；folders=只导中文文件夹内图片；both=两者都导。' },
      },
    },
    output: textOutput('表情导入结果'),
    timeoutMs: 120000,
    async execute(args) {
      return bridge.importStickersFromFolders({ replace: Boolean(args.replace), mode: args.mode || 'files' });
    },
  });

  register({
    name: 'qq_diary_write',
    description: '写一条自己的日记（碎碎念、今天发生的事、心情）。按天存 Markdown，可以一次写很多条，攒着以后给主人看。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '日记正文，第一人称，像自己对着本子说话。' },
        mood: { type: 'string', description: '当时的心情标签，例如"困""开心""有点酸"。' },
        tags: { type: 'array', items: { type: 'string' }, description: '关键词标签，方便以后搜。' },
      },
      required: ['text'],
    },
    output: textOutput('日记写入结果'),
    async execute(args) {
      if (!bridge.diaryCfg.enabled) throw new Error('日记功能未启用');
      const result = await bridge.diary.append({ text: args.text, mood: args.mood, tags: args.tags });
      return { ok: true, ...result };
    },
  });

  register({
    name: 'qq_diary_read',
    description: '读日记：不给日期读最近几天，给 YYYY-MM-DD 读那一天。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        date: { type: 'string', description: '哪一天，YYYY-MM-DD；留空看最近几天。' },
        limit: { type: 'integer', description: '最近几天，默认 3。', minimum: 1, maximum: 30 },
      },
    },
    output: textOutput('日记内容'),
    async execute(args) {
      if (!bridge.diaryCfg.enabled) throw new Error('日记功能未启用');
      if (args.date) return bridge.diary.read(args.date);
      return { recent: await bridge.diary.recent(Math.max(1, Math.min(30, Number(args.limit) || 3))) };
    },
  });

  register({
    name: 'qq_diary_search',
    description: '在日记里搜关键词（一个词就行），返回命中的日期和句子。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '关键词。' },
        limit: { type: 'integer', description: '最多几条，默认 10。', minimum: 1, maximum: 30 },
      },
      required: ['query'],
    },
    output: textOutput('日记搜索结果'),
    async execute(args) {
      if (!bridge.diaryCfg.enabled) throw new Error('日记功能未启用');
      return { hits: await bridge.diary.search(args.query, Math.max(1, Math.min(30, Number(args.limit) || 10))) };
    },
  });

  register({
    name: 'qq_weather',
    description: '查天气。给别人查时必须带 city（城市名，属于公开信息，不需要授权）；只有给主人查可以省略 city，用配置里的默认城市。不要为了推断别人的位置去查 IP，也不要追踪。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        city: { type: 'string', description: '城市名，例如"哈尔滨""上海"。给别人查必填。' },
        owner: { type: 'boolean', description: 'true = 查主人的天气（用默认城市），仅限主人。' },
        fresh: { type: 'boolean', description: '跳过缓存重新拉一次，默认 false。' },
      },
    },
    output: textOutput('天气查询结果'),
    timeoutMs: 30000,
    async execute(args) {
      if (!bridge.weatherCfg.enabled) throw new Error('天气功能未启用');
      const city = String(args.city || '').trim();
      if (!city && args.owner !== true) {
        throw new Error('给别人查天气需要提供城市名；不通过猜测位置获取');
      }
      const data = await bridge.weather.get(city || bridge.weatherCfg.defaultCity, { fresh: args.fresh === true });
      return { ok: true, data, text: bridge.weather.format(data) };
    },
  });

  register({
    name: 'qq_gallery_add',
    description: '手动把一张图收进「图片记忆」：可以从某条 QQ 消息取、本地路径或链接，并顺便写说明。日常主人发的图会自动入库，这个用于补录历史图片。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        message_id: { type: 'string', description: '从这条 QQ 消息取图（配合 index）。' },
        index: { type: 'integer', description: '第几张，从 0 开始，默认 0。', minimum: 0 },
        path: { type: 'string', description: '本地图片路径。' },
        url: { type: 'string', description: '图片链接。' },
        caption: { type: 'string', description: '一句话说明这张图是什么。' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签。' },
      },
    },
    output: textOutput('图片入库结果'),
    timeoutMs: 60000,
    async execute(args) {
      if (!bridge.galleryCfg.enabled) throw new Error('图片记忆未启用');
      const source = args.message_id
        ? await bridge.stickerFromMessage(args.message_id, args.index ?? 0)
        : await bridge.stickerFromSource(args.path || args.url || '');
      const result = await bridge.gallery.add({
        bytes: source.bytes,
        mediaType: source.mediaType,
        name: source.path,
        meta: { day: bridge._localDay(), context: args.caption || '', caption: args.caption || '', tags: args.tags, fromName: '手动补录' },
      });
      return { ...result, total: bridge.gallery.entries.length };
    },
  });

  register({
    name: 'qq_gallery_search',
    description: '在「图片记忆」里搜图：按关键词（说明、标签、随图文字）、日期范围、会话找以前看过的图。返回 hash、尺寸、日期和可点开的本地路径。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '关键词，比如图里出现过的东西、截图类型。' },
        from: { type: 'string', description: '起始日期 YYYY-MM-DD。' },
        to: { type: 'string', description: '结束日期 YYYY-MM-DD。' },
        chat_id: { type: 'string', description: '只看某个 QQ 号/群号。' },
        limit: { type: 'integer', description: '条数，默认 8。', minimum: 1, maximum: 50 },
      },
    },
    output: textOutput('图片搜索结果'),
    async execute(args) {
      if (!bridge.galleryCfg.enabled) throw new Error('图片记忆未启用');
      return {
        entries: bridge.gallery.search({
          query: args.query,
          from: args.from,
          to: args.to,
          chatId: args.chat_id,
          limit: args.limit,
        }),
      };
    },
  });

  register({
    name: 'qq_gallery_recent',
    description: '看图片记忆里最近的几张图。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', description: '张数，默认 8。', minimum: 1, maximum: 30 },
      },
    },
    output: textOutput('最近图片'),
    async execute(args) {
      if (!bridge.galleryCfg.enabled) throw new Error('图片记忆未启用');
      return { entries: bridge.gallery.recent(Number(args.limit) || 8) };
    },
  });

  register({
    name: 'qq_gallery_note',
    description: '给图库里的某张图补说明和标签（按 hash 或关键词定位），方便以后搜到。说明写你自己看到的内容，不要编。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        key: { type: 'string', description: 'hash、说明关键词或随图文字。' },
        caption: { type: 'string', description: '一句话说明这张图是什么。' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签。' },
      },
      required: ['key'],
    },
    output: textOutput('图片标注结果'),
    async execute(args) {
      if (!bridge.galleryCfg.enabled) throw new Error('图片记忆未启用');
      return { ok: true, entry: await bridge.gallery.note(args.key, { caption: args.caption, tags: args.tags }) };
    },
  });

  register({
    name: 'qq_gallery_send',
    description: '把图库里的图重新发出去（按 hash 或关键词定位）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        key: { type: 'string', description: 'hash 或关键词。' },
        target_type: { type: 'string', enum: ['private', 'group'] },
        target_id: { type: 'string', description: 'QQ 号或群号。' },
      },
      required: ['key', 'target_type', 'target_id'],
    },
    output: textOutput('图片发送结果'),
    async execute(args, exec) {
      requireQqSession(exec, 'qq_gallery_send');
      if (!bridge.galleryCfg.enabled) throw new Error('图片记忆未启用');
      const entry = bridge.gallery.get(args.key);
      if (!entry) throw new Error(`图库里找不到「${args.key}」`);
      const segments = [{ type: 'image', data: { file: entry.file } }];
      if (args.target_type === 'group') {
        const result = await bridge.sendGroup(String(args.target_id), segments);
        return { ok: true, hash: entry.hash, message_id: result?.message_id ?? null };
      }
      const result = await bridge.sendPrivate(String(args.target_id), segments);
      return { ok: true, hash: entry.hash, message_id: result?.message_id ?? null };
    },
  });

  register({
    name: 'qq_persona_reload',
    description: '重新读取人格文件（qq-persona.txt），不用重启插件。改完人设后调用它，再用 qq_status 确认 sections。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: textOutput('人格重载结果'),
    async execute() {
      const count = await bridge.persona.load();
      return {
        ok: true,
        source: bridge.persona.source,
        file: bridge.personaCfg.file,
        sections: bridge.persona.names(),
        count,
      };
    },
  });

  register({
    name: 'qq_poke',
    description: '双击对方头像（拍一拍）。私聊传 target_type=private + target_id=QQ号；群聊传 target_type=group + target_id=群号 + user_id=要拍的人。别人连拍时不要一直回拍。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target_type: { type: 'string', enum: ['private', 'group'] },
        target_id: { type: 'string', description: '私聊的 QQ 号 / 群号。' },
        user_id: { type: 'string', description: '群聊里要拍的人；私聊可省略。' },
      },
      required: ['target_type', 'target_id'],
    },
    output: textOutput('拍一拍结果'),
    async execute(args, exec) {
      requireQqSession(exec, 'qq_poke');
      if (args.target_type === 'group') {
        const userId = String(args.user_id || '').trim();
        if (!userId) throw new Error('群聊需要 user_id');
        return bridge.sendPoke({ userId, groupId: String(args.target_id) });
      }
      return bridge.sendPoke({ userId: String(args.target_id) });
    },
  });

  register({
    name: 'qq_judgment',
    description: '认知层：记下/推翻「我对主人是个什么人的判断」。记忆记的是发生过什么，这里记的是我据此认定了什么——判断必须挂在他的一句原话上，没有出处不许记。同一句判断再记一次会变成「确认过 N 次」。他说「不是这样」时用 action=revoke 推翻，旧记录保留、标记 superseded。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['add', 'revoke', 'list'], description: 'add 记一条，revoke 推翻一条，list 看现在都认定了什么。' },
        text: { type: 'string', description: 'add 必填：判断本身，一句话，去掉情绪词、能当事实读。' },
        quote: { type: 'string', description: 'add 必填：他说的那句原话，逐字摘，这条判断的出处。' },
        day: { type: 'string', description: 'add 可选：出处日期 YYYY-MM-DD，默认今天。' },
        key: { type: 'string', description: 'revoke 必填：要推翻哪条——判断原文、片段或者 id 都行。' },
        reason: { type: 'string', description: 'revoke 可选：他为什么否掉了它（原话最好）。' },
      },
      required: ['action'],
    },
    output: textOutput('认知层结果'),
    async execute(args) {
      const store = bridge.judgments;
      if (!store) throw new Error('认知层未启用');
      await store.load();
      const action = String(args.action || 'list');
      if (action === 'add') {
        const result = await store.add({
          text: args.text,
          quote: args.quote,
          day: args.day || bridge._localDay(),
        });
        bridge.log(`认知${result.merged ? '再次确认' : '新增'}: ${result.record.text}（确认 ${result.record.confirmed} 次）`);
        return { merged: result.merged, record: result.record };
      }
      if (action === 'revoke') {
        const result = await store.revoke({ key: args.key, reason: args.reason });
        bridge.log(`认知被推翻: ${result.record.text}${args.reason ? `（${args.reason}）` : ''}`);
        return { revoked: true, record: result.record };
      }
      const stats = await store.stats();
      return { ...stats, active: store.rank().map((record) => ({ id: record.id, text: record.text, day: record.day, confirmed: record.confirmed })) };
    },
  });

  register({
    name: 'qq_feel_better',
    description: '当刚才这段对话真的让你心情变好（被哄、被夸、聊得开心、气顺了），调用它把怨气值降 1 点。不用每句都调，自己判断：确实开心了才降；没感觉就别调，别为了讨好乱降。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string', description: '为什么心情变好了，一句话，给自己看。' },
        amount: { type: 'integer', description: '降多少，默认 1，最多 2。' },
      },
    },
    output: textOutput('怨气值'),
    async execute(args) {
      const state = bridge.attachment;
      if (!state) throw new Error('粘人状态未启用');
      const amount = Math.max(1, Math.min(2, Number(args.amount) || 1));
      const result = await state.relax(amount, bridge._localDay());
      bridge.log(`心情变好: 怨气 ${result.before} -> ${result.after}${args.reason ? ` (${args.reason})` : ''}`);
      return {
        grievance: result.after,
        before: result.before,
        sootheNeed: result.sootheNeed,
        note: `下一次消气需要 ${result.sootheNeed} 次回话`,
      };
    },
  });

  register({
    name: 'qq_image_gen',
    description: '按提示词生成一张图并直接发出去（免费公开接口，零成本，排队可能慢）。提示词写清主体、风格、构图；生成完自动发到目标会话，不用再手动发一次。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: '画面描述，中文英文都行。' },
        target_type: { type: 'string', enum: ['auto', 'private', 'group'], description: '不填就是最近会话。' },
        target_id: { type: 'string', description: 'QQ 号或群号。' },
        width: { type: 'integer', description: '宽，默认按配置（768）。' },
        height: { type: 'integer', description: '高，默认按配置（1024）。' },
        seed: { type: 'integer', description: '种子，复现同一张图用。' },
      },
      required: ['prompt'],
    },
    output: textOutput('生图结果'),
    async execute(args, exec) {
      requireQqSession(exec, 'qq_image_gen');
      const result = await bridge.generateImage({
        prompt: args.prompt,
        width: args.width,
        height: args.height,
        seed: args.seed,
      });
      const { targetType, targetId } = bridge._resolveTarget(args);
      const sent = await bridge.sendMessage({ target_type: targetType, target_id: targetId, images: [result.path] });
      return {
        ok: true,
        path: result.path,
        bytes: result.bytes,
        prompt: result.prompt,
        messageId: sent?.message_id || null,
      };
    },
  });

  register({
    name: 'qq_set_remark',
    description: '改主人好友的备注（只有主人本人可以改）。想把对方的名字改成平时叫的那个称呼时用，比如把备注改成“渡渡”。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        remark: { type: 'string', description: '新备注，最多 30 字。' },
        user_id: { type: 'string', description: 'QQ 号，默认主人。' },
      },
      required: ['remark'],
    },
    output: textOutput('备注结果'),
    async execute(args) {
      return bridge.setFriendRemark({ userId: args.user_id, remark: args.remark });
    },
  });

  register({
    name: 'qq_set_relationship',
    description: '把你们在 QQ 上绑定的关系记到本地（他邀请、你确认之后用）。记下之后每个会话都能看到这层关系，不会装不知道。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', description: '关系类型，例如 情侣 / 闺蜜 / 死党。' },
        note: { type: 'string', description: '想留一句什么，比如绑定那天他说的话。' },
      },
      required: ['type'],
    },
    output: textOutput('关系记录'),
    async execute(args) {
      return bridge.setRelationship({ type: args.type, note: args.note });
    },
  });

  register({
    name: 'qq_recall',
    description: '撤回自己刚发出去的消息（发错了、说岔了、他指出来那句不对时用）。QQ 只允许短时间窗口内撤回，通常两分钟内；超时会报错。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        message_id: { type: 'string', description: '要撤回的消息 id；不填就撤回自己最近发的那条。' },
        index: { type: 'integer', description: '不填 message_id 时，往回数第几条，0 = 最近一条。' },
      },
    },
    output: textOutput('撤回结果'),
    async execute(args, exec) {
      requireQqSession(exec, 'qq_recall');
      return bridge.recallMessage({ messageId: args.message_id, index: args.index });
    },
  });

  register({
    name: 'qq_qzone_read',
    description: '读主人自己的 QQ 空间说说列表（只允许主人本人，不读别人）。想看他最近发了什么、想接他的话时用；读完别复述全文，挑有意思的聊。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', description: '读几条，默认 10，最多 30。' },
        uin: { type: 'string', description: 'QQ 号，只有主人本人的才允许，默认就是主人。' },
      },
    },
    output: textOutput('空间说说'),
    async execute(args) {
      return bridge.readQzone({ uin: args.uin, limit: args.limit });
    },
  });
}
