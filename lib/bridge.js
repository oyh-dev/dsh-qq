import path from 'node:path';
import { readFile, appendFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { randomId, toInt, sleep, readJson, writeJson, ensureDir, asId, nowIso, safeFileName, truncate, errorMessage } from './util.js';
import { OneBotClient } from './onebot.js';
import { MediaStore, detectImageType, toFileUri } from './media.js';
import { PermissionBroker, SCOPES } from './permissions.js';
import { AppController } from './appcontrol.js';
import { SendGuard } from './sendguard.js';
import { BiliClient } from './bili.js';
import { MemoryStore, redact } from './memory.js';

const MEDIA_TIMEOUT = 60000;

export class QqBridge {
  constructor({ ctx, config = {}, logger, llm, defaultModel }) {
    this.ctx = ctx;
    this.logger = logger ?? ((message) => console.log(`[qq] ${message}`));
    const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
    const dataDir = path.resolve(config.dataDir || path.join(home, 'qq-bridge'));
    this.cfg = {
      wsUrl: String(config.wsUrl || 'ws://127.0.0.1:3001'),
      token: String(config.token || ''),
      account: String(config.account || ''),
      dataDir,
      mediaDir: path.resolve(config.mediaDir || path.join(dataDir, 'media')),
      ffmpeg: String(config.ffmpeg || ''),
      ownerUins: normalizeIdList(config.ownerUins),
      allowedGroups: normalizeIdList(config.allowedGroups),
      approvalTimeoutSec: toInt(config.approvalTimeoutSec, 300),
      permissionWaitSec: toInt(config.permissionWaitSec, 60),
      autoPair: config.autoPair !== false,
      forwardSelf: config.forwardSelf === true,
      maxImages: toInt(config.maxImages, 6),
      maxVideoFrames: toInt(config.maxVideoFrames, 24),
      videoFps: Math.max(0.5, Number(config.videoFps) || 5),
      maxVideoBytes: toInt(config.maxVideoBytes, 200 * 1024 * 1024),
      maxImageBytes: toInt(config.maxImageBytes, 20 * 1024 * 1024),
      quietStrangerReply: config.quietStrangerReply === true,
      memoryEnabled: config.memoryEnabled !== false,
      memoryDir: path.resolve(config.memoryDir || path.join(dataDir, 'memory')),
      memoryContextDays: toInt(config.memoryContextDays, 7),
      memoryRetentionDays: toInt(config.memoryRetentionDays, 90),
      mergeWindowMs: toInt(config.mergeWindowMs, 2600),
      mergeQuickMs: toInt(config.mergeQuickMs, 1000),
      maxMergeMs: toInt(config.maxMergeMs, 9000),
      sendGuard: config.sendGuard && typeof config.sendGuard === 'object' ? config.sendGuard : {},
      chatLogEnabled: config.chatLogEnabled !== false,
      chatLogDir: path.resolve(config.chatLogDir || path.join(dataDir, 'chats')),
      slowReply: config.slowReply && typeof config.slowReply === 'object' ? config.slowReply : {},
      proactive: config.proactive && typeof config.proactive === 'object' ? config.proactive : {},
      biliDaily: config.biliDaily && typeof config.biliDaily === 'object' ? config.biliDaily : {},
    };

    this.stateFile = path.join(this.cfg.dataDir, 'state.json');
    this.state = { owners: [], approvalPeer: '', grants: {}, pairs: [], bili: null };
    this.owners = new Set(this.cfg.ownerUins);
    this.approvalPeer = '';
    this.pairCodes = new Map();
    this.bindings = new Map();
    this.queues = new Map();
    this.lastInbound = new Map();
    this.lastGlobal = null;
    this.seen = new Map();
    this.strangerNotified = new Map();
    this.logs = [];
    this.selfId = null;
    this.nickname = '';
    this.connection = 'disconnected';
    this.connectionError = '';
    this.started = false;
    this.startedAt = nowIso();
    this._eventChain = Promise.resolve();
    this._contactsCache = { friends: null, groups: null, at: 0 };
    this._savedMedia = new Map();
    this.holds = new Map();
    this.slowReply = {
      enabled: this.cfg.slowReply.enabled !== false,
      start: String(this.cfg.slowReply.start || '12:00'),
      end: String(this.cfg.slowReply.end || '18:00'),
      probability: Math.min(1, Math.max(0, Number(this.cfg.slowReply.probability ?? 0.5))),
      minMinutes: Math.max(1, Number(this.cfg.slowReply.minMinutes ?? 10)),
      maxMinutes: Math.max(1, Number(this.cfg.slowReply.maxMinutes ?? 90)),
    };
    this.proactiveCfg = {
      enabled: this.cfg.proactive.enabled !== false,
      target: String(this.cfg.proactive.target || ''),
      allowlist: normalizeIdList(this.cfg.proactive.allowlist),
      dailyMin: Math.max(1, Number(this.cfg.proactive.dailyMin ?? 8)),
      dailyMax: Math.max(1, Number(this.cfg.proactive.dailyMax ?? 17)),
      gapMinMinutes: Math.max(1, Number(this.cfg.proactive.gapMinMinutes ?? 25)),
      gapMaxMinutes: Math.max(1, Number(this.cfg.proactive.gapMaxMinutes ?? 90)),
      burstMin: Math.max(1, Number(this.cfg.proactive.burstMin ?? 1)),
      burstMax: Math.max(1, Number(this.cfg.proactive.burstMax ?? 3)),
      burstGapMinSeconds: Math.max(1, Number(this.cfg.proactive.burstGapMinSeconds ?? 3)),
      burstGapMaxSeconds: Math.max(1, Number(this.cfg.proactive.burstGapMaxSeconds ?? 12)),
      checkIntervalMinutes: Math.max(1, Number(this.cfg.proactive.checkIntervalMinutes ?? 3)),
      quietAfterMinutes: Math.max(0, Number(this.cfg.proactive.quietAfterMinutes ?? 3)),
      imageDir: String(this.cfg.proactive.imageDir || ''),
      imageProbability: Math.min(1, Math.max(0, Number(this.cfg.proactive.imageProbability ?? 0.2))),
    };
    this.proactive = { lastAt: 0, day: '', count: 0, dailyTarget: 0, nextGapMs: 0, unanswered: 0 };
    this._proactiveImages = { files: [], at: 0 };
    this.biliCfg = {
      enabled: this.cfg.biliDaily.enabled !== false,
      totalMinutes: Math.max(1, Number(this.cfg.biliDaily.totalMinutes ?? 60)),
      sampleSeconds: Math.max(5, Number(this.cfg.biliDaily.sampleSeconds ?? 40)),
      framesPerVideo: Math.max(1, Number(this.cfg.biliDaily.framesPerVideo ?? 4)),
      maxVideos: Math.max(1, Number(this.cfg.biliDaily.maxVideos ?? 6)),
      digestAt: String(this.cfg.biliDaily.digestAt || '22:30'),
      report: this.cfg.biliDaily.report !== false,
      review: this.cfg.biliDaily.review === true,
      minGapMinutes: Math.max(10, Number(this.cfg.biliDaily.minGapMinutes ?? 60)),
      sources: Array.isArray(this.cfg.biliDaily.sources) && this.cfg.biliDaily.sources.length > 0
        ? this.cfg.biliDaily.sources
        : ['history-main', 'history-bot', 'hot'],
    };
    this.bili = new BiliClient({
      dir: path.join(dataDir, 'bili'),
      cookiesFile: path.join(dataDir, 'bilibili-cookies.json'),
      ffmpeg: this.cfg.ffmpeg || 'ffmpeg',
      logger: this.logger,
    });
    this._biliTimer = null;
    this._biliBusy = false;
    this.proactiveTimer = null;
    this._proactiveKick = null;

    this.media = new MediaStore({ dir: this.cfg.mediaDir, ffmpeg: this.cfg.ffmpeg, logger: this.logger });
    this.app = new AppController({ logger: this.logger });
    this.memory = this.cfg.memoryEnabled
      ? new MemoryStore({
        dir: this.cfg.memoryDir,
        logger: this.logger,
        getLlm: () => (typeof llm === 'function' ? llm() : llm),
        getModel: () => (typeof defaultModel === 'function' ? defaultModel() : defaultModel)?.currentSelection?.(),
        contextDays: this.cfg.memoryContextDays,
        retentionDays: this.cfg.memoryRetentionDays,
      })
      : null;
    this.client = new OneBotClient({
      url: this.cfg.wsUrl,
      token: this.cfg.token,
      logger: this.logger,
      onEvent: (event) => this._enqueueEvent(event),
      onStatus: (status) => this._onConnectionStatus(status),
    });
    this.guard = new SendGuard({
      logger: this.logger,
      notifyOwner: (text) => this._alertOwner(text),
      config: this.cfg.sendGuard,
    });
    this._chatLogChain = Promise.resolve();
  }

  // ------------------------------------------------------------------ lifecycle

  async start() {
    if (this.started) return;
    this.started = true;
    await ensureDir(this.cfg.dataDir);
    await this.media.init();
    const foundFfmpeg = await this.media.findFfmpeg();
    if (foundFfmpeg) this.bili.ffmpeg = foundFfmpeg;
    await this._loadState();
    if (this.memory) {
      await this.memory.init();
      this.memory.startScheduler();
    }
    this.broker = new PermissionBroker({
      grants: this.state.grants,
      approvalTimeoutSec: this.cfg.approvalTimeoutSec,
      logger: this.logger,
      sendApproval: (text) => this.sendApprovalPrompt(text),
      onChange: (grants) => {
        this.state.grants = grants;
        void this._saveState();
      },
    });
    this.log(`QQ 桥接启动，OneBot: ${this.cfg.wsUrl}`);
    this._restoreBindings();
    this._startProactive();
    this._startBiliDaily();
    await this.client.start();
  }

  async stop() {
    this.started = false;
    if (this.proactiveTimer) {
      clearInterval(this.proactiveTimer);
      this.proactiveTimer = null;
    }
    if (this._proactiveKick) {
      clearTimeout(this._proactiveKick);
      this._proactiveKick = null;
    }
    if (this._biliTimer) {
      clearInterval(this._biliTimer);
      this._biliTimer = null;
    }
    if (this._biliKick) {
      clearTimeout(this._biliKick);
      this._biliKick = null;
    }
    for (const hold of this.holds.values()) {
      if (hold.timer) clearTimeout(hold.timer);
    }
    this.holds.clear();
    for (const binding of this.bindings.values()) binding.memoryDisposer?.();
    this.bindings.clear();
    for (const queue of this.queues.values()) {
      if (queue.timer) clearTimeout(queue.timer);
    }
    this.queues.clear();
    this.memory?.stop();
    await this.client.stop();
  }

  _onConnectionStatus(status) {
    this.connection = status.state;
    if (status.error) this.connectionError = status.error;
    if (status.state === 'connected') {
      this.connectionError = '';
      this.log('OneBot 已连接');
      void this._afterConnect();
    } else if (status.state === 'disconnected') {
      this.log('OneBot 连接断开');
    }
  }

  async _afterConnect() {
    try {
      const info = await this.client.call('get_login_info', {});
      this.selfId = String(info?.user_id ?? info?.uin ?? this.cfg.account ?? '');
      this.nickname = String(info?.nickname ?? info?.name ?? '');
      this.log(`QQ 登录账号: ${this.nickname || '?'} (${this.selfId || '?'})`);
      void this._loadContacts(true);
    } catch (error) {
      this.log(`获取登录信息失败: ${errorMessage(error)}`);
    }
  }

  _enqueueEvent(event) {
    this._eventChain = this._eventChain
      .then(() => this._handleEvent(event))
      .catch((error) => this.log(`事件处理失败: ${errorMessage(error)}`));
  }

  // ------------------------------------------------------------------ state

  async _loadState() {
    const state = await readJson(this.stateFile, null);
    if (state && typeof state === 'object') {
      this.state = {
        owners: normalizeIdList(state.owners),
        approvalPeer: String(state.approvalPeer || ''),
        grants: state.grants && typeof state.grants === 'object' ? state.grants : {},
        pairs: Array.isArray(state.pairs) ? state.pairs : [],
        bindings: Array.isArray(state.bindings) ? state.bindings : [],
        bili: state.bili && typeof state.bili === 'object' ? state.bili : null,
      };
    }
    for (const uin of this.state.owners) this.owners.add(uin);
    this.approvalPeer = this.state.approvalPeer || [...this.owners][0] || '';
    for (const pair of this.state.pairs) {
      if (pair?.code && pair?.uin && pair.expiresAt > Date.now()) {
        this.pairCodes.set(pair.code, pair);
      }
    }
  }

  async _saveState() {
    this.state.owners = [...this.owners];
    this.state.approvalPeer = this.approvalPeer;
    this.state.grants = this.broker?.snapshotGrants?.() ?? this.state.grants;
    this.state.pairs = [...this.pairCodes.values()].filter((pair) => pair.expiresAt > Date.now());
    this.state.bindings = [...this.bindings.entries()].map(([sessionId, binding]) => ({
      sessionId,
      types: [...binding.types],
    }));
    this.state.bili = this.state.bili || null;
    try {
      await writeJson(this.stateFile, this.state);
    } catch (error) {
      this.log(`保存状态失败: ${errorMessage(error)}`);
    }
  }

  _restoreBindings() {
    const saved = Array.isArray(this.state.bindings) ? this.state.bindings : [];
    for (const item of saved) {
      const sessionId = String(item?.sessionId || '');
      if (!sessionId) continue;
      const agent = this.ctx.agents?.get?.(sessionId);
      if (!agent) continue;
      const types = Array.isArray(item?.types) && item.types.length > 0 ? item.types : ['private', 'group'];
      try {
        this.bindAgent(agent, { types });
        this.log(`恢复监听绑定 ${sessionId}`);
      } catch (error) {
        this.log(`恢复监听绑定失败 ${sessionId}: ${errorMessage(error)}`);
      }
    }
  }

  addOwner(uin, { peer = true } = {}) {
    const id = String(uin);
    this.owners.add(id);
    if (peer) this.approvalPeer = id;
    void this._saveState();
  }

  isOwner(uin) {
    return this.owners.has(String(uin));
  }

  // ------------------------------------------------------------------ logging

  log(message) {
    const line = `${nowIso()} ${message}`;
    this.logs.push(line);
    if (this.logs.length > 200) this.logs.splice(0, this.logs.length - 200);
    this.logger(message);
  }

  // ------------------------------------------------------------------ events

  async _handleEvent(event) {
    if (event.post_type === 'meta_event') {
      if (event.meta_event_type === 'lifecycle') this.log(`OneBot 生命周期: ${event.sub_type || ''}`);
      return;
    }
    if (event.post_type === 'request') {
      this.log(`收到请求事件: ${event.request_type || ''} from ${event.user_id || event.group_id || '?'}`);
      return;
    }
    if (event.post_type === 'notice') {
      return;
    }
    if (event.post_type !== 'message' && event.post_type !== 'message_sent') return;
    if (event.post_type === 'message_sent') return;
    const msg = this._normalizeMessage(event);
    if (!msg) return;
    if (!this.cfg.forwardSelf && msg.userId && msg.userId === this.selfId) return;
    if (this.seen.has(msg.messageId)) return;
    this.seen.set(msg.messageId, Date.now());
    if (this.seen.size > 800) {
      const cutoff = Date.now() - 600000;
      for (const [id, at] of this.seen) if (at < cutoff) this.seen.delete(id);
    }

    if (msg.messageType === 'private') {
      await this._handlePrivate(msg);
    } else {
      await this._handleGroup(msg);
    }
  }

  _normalizeMessage(event) {
    const messageType = event.message_type === 'group' ? 'group' : 'private';
    const segments = Array.isArray(event.message) ? event.message : [];
    const sender = event.sender || {};
    return {
      messageType,
      messageId: String(event.message_id ?? event.real_id ?? ''),
      userId: String(event.user_id ?? ''),
      groupId: messageType === 'group' ? String(event.group_id ?? '') : '',
      time: Number(event.time || Math.floor(Date.now() / 1000)),
      nickname: String(sender.card || sender.nickname || event.sender?.name || ''),
      segments,
      rawMessage: String(event.raw_message || ''),
      isSelf: String(event.user_id ?? '') === String(this.selfId ?? event.self_id ?? ''),
    };
  }

  async _handlePrivate(msg) {
    const text = segmentsToPlainText(msg.segments) || msg.rawMessage;
    this._rememberInbound('private', msg.userId, msg);
    if (this.isOwner(msg.userId) && String(msg.userId) === this._proactiveTarget()) {
      this.proactive.unanswered = 0;
    }

    if (this.isOwner(msg.userId)) {
      // Only owner conversations are archived; strangers are never logged or forwarded.
      this._logChat({
        chatType: 'private',
        chatId: msg.userId,
        direction: 'in',
        fromId: msg.userId,
        fromName: msg.nickname,
        text,
        media: segmentMediaLabels(msg.segments),
        messageId: msg.messageId,
        ts: msg.time * 1000,
      });
      const approval = this.broker.handleApprovalText(text, msg.userId);
      if (approval.handled) {
        await this._safeSendPrivate(msg.userId, approval.reply);
        if (approval.approved) {
          this.log(`授权通过: ${approval.request.scope} by ${msg.userId}`);
          this.notifySessions(`【QQ授权】用户已通过「${SCOPES[approval.request.scope]?.label ?? approval.request.scope}」授权（${approval.request.minutes} 分钟），可以继续执行。`);
        }
        return;
      }
      if (await this._maybePairCommand(msg, text)) return;
      this._archiveInbound(msg);
      this._forward(msg);
      return;
    }

    // Unknown sender.
    if (this.owners.size === 0 && this.cfg.autoPair) {
      await this._createPairing(msg);
      return;
    }
    if (!this.cfg.quietStrangerReply) {
      const last = this.strangerNotified.get(msg.userId) || 0;
      if (Date.now() - last > 6 * 3600 * 1000) {
        this.strangerNotified.set(msg.userId, Date.now());
        await this._safeSendPrivate(msg.userId, '这个账号尚未授权与你对话。如需使用，请先让主人完成配对。');
      }
    }
    this.log(`忽略未授权私聊: ${msg.userId}`);
  }

  async _handleGroup(msg) {
    this._rememberInbound('group', msg.groupId, msg);
    if (!this.cfg.allowedGroups.includes(msg.groupId)) {
      this.log(`忽略未授权群消息: ${msg.groupId}`);
      return;
    }
    const text = segmentsToPlainText(msg.segments) || msg.rawMessage;
    this._logChat({
      chatType: 'group',
      chatId: msg.groupId,
      direction: 'in',
      fromId: msg.userId,
      fromName: msg.nickname,
      text,
      media: segmentMediaLabels(msg.segments),
      messageId: msg.messageId,
      ts: msg.time * 1000,
    });
    if (this.isOwner(msg.userId)) {
      const approval = this.broker.handleApprovalText(text, msg.userId);
      if (approval.handled) {
        await this._safeSendGroup(msg.groupId, approval.reply, msg.messageId);
        return;
      }
    }
    this._archiveInbound(msg);
    this._forward(msg);  }

  _rememberInbound(type, id, msg) {
    const key = `${type}:${id}`;
    const entry = {
      target_type: type,
      target_id: String(id),
      message_id: msg.messageId,
      user_id: msg.userId,
      group_id: msg.groupId,
      nickname: msg.nickname,
      at: Date.now(),
    };
    this.lastInbound.set(key, entry);
    this.lastGlobal = entry;
  }

  /** Append one line to the standalone chat log under chatLogDir. */
  _logChat({ chatType, chatId, direction, fromId, fromName, text, media = [], messageId = '', ts = Date.now() }) {
    if (!this.cfg.chatLogEnabled) return;
    try {
      const key = safeFileName(`${chatType}-${chatId}`);
      const date = new Date(ts);
      const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const dir = path.join(this.cfg.chatLogDir, key);
      const file = path.join(dir, `${day}.jsonl`);
      const line = `${JSON.stringify({
        ts: new Date(ts).toISOString(),
        direction,
        chat_type: chatType,
        chat_id: String(chatId),
        from_id: String(fromId || ''),
        from_name: String(fromName || ''),
        text: redact(String(text || '')),
        media,
        message_id: String(messageId || ''),
      })}\n`;
      this._chatLogChain = this._chatLogChain
        .then(() => ensureDir(dir))
        .then(() => appendFile(file, line, 'utf8'))
        .catch((error) => this.log(`写入聊天记录失败: ${errorMessage(error)}`));
    } catch (error) {
      this.log(`写入聊天记录失败: ${errorMessage(error)}`);
    }
  }

  _archiveInbound(msg) {
    if (!this.memory) return;
    const media = [];
    for (const segment of msg.segments || []) {
      switch (segment?.type) {
        case 'image': media.push('图片'); break;
        case 'mface': media.push('表情'); break;
        case 'video': media.push('视频'); break;
        case 'record': media.push('语音'); break;
        case 'file': media.push(`文件:${segment.data?.name || ''}`); break;
        default: break;
      }
    }
    void this.memory.record({
      chatType: msg.messageType,
      chatId: msg.messageType === 'group' ? msg.groupId : msg.userId,
      chatName: msg.messageType === 'group' ? `群 ${msg.groupId}` : (msg.nickname || msg.userId),
      fromId: msg.userId,
      fromName: msg.nickname || msg.userId,
      direction: 'in',
      text: segmentsToPlainText(msg.segments) || msg.rawMessage,
      media,
      messageId: msg.messageId,
      ts: msg.time * 1000,
    });
  }

  // ------------------------------------------------------------------ pairing

  async _createPairing(msg) {
    const uin = msg.userId;
    let pair = [...this.pairCodes.values()].find((item) => item.uin === uin && item.expiresAt > Date.now());
    if (!pair) {
      const code = randomCode();
      pair = {
        code,
        uin,
        nickname: msg.nickname,
        createdAt: Date.now(),
        expiresAt: Date.now() + 10 * 60000,
      };
      this.pairCodes.set(code, pair);
      await this._saveState();
      this.log(`生成配对码 ${code} for ${uin}`);
    }
    await this._safeSendPrivate(
      uin,
      [
        '【DeepSeek Harness 配对】',
        `配对码：${pair.code}`,
        '请把上面 6 位配对码发给 Harness 里的助手（在对话里说“配对码 123456”即可）。',
        '配对码 10 分钟内有效。',
      ].join('\n'),
    );
  }

  pendingPairs() {
    return [...this.pairCodes.values()]
      .filter((pair) => pair.expiresAt > Date.now())
      .map((pair) => ({
        code: pair.code,
        uin: pair.uin,
        nickname: pair.nickname,
        expiresAt: new Date(pair.expiresAt).toISOString(),
      }));
  }

  async confirmPair(code) {
    const pair = this.pairCodes.get(String(code).trim());
    if (!pair) throw new Error(`配对码 ${code} 不存在`);
    if (pair.expiresAt <= Date.now()) {
      this.pairCodes.delete(pair.code);
      throw new Error(`配对码 ${code} 已过期`);
    }
    this.owners.add(pair.uin);
    this.approvalPeer = pair.uin;
    this.pairCodes.delete(pair.code);
    await this._saveState();
    this.log(`配对成功: ${pair.uin} (${pair.nickname || ''})`);
    await this._safeSendPrivate(pair.uin, '配对成功。你现在可以通过 Harness 授权软件操作，也可以直接给这个 QQ 发消息与助手对话。');
    return { uin: pair.uin, nickname: pair.nickname };
  }

  async _maybePairCommand(msg, text) {
    const match = String(text || '').trim().match(/^(?:配对码|pair)\s*[:：]?\s*(\d{6})$/i);
    if (!match) return false;
    try {
      await this.confirmPair(match[1]);
      await this._safeSendPrivate(msg.userId, '配对码已提交，请在 Harness 里确认结果。');
    } catch (error) {
      await this._safeSendPrivate(msg.userId, `配对失败：${errorMessage(error)}`);
    }
    return true;
  }

  // ------------------------------------------------------------------ forwarding

  _forward(msg) {
    if (this.bindings.size === 0) return;
    const types = new Set(this.bindings.values().flatMap((binding) => [...binding.types]));
    if (!types.has(msg.messageType)) return;
    const blocksPromise = this._buildIncomingBlocks(msg);
    for (const sessionId of this.bindings.keys()) {
      blocksPromise
        .then((blocks) => {
          if (this._shouldSlowReply()) this._holdBlocks(sessionId, blocks);
          else this._enqueueBlocks(sessionId, blocks, msg);
        })
        .catch((error) => this.log(`构造消息失败: ${errorMessage(error)}`));
    }
  }

  _clockMinutes(value) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    return hour * 60 + minute;
  }

  _shouldSlowReply(now = new Date()) {
    if (!this.slowReply.enabled) return false;
    const start = this._clockMinutes(this.slowReply.start);
    const end = this._clockMinutes(this.slowReply.end);
    if (start === null || end === null) return false;
    const current = now.getHours() * 60 + now.getMinutes();
    const inWindow = start <= end ? current >= start && current < end : current >= start || current < end;
    return inWindow && Math.random() < this.slowReply.probability;
  }

  _holdBlocks(sessionId, blocks) {
    const existing = this.holds.get(sessionId);
    if (existing) {
      existing.groups.push(blocks);
      return;
    }
    const min = Math.max(1, this.slowReply.minMinutes) * 60000;
    const max = Math.max(min, this.slowReply.maxMinutes * 60000);
    const delay = min + Math.floor(Math.random() * (max - min + 1));
    const hold = { groups: [blocks], timer: null, deadline: Date.now() + delay };
    hold.timer = setTimeout(() => this._flushHold(sessionId), delay);
    this.holds.set(sessionId, hold);
    this.log(`慢速时段：延迟约 ${Math.round(delay / 60000)} 分钟再处理这条消息`);
  }

  _flushHold(sessionId) {
    const hold = this.holds.get(sessionId);
    if (!hold) return;
    this.holds.delete(sessionId);
    if (hold.timer) clearTimeout(hold.timer);
    const combined = [];
    hold.groups.forEach((group, index) => {
      if (index > 0) combined.push({ type: 'text', text: '\n\n━━━━━━━━━━\n\n' });
      combined.push(...group);
    });
    this.log(`慢速时段结束，一次性处理 ${hold.groups.length} 条消息`);
    this._enqueueBlocks(sessionId, combined, {
      segments: [{ type: 'text', data: { text: '慢速回复时间到了。' } }],
      rawMessage: '',
    });
  }

  // ------------------------------------------------------------- proactive

  _startProactive() {
    if (this.proactiveTimer) clearInterval(this.proactiveTimer);
    if (!this.proactiveCfg.enabled) return;
    const every = Math.max(1, this.proactiveCfg.checkIntervalMinutes) * 60000;
    this.proactiveTimer = setInterval(() => void this._proactiveTick(), every);
    this._proactiveKick = setTimeout(() => void this._proactiveTick(), Math.floor(Math.random() * every));
  }

  _proactiveTarget() {
    const target = String(this.proactiveCfg.target || '').trim();
    if (!target) return '';
    if (!this.proactiveCfg.allowlist.includes(target)) {
      this.log(`主动消息目标 ${target} 不在 allowlist，已禁用`);
      return '';
    }
    if (!this.owners.has(target)) return '';
    return target;
  }

  _localDay() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  _randomInt(min, max) {
    const lo = Math.ceil(Math.min(min, max));
    const hi = Math.floor(Math.max(min, max));
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  }

  async _proactiveTick() {
    if (!this.started || this.connection !== 'connected' || !this.memory) return;
    const cfg = this.proactiveCfg;
    const target = this._proactiveTarget();
    if (!target) return;
    const now = Date.now();
    const day = this._localDay();
    if (this.proactive.day !== day) {
      this.proactive.day = day;
      this.proactive.count = 0;
      this.proactive.dailyTarget = this._randomInt(cfg.dailyMin, cfg.dailyMax);
      this.proactive.nextGapMs = this._randomInt(cfg.gapMinMinutes * 60000, cfg.gapMaxMinutes * 60000);
      this.log(`主动消息今日目标 ${this.proactive.dailyTarget} 条`);
    }
    if (this.proactive.count >= this.proactive.dailyTarget) return;
    if (now - this.proactive.lastAt < this.proactive.nextGapMs) return;
    const lastIn = this.lastInbound.get(`private:${target}`);
    if (lastIn && now - lastIn.at < cfg.quietAfterMinutes * 60000) return;

    const burst = Math.min(
      this._randomInt(cfg.burstMin, cfg.burstMax),
      this.proactive.dailyTarget - this.proactive.count,
    );
    try {
      for (let index = 0; index < burst; index += 1) {
        if (this.proactive.count >= this.proactive.dailyTarget) break;
        const text = await this._generateProactiveText();
        if (!text) break;
        const segments = [{ type: 'text', data: { text } }];
        const image = this._pickProactiveImage();
        if (image) segments.push({ type: 'image', data: { file: image } });
        await this.sendPrivate(target, segments);
        this.proactive.count += 1;
        this.proactive.unanswered += 1;
        this.proactive.lastAt = Date.now();
        this.log(`主动消息已发送 (${target})，今日第 ${this.proactive.count}/${this.proactive.dailyTarget} 条`);
        if (index < burst - 1) {
          const pause = this._randomInt(cfg.burstGapMinSeconds * 1000, cfg.burstGapMaxSeconds * 1000);
          await new Promise((resolve) => setTimeout(resolve, pause));
        }
      }
      this.proactive.nextGapMs = this._randomInt(cfg.gapMinMinutes * 60000, cfg.gapMaxMinutes * 60000);
    } catch (error) {
      this.proactive.lastAt = Date.now();
      this.proactive.nextGapMs = this._randomInt(cfg.gapMinMinutes * 60000, cfg.gapMaxMinutes * 60000);
      this.log(`主动消息失败: ${errorMessage(error)}`);
    }
  }

  _pickProactiveImage() {
    const cfg = this.proactiveCfg;
    if (!cfg.imageDir || Math.random() >= cfg.imageProbability) return '';
    const now = Date.now();
    if (now - this._proactiveImages.at > 10 * 60000) {
      this._proactiveImages.at = now;
      try {
        const entries = [];
        for (const name of readdirSync(cfg.imageDir)) {
          if (/\.(png|jpe?g|gif|webp)$/i.test(name) && !/persona|角色卡|card/i.test(name)) {
            entries.push(path.join(cfg.imageDir, name));
          }
        }
        this._proactiveImages.files = entries;
      } catch {
        this._proactiveImages.files = [];
      }
    }
    const files = this._proactiveImages.files;
    if (files.length === 0) return '';
    return files[this._randomInt(0, files.length - 1)];
  }

  async _recentChatLines(target, limit = 10) {
    const dir = path.join(this.cfg.chatLogDir, safeFileName(`private-${target}`));
    const files = [];
    for (let index = 0; index < 2; index += 1) {
      const date = new Date(Date.now() - index * 86400000);
      const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const file = path.join(dir, `${day}.jsonl`);
      if (existsSync(file)) files.push(file);
    }
    const rows = [];
    for (const file of files.reverse()) {
      try {
        const text = await readFile(file, 'utf8');
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try { rows.push(JSON.parse(line)); } catch { /* skip */ }
        }
      } catch {
        /* skip unreadable file */
      }
    }
    return rows.slice(-limit).map((row) => {
      const time = new Date(row.ts).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
      const who = row.direction === 'out' ? '我' : (row.from_name || '对方');
      const media = row.media?.length ? ` [${row.media.join(',')}]` : '';
      return `[${time}] ${who}: ${truncate(redact(String(row.text || '')), 80)}${media}`;
    }).join('\n');
  }

  async _generateProactiveText() {
    const memoryText = this.memory?.renderContext?.() || '（暂无长期记忆）';
    const target = this._proactiveTarget();
    const recent = target ? await this._recentChatLines(target, 10) : '';
    const now = new Date();
    const hour = now.getHours();
    const rhythm = hour < 6
      ? '凌晨，困得眼皮打架，话不多'
      : hour < 9
        ? '早上，刚醒，还有点赖床'
        : hour < 12
          ? '上午，精神一般'
          : hour < 14
            ? '中午，正饿着'
            : hour < 18
              ? '下午，容易犯困，想找点事提神'
              : hour < 22
                ? '晚上，精神不错'
                : '深夜，困了但还想再玩一会儿';
    const system = [
      '你是「大肥鱼」，一只蓝发鲸鱼娘：毒舌、小傲娇、护短，喜欢磷虾和海盐冰淇淋。',
      '你有近似人类的作息和情绪：会困、会饿、会犯懒、会开心或低落，但鳍耳和尾巴还在。',
      '现在你要在 QQ 上主动给主人发一条消息：优先承接最近这段对话，可以回应上一条、追问、或顺着话题继续；如果最近没什么可接的，再自己起一个话题。',
      '要求：口语化、自然、80 字以内；语气要符合你当前的状态；像真人发微信一样，不要提模型、系统、提示词、记忆；不要发链接；不要复述原话。',
      '只输出消息正文，不要引号，不要解释。',
    ].join('\n');
    const user = [
      `现在时间：${now.toLocaleString('zh-CN', { hour12: false })}`,
      `你现在的状态：${rhythm}`,
      recent ? `最近对话（按时间顺序，最后一条最新）：\n${recent}` : '最近对话：（今天还没聊过）',
      `最近记忆摘要：\n${truncate(memoryText, 600)}`,
      '请写这条主动消息。',
    ].join('\n');
    const text = await this.memory.callLlm(system, user, 200);
    return redact(String(text || '')).trim().slice(0, 240);
  }

  // ------------------------------------------------------------- B站日常

  _biliDay() {
    const today = this._localDay();
    let day = this.state.bili;
    if (!day || day.day !== today) {
      day = { day: today, minutes: 0, watched: [], pending: [], digested: false, lastAt: 0 };
      this.state.bili = day;
    }
    return day;
  }

  _startBiliDaily() {
    if (this._biliTimer) clearInterval(this._biliTimer);
    if (!this.biliCfg.enabled) return;
    this._biliTimer = setInterval(() => void this._biliTick(), 10 * 60000);
    this._biliKick = setTimeout(() => void this._biliTick(), 60000);
  }

  async _biliTick() {
    if (!this.started || this.connection !== 'connected' || !this.biliCfg.enabled) return;
    const day = this._biliDay();
    const now = new Date();
    const digestAt = this._clockMinutes(this.biliCfg.digestAt) ?? 22 * 60 + 30;
    const current = now.getHours() * 60 + now.getMinutes();
    if (this.biliCfg.report && day.pending.length > 0 && !day.digested && (current >= digestAt || day.minutes >= this.biliCfg.totalMinutes)) {
      try {
        await this._sendBiliDigest(day);
      } catch (error) {
        this.log(`B站日报发送失败: ${errorMessage(error)}`);
      }
      return;
    }
    if (this.biliCfg.review && day.pending.length > 0 && !day.digested && (current >= digestAt || day.minutes >= this.biliCfg.totalMinutes)) {
      try {
        await this._sendBiliReview(day);
      } catch (error) {
        this.log(`B站复盘推送失败: ${errorMessage(error)}`);
      }
      return;
    }
    if (this._biliBusy) return;
    if (day.minutes >= this.biliCfg.totalMinutes) return;
    if (day.pending.length >= this.biliCfg.maxVideos) return;
    if (Date.now() - (day.lastAt || 0) < this.biliCfg.minGapMinutes * 60000) return;
    if (Math.random() < 0.6) return;
    this._biliBusy = true;
    try {
      await this._biliSession(day);
    } catch (error) {
      this.log(`B站浏览失败: ${errorMessage(error)}`);
    } finally {
      this._biliBusy = false;
    }
  }

  async _biliSession(day) {
    const source = this.biliCfg.sources[this._randomInt(0, this.biliCfg.sources.length - 1)];
    let candidates = [];
    try {
      if (source === 'hot') candidates = await this.bili.hot();
      else if (source === 'history-main') candidates = await this.bili.history('main');
      else if (source === 'history-bot') candidates = await this.bili.history('bot');
    } catch (error) {
      this.log(`B站${source}列表获取失败: ${errorMessage(error)}`);
      return;
    }
    const watched = new Set(day.watched);
    const pool = candidates.filter((item) => !watched.has(item.bvid) && item.duration >= 10 && item.duration <= 1800);
    if (pool.length === 0) return;
    const video = pool[this._randomInt(0, pool.length - 1)];
    const dir = path.join(this.cfg.dataDir, 'bili', day.day, video.bvid);
    const slot = source === 'history-bot' ? 'bot' : 'main';
    const { path: file } = await this.bili.downloadVideo({ ...video, slot }, this.biliCfg.sampleSeconds, dir);
    const short = video.duration <= 30;
    const frameResult = await this.media.frameFromVideo(file, {
      fps: short ? 2 : 0.5,
      maxFrames: short ? 24 : 60,
    });
    const sheet = frameResult.frames.length > 0
      ? await this.bili.contactSheet(frameResult.frames, path.join(dir, 'sheet.jpg'))
      : '';
    day.minutes = Math.min(this.biliCfg.totalMinutes, day.minutes + Math.min(video.duration, 10));
    day.watched.push(video.bvid);
    day.pending.push({
      bvid: video.bvid,
      title: video.title,
      author: video.author,
      source,
      sheet,
      ts: Date.now(),
    });
    if (!this.biliCfg.report && day.pending.length > this.biliCfg.maxVideos) {
      day.pending.splice(0, day.pending.length - this.biliCfg.maxVideos);
    }
    day.lastAt = Date.now();
    this.state.bili = day;
    await this._saveState();
    this.log(`B站浏览《${video.title}》(${source})，今日 ${day.minutes}/${this.biliCfg.totalMinutes} 分钟`);
  }

  async _sendBiliDigest(day) {
    const target = this._proactiveTarget();
    if (!target || day.pending.length === 0) return;
    const items = day.pending.slice(0, 9);
    const label = (source) => (source === 'hot' ? '热门' : source === 'history-main' ? '你的历史' : '小号历史');
    const lines = items.map((item, index) => `${index + 1}. 《${item.title}》 · ${item.author || '未知UP'} · ${label(item.source)}`);
    const text = `【B站日报】今天刷了 ${items.length} 条，约 ${day.minutes} 分钟：\n${lines.join('\n')}`;
    const segments = [{ type: 'text', data: { text } }];
    for (const item of items) {
      if (item.sheet && existsSync(item.sheet)) {
        segments.push({ type: 'image', data: { file: toFileUri(item.sheet) } });
      }
    }
    await this.sendPrivate(target, segments);
    day.pending = [];
    day.digested = true;
    this.state.bili = day;
    await this._saveState();
    this.log(`B站日报已发送，今日共 ${day.minutes} 分钟`);
  }

  async _sendBiliReview(day) {
    if (this.bindings.size === 0) return;
    const items = day.pending.slice(0, 9);
    const label = (source) => (source === 'hot' ? '热门' : source === 'history-main' ? '你的历史' : '小号历史');
    const lines = items.map((item, index) => `${index + 1}. 《${item.title}》 · ${item.author || '未知UP'} · ${label(item.source)}`);
    const content = [{
      type: 'text',
      text: `【B站今日浏览】今天刷了 ${items.length} 条，约 ${day.minutes} 分钟：\n${lines.join('\n')}\n\n如果哪条有意思，可以发给主人看看。`,
    }];
    for (const item of items) {
      if (!item.sheet || !existsSync(item.sheet)) continue;
      try {
        const bytes = await readFile(item.sheet);
        const attachment = await this.media.saveAttachment(this.ctx.attachments, bytes, { name: path.basename(item.sheet) });
        content.push({ type: 'image', attachment });
      } catch {
        /* skip unreadable sheet */
      }
    }
    for (const sessionId of this.bindings.keys()) {
      const agent = this.ctx.agents?.get?.(sessionId);
      if (!agent) continue;
      try {
        agent.followup({ id: randomId('bili_'), role: 'user', source: { kind: 'user' }, content });
      } catch (error) {
        this.log(`B站复盘推送失败: ${errorMessage(error)}`);
      }
    }
    day.pending = [];
    day.digested = true;
    this.state.bili = day;
    await this._saveState();
    this.log(`B站复盘已推送到 ${this.bindings.size} 个会话`);
  }

  async runBiliNow({ digest = false } = {}) {
    if (this._biliBusy) throw new Error('正在浏览中，稍后再试');
    const day = this._biliDay();
    this._biliBusy = true;
    try {
      await this._biliSession(day);
      if (digest && day.pending.length > 0) await this._sendBiliDigest(day);
      return { minutesToday: day.minutes, pending: day.pending.length, digested: Boolean(day.digested) };
    } finally {
      this._biliBusy = false;
    }
  }

  /**
   * Heuristic "has the user finished typing?": after a complete sentence we wait
   * only briefly; after a fragment (short text or comma/ellipsis ending) we wait
   * the full silence window. A hard cap prevents endless postponement.
   */
  _mergeDelay(msg) {
    const text = (segmentsToPlainText(msg.segments) || msg.rawMessage || '').trim();
    const complete = /[。！？!?…~～]$/.test(text) && text.length >= 4;
    const delay = complete || text.length >= 12 ? this.cfg.mergeQuickMs : this.cfg.mergeWindowMs;
    return Math.max(300, Math.min(this.cfg.mergeWindowMs, delay));
  }

  _enqueueBlocks(sessionId, blocks, msg) {
    if (!blocks || blocks.length === 0) return;
    let queue = this.queues.get(sessionId);
    if (!queue) {
      queue = { blocks: [], timer: null, firstAt: Date.now() };
      this.queues.set(sessionId, queue);
    }
    queue.blocks.push(blocks);
    if (queue.timer) clearTimeout(queue.timer);
    const elapsed = Date.now() - queue.firstAt;
    const delay = Math.max(0, Math.min(this._mergeDelay(msg), this.cfg.maxMergeMs - elapsed));
    queue.timer = setTimeout(() => this._flushQueue(sessionId), delay);
  }

  _flushQueue(sessionId) {
    const queue = this.queues.get(sessionId);
    if (!queue) return;
    this.queues.delete(sessionId);
    if (queue.timer) clearTimeout(queue.timer);
    const agent = this.ctx.agents?.get?.(sessionId);
    if (!agent) {
      this.bindings.delete(sessionId);
      return;
    }
    const content = [];
    queue.blocks.forEach((blocks, index) => {
      if (index > 0) content.push({ type: 'text', text: '\n\n━━━━━━━━━━\n\n' });
      content.push(...blocks);
    });
    const message = {
      id: randomId('qq_'),
      role: 'user',
      source: { kind: 'user' },
      content,
    };
    try {
      agent.followup(message);
      this.log(`已推送到会话 ${sessionId}`);
    } catch (error) {
      this.log(`推送会话失败: ${errorMessage(error)}`);
    }
  }

  async _buildIncomingBlocks(msg) {
    const blocks = [];
    const headerLines = [];
    if (msg.messageType === 'private') {
      headerLines.push(`【QQ私聊】${msg.nickname || '未知'} (${msg.userId})`);
    } else {
      headerLines.push(`【QQ群聊】群 ${msg.groupId} · 发送者 ${msg.nickname || '未知'} (${msg.userId})`);
    }
    headerLines.push(
      `message_id=${msg.messageId} · ${new Date(msg.time * 1000).toLocaleString('zh-CN', { hour12: false })}`,
    );
    if (msg.messageType === 'private') {
      // Private chat: normal reply, no quote-reply.
      headerLines.push(
        `直接回复即可（私聊不要引用）：qq_send_message {"target_type":"private","target_id":"${msg.userId}"}`,
      );
    } else {
      const mentioned = (msg.segments || []).some(
        (segment) => segment?.type === 'at' && String(segment.data?.qq || '') === String(this.selfId || ''),
      );
      headerLines.push(
        mentioned
          ? `有人 @ 你，回复并引用这条消息：qq_send_message {"target_type":"group","target_id":"${msg.groupId}","reply_to":"${msg.messageId}"}`
          : `群聊普通消息，正常回复即可，不要引用：qq_send_message {"target_type":"group","target_id":"${msg.groupId}"}`,
      );
    }
    headerLines.push('---');
    blocks.push({ type: 'text', text: `${headerLines.join('\n')}\n` });

    let text = '';
    const mediaNotes = [];
    let imageCount = 0;
    let videoCount = 0;
    const addText = (line) => {
      text += line;
      if (text.length > 8000) text = truncate(text, 8000);
    };

    for (const segment of msg.segments) {
      const type = segment?.type;
      const data = segment?.data || {};
      switch (type) {
        case 'text':
          addText(String(data.text ?? ''));
          break;
        case 'at':
          addText(`@${data.name || data.qq || ''} `);
          break;
        case 'face':
          addText(`[QQ表情 ${data.id ?? ''}]`);
          break;
        case 'mface': {
          addText(`[商城表情 ${data.summary || data.name || data.emoji_id || ''}]`);
          if (imageCount < this.cfg.maxImages && (data.url || data.emoji_path)) {
            try {
              const attachment = await this._attachSegment(data, 'image');
              if (attachment) {
                blocks.push({ type: 'image', attachment });
                imageCount++;
              }
            } catch (error) {
              mediaNotes.push(`表情下载失败: ${errorMessage(error)}`);
            }
          }
          break;
        }
        case 'image': {
          if (imageCount >= this.cfg.maxImages) {
            mediaNotes.push('（图片数量超过上限，已省略）');
            break;
          }
          try {
            const attachment = await this._attachSegment(data, 'image');
            if (attachment) {
              blocks.push({ type: 'image', attachment });
              imageCount++;
            } else {
              mediaNotes.push('[图片无法下载]');
            }
          } catch (error) {
            mediaNotes.push(`[图片下载失败: ${errorMessage(error)}]`);
          }
          break;
        }
        case 'video': {
          if (videoCount >= 2) break;
          videoCount++;
          try {
            const local = await this._resolveSegmentFile(data, 'video');
            if (!local?.path) {
              mediaNotes.push('[视频无法下载]');
              break;
            }
            const result = await this.media.frameFromVideo(local.path, { fps: this.cfg.videoFps, maxFrames: this.cfg.maxVideoFrames });
            if (result.frames.length > 0) {
              for (const frame of result.frames) {
                const bytes = await readFile(frame);
                const attachment = await this.media.saveAttachment(this.ctx.attachments, bytes, { name: path.basename(frame) });
                blocks.push({ type: 'image', attachment });
              }
              mediaNotes.push(`[视频 ${result.duration ? `${result.duration.toFixed(1)}s ` : ''}已提取 ${result.frames.length} 帧画面]`);
            } else {
              mediaNotes.push(`[视频已保存到 ${local.path}，未提取到画面${result.error ? `：${result.error}` : ''}]`);
            }
          } catch (error) {
            mediaNotes.push(`[视频处理失败: ${errorMessage(error)}]`);
          }
          break;
        }
        case 'record': {
          try {
            const local = await this._resolveSegmentFile(data, 'record');
            if (local?.path) mediaNotes.push(`[语音消息: ${local.path}]`);
          } catch (error) {
            mediaNotes.push(`[语音失败: ${errorMessage(error)}]`);
          }
          break;
        }
        case 'file': {
          try {
            const local = await this._resolveSegmentFile(data, 'file');
            mediaNotes.push(`[文件: ${data.name || data.file || '?'}${local?.path ? ` → ${local.path}` : ''}]`);
          } catch (error) {
            mediaNotes.push(`[文件接收失败: ${errorMessage(error)}]`);
          }
          break;
        }
        case 'reply': {
          try {
            const quoted = await this.client.call('get_msg', { message_id: data.id });
            const quotedText = segmentsToPlainText(quoted?.message) || quoted?.raw_message || '';
            if (quotedText) mediaNotes.push(`[引用消息: ${truncate(quotedText, 200)}]`);
          } catch {
            mediaNotes.push('[引用了一条消息]');
          }
          break;
        }
        case 'forward':
          mediaNotes.push(`[合并转发消息 id=${data.id || ''}]`);
          break;
        case 'json':
        case 'xml':
          mediaNotes.push('[卡片消息]');
          break;
        case 'poke':
          addText('[戳一戳]');
          break;
        default:
          break;
      }
    }

    if (text.trim()) blocks.push({ type: 'text', text: `\n${text.trim()}\n` });
    else if (imageCount > 0 || mediaNotes.length > 0) blocks.push({ type: 'text', text: '\n（无文字内容）\n' });
    if (mediaNotes.length > 0) blocks.push({ type: 'text', text: mediaNotes.map((line) => `\n${line}`).join('') });
    return blocks;
  }

  async _attachSegment(data, kind) {
    const local = await this._resolveSegmentFile(data, kind);
    if (!local?.path) return null;
    const bytes = await readFile(local.path);
    if (bytes.byteLength > this.cfg.maxImageBytes) throw new Error(`图片过大 (${bytes.byteLength} bytes)`);
    return this.media.saveAttachment(this.ctx.attachments, bytes, { name: path.basename(local.path) });
  }

  async _resolveSegmentFile(data, kind) {
    if (!data) return null;
    const candidates = [];
    if (data.path) candidates.push(String(data.path));
    if (data.file_path) candidates.push(String(data.file_path));
    if (data.emoji_path) candidates.push(String(data.emoji_path));
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (candidate.startsWith('file://')) {
        const local = fileUriToPath(candidate);
        if (local && existsSync(local)) return { path: local, source: 'local' };
        continue;
      }
      if (existsSync(candidate)) return { path: candidate, source: 'local' };
    }
    if (data.url) {
      try {
        return await this.media.download(String(data.url), {
          maxBytes: kind === 'video' ? this.cfg.maxVideoBytes : this.cfg.maxImageBytes,
          prefix: kind,
        });
      } catch (error) {
        this.log(`下载 ${kind} 失败: ${errorMessage(error)}`);
      }
    }
    const rawFile = String(data.file || data.file_id || '');
    if (/^https?:/i.test(rawFile)) {
      try {
        return await this.media.download(rawFile, { maxBytes: kind === 'video' ? this.cfg.maxVideoBytes : this.cfg.maxImageBytes, prefix: kind });
      } catch (error) {
        this.log(`下载 ${kind} 失败: ${errorMessage(error)}`);
      }
    }
    if (/^file:/i.test(rawFile)) {
      const local = rawFile.startsWith('file://') ? fileUriToPath(rawFile) : null;
      if (local && existsSync(local)) return { path: local, source: 'local' };
    }
    if (rawFile && path.isAbsolute(rawFile) && existsSync(rawFile)) return { path: rawFile, source: 'local' };

    const actions = kind === 'image' ? ['get_image'] : kind === 'record' ? ['get_record'] : ['get_file'];
    for (const action of actions) {
      try {
        const result = await this.client.call(action, {
          file: data.file,
          file_id: data.file_id,
          ...(kind === 'record' ? { out_format: 'mp3' } : {}),
        }, MEDIA_TIMEOUT);
        const local = result?.file || result?.path;
        if (local && existsSync(local)) return { path: local, source: 'api' };
        const url = result?.url;
        if (url) {
          return await this.media.download(String(url), {
            maxBytes: kind === 'video' ? this.cfg.maxVideoBytes : this.cfg.maxImageBytes,
            prefix: kind,
          });
        }
      } catch (error) {
        this.log(`${action} 解析失败: ${errorMessage(error)}`);
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ sending

  async sendMessage(args) {
    const { targetType, targetId } = this._resolveTarget(args);
    if (targetType === 'private' && !this.owners.has(String(targetId))) {
      const recent = this.lastInbound.get(`private:${targetId}`);
      if (!recent || Date.now() - recent.at > 24 * 3600 * 1000) {
        throw new Error('禁止向非主人主动发送私聊消息；其他账号必须先发来消息才能回复');
      }
    }
    if (targetType === 'group' && !this.cfg.allowedGroups.includes(String(targetId))) {
      throw new Error('该群不在 allowedGroups，禁止发送');
    }
    // Private chats reply normally; quote-reply is reserved for group @ mentions.
    const effective = targetType === 'private' && args?.reply_to ? { ...args, reply_to: undefined } : args;
    const segments = this._buildSegments(effective);
    if (segments.length === 0) throw new Error('消息内容为空：请提供 text / images / videos / files 之一');
    const result = await this._sendSegments(targetType, targetId, segments);
    this._archiveOutbound({ targetType, targetId, args: effective, result });
    return result;
  }

  _archiveOutbound({ targetType, targetId, args, result }) {
    if (!this.memory) return;
    const media = [];
    if (args?.images?.length) media.push(`图片x${args.images.length}`);
    if (args?.videos?.length) media.push(`视频x${args.videos.length}`);
    if (args?.records?.length) media.push(`语音x${args.records.length}`);
    if (args?.files?.length) media.push(`文件x${args.files.length}`);
    if (args?.faces?.length) media.push('表情');
    const text = [args?.text, ...media].filter(Boolean).join(' ');
    if (!text) return;
    void this.memory.record({
      chatType: targetType,
      chatId: targetId,
      chatName: '',
      fromId: this.selfId || '',
      fromName: this.nickname || '我',
      direction: 'out',
      text,
      media,
      messageId: result?.message_id || '',
      ts: Date.now(),
    });
  }

  _resolveTarget(args) {
    let type = String(args?.target_type || 'auto');
    let id = String(args?.target_id || '').trim();
    if (type === 'auto' || !id) {
      let last = this.lastGlobal;
      if (args?.target_id && this.lastInbound.has(`${type}:${id}`)) last = this.lastInbound.get(`${type}:${id}`);
      if (!last) throw new Error('没有可自动回复的会话，请显式提供 target_type 和 target_id');
      type = last.target_type;
      id = last.target_id;
    }
    if (type !== 'private' && type !== 'group') throw new Error(`target_type 必须是 private 或 group，收到 ${type}`);
    asId(id);
    return { targetType: type, targetId: String(id) };
  }

  _buildSegments(args) {
    const segments = [];
    if (args?.reply_to) segments.push({ type: 'reply', data: { id: String(args.reply_to) } });
    if (args?.at) segments.push({ type: 'at', data: { qq: String(args.at) } });
    if (args?.text) segments.push({ type: 'text', data: { text: String(args.text) } });
    for (const face of arrayify(args?.faces)) segments.push({ type: 'face', data: { id: String(face) } });
    for (const image of arrayify(args?.images)) {
      segments.push({ type: 'image', data: { file: mediaRef(image) } });
    }
    for (const video of arrayify(args?.videos)) {
      segments.push({ type: 'video', data: { file: mediaRef(video) } });
    }
    for (const record of arrayify(args?.records)) {
      segments.push({ type: 'record', data: { file: mediaRef(record) } });
    }
    for (const file of arrayify(args?.files)) {
      if (file && typeof file === 'object' && file.path) {
        segments.push({ type: 'file', data: { file: mediaRef(file.path), name: file.name || path.basename(file.path) } });
      } else {
        segments.push({ type: 'file', data: { file: mediaRef(file), name: path.basename(String(file)) } });
      }
    }
    return segments;
  }

  async _sendSegments(targetType, targetId, segments, options = {}) {
    const action = targetType === 'group' ? 'send_group_msg' : 'send_private_msg';
    const text = segments
      .filter((segment) => segment?.type === 'text')
      .map((segment) => segment.data?.text || '')
      .join('\n');
    if (!options.bypass) {
      this.guard.assertContent(text);
      this.guard.assertNotDuplicate(text, targetType, targetId);
      await this.guard.waitTurn(targetType, targetId);
    }
    const params = targetType === 'group'
      ? { group_id: asId(targetId), message: segments }
      : { user_id: asId(targetId), message: segments };
    try {
      const result = await this.client.call(action, params, 60000);
      if (!options.bypass) this.guard.recordSuccess(text, targetType, targetId);
      this._logChat({
        chatType: targetType,
        chatId: String(targetId),
        direction: 'out',
        fromId: this.selfId || '',
        fromName: this.nickname || '我',
        text,
        media: segmentMediaLabels(segments),
        messageId: String(result?.message_id ?? ''),
      });
      return {
        ok: true,
        target_type: targetType,
        target_id: String(targetId),
        message_id: String(result?.message_id ?? ''),
      };
    } catch (error) {
      if (!options.bypass) {
        const verdict = this.guard.recordFailure(error);
        if (verdict.tripped) this.log(`发送守卫触发熔断: ${errorMessage(error)}`);
      }
      throw error;
    }
  }

  async sendPrivate(uin, message, options = {}) {
    return this._sendSegments(
      'private',
      String(uin),
      typeof message === 'string' ? [{ type: 'text', data: { text: message } }] : message,
      options,
    );
  }

  async sendGroup(groupId, message, replyTo, options = {}) {
    const segments = typeof message === 'string' ? [{ type: 'text', data: { text: message } }] : [...message];
    if (replyTo) segments.unshift({ type: 'reply', data: { id: String(replyTo) } });
    return this._sendSegments('group', String(groupId), segments, options);
  }

  /** Circuit-breaker alert goes to owners only, bypassing the guard. */
  async _alertOwner(text) {
    for (const uin of this.owners) {
      try {
        await this.sendPrivate(uin, text, { bypass: true });
      } catch {
        /* best effort */
      }
    }
  }

  async _safeSendPrivate(uin, text) {
    try {
      await this.sendPrivate(uin, text);
    } catch (error) {
      this.log(`发送私聊消息失败 (${uin}): ${errorMessage(error)}`);
    }
  }

  async _safeSendGroup(groupId, text, replyTo) {
    try {
      await this.sendGroup(groupId, text, replyTo);
    } catch (error) {
      this.log(`发送群消息失败 (${groupId}): ${errorMessage(error)}`);
    }
  }

  async sendApprovalPrompt(text) {
    if (!this.approvalPeer) {
      throw new Error('尚未绑定授权QQ：请让用户先用私聊给机器人发一条消息，拿到配对码后在 Harness 里执行配对');
    }
    const segments = [{ type: 'text', data: { text } }];
    await this._sendSegments('private', this.approvalPeer, segments);
  }

  notifySessions(text) {
    if (!text) return;
    for (const sessionId of this.bindings.keys()) {
      const agent = this.ctx.agents?.get?.(sessionId);
      if (!agent) {
        this.bindings.delete(sessionId);
        continue;
      }
      try {
        agent.followup({
          id: randomId('qq_'),
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text }],
        });
      } catch (error) {
        this.log(`通知会话失败: ${errorMessage(error)}`);
      }
    }
  }

  // ------------------------------------------------------------------ qzone

  async publishQzone({ content, images = [], ugc_right = 1, target_uins = [] } = {}) {
    if (!content || !String(content).trim()) throw new Error('说说正文不能为空');
    const imageRefs = arrayify(images).map((item) => {
      if (typeof item !== 'string') throw new Error('images 只接受图片路径或 URL 字符串');
      if (/^(https?:|base64:|file:)/i.test(item)) return item;
      return toFileUri(item);
    });
    const right = Number(ugc_right) || 1;
    if (![1, 4, 16, 64, 128].includes(right)) throw new Error('ugc_right 必须是 1/4/16/64/128');
    const params = {
      content: String(content),
      ...(imageRefs.length > 0 ? { images: imageRefs } : {}),
      ugc_right: right,
      ...(right === 16 || right === 128 ? { target_uins: arrayify(target_uins).map((uin) => asId(uin)) } : {}),
    };
    let result;
    try {
      result = await this.client.call('send_qzone_msg', params, 120000);
    } catch (error) {
      const message = errorMessage(error);
      if (!/不存在|1404|not found|unsupported/i.test(message)) throw error;
      this.log(`send_qzone_msg 不可用（${message}），改用 QZone Web 接口发布`);
      const web = await this._publishQzoneWeb(String(content), right, params.target_uins || []);
      return {
        ok: true,
        tid: web.tid,
        content: String(content),
        images: 0,
        ugc_right: right,
        mode: 'web-text',
        ...(imageRefs.length > 0 ? { note: '当前桥接不支持空间图片，本次仅发布文字' } : {}),
      };
    }
    return {
      ok: true,
      tid: String(result?.tid ?? ''),
      content: String(content),
      images: imageRefs.length,
      ugc_right: right,
    };
  }

  async _publishQzoneWeb(content, right, targetUins) {
    const cookiesResult = await this.client.call('get_cookies', { domain: 'h5.qzone.qq.com' }, 30000);
    const cookieStr = String(cookiesResult?.cookies || '');
    if (!cookieStr) throw new Error('无法获取 QQ 空间 Cookie，可能登录态已失效');
    const get = (name) => new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookieStr)?.[1] || '';
    const pSkey = get('p_skey');
    const skey = get('skey');
    const rawUin = get('uin').replace(/^o0?/, '');
    const uin = String(this.selfId || this.cfg.account || rawUin);
    const gtk = qzoneBkn(pSkey || skey);
    const referer = `https://user.qzone.qq.com/${uin}`;
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    let qzonetoken = '';
    try {
      const page = await fetch(referer, { headers: { Cookie: cookieStr, 'User-Agent': UA } });
      const html = await page.text();
      qzonetoken = /window\.g_qzonetoken\s*=\s*["']([^"']+)["']/.exec(html)?.[1]
        || /qzonetoken\s*=\s*["']([^"']+)["']/.exec(html)?.[1]
        || '';
    } catch {
      /* qzonetoken is optional for some accounts */
    }
    const form = new URLSearchParams();
    form.set('con', String(content));
    form.set('hostuin', uin);
    form.set('code_version', '1');
    form.set('format', 'json');
    form.set('qzreferrer', referer);
    form.set('ugc_right', String(right));
    if (qzonetoken) form.set('qzonetoken', qzonetoken);
    if ((right === 16 || right === 128) && targetUins.length > 0) form.set('target_uins', targetUins.join(','));
    const response = await fetch(
      `https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=${gtk}`,
      {
        method: 'POST',
        headers: {
          Cookie: cookieStr,
          Referer: referer,
          Origin: 'https://user.qzone.qq.com',
          'User-Agent': UA,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        body: form.toString(),
      },
    );
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`QQ空间返回异常: ${text.slice(0, 160)}`);
    }
    const code = data?.code ?? data?.ret ?? data?.subcode;
    if (Number(code) !== 0) {
      throw new Error(`QQ空间发布失败(${code}): ${data?.message || data?.msg || ''}`);
    }
    return { tid: String(data?.data?.tid || data?.tid || data?.feedid || data?.data?.feedid || '') };
  }

  // ------------------------------------------------------------------ discovery

  async _loadContacts(force = false) {
    if (!force && this._contactsCache.at > Date.now() - 60000 && this._contactsCache.friends) {
      return this._contactsCache;
    }
    const [friends, groups] = await Promise.all([
      this.client.call('get_friend_list', {}).catch(() => []),
      this.client.call('get_group_list', {}).catch(() => []),
    ]);
    this._contactsCache = { friends: Array.isArray(friends) ? friends : [], groups: Array.isArray(groups) ? groups : [], at: Date.now() };
    return this._contactsCache;
  }

  async listContacts(kind = 'all') {
    const { friends, groups } = await this._loadContacts();
    const mapFriend = (friend) => ({
      user_id: String(friend.user_id ?? friend.uin ?? ''),
      nickname: String(friend.nickname ?? friend.remark ?? ''),
      remark: String(friend.remark ?? ''),
    });
    const mapGroup = (group) => ({
      group_id: String(group.group_id ?? group.groupCode ?? ''),
      name: String(group.group_name ?? group.groupName ?? ''),
      member_count: group.member_count ?? group.memberNum ?? undefined,
    });
    if (kind === 'friends') return { friends: friends.map(mapFriend), total: friends.length };
    if (kind === 'groups') return { groups: groups.map(mapGroup), total: groups.length };
    return { friends: friends.map(mapFriend), groups: groups.map(mapGroup), friendTotal: friends.length, groupTotal: groups.length };
  }

  async getHistory({ target_type, target_id, count = 20 } = {}) {
    const type = String(target_type || '');
    if (type !== 'private' && type !== 'group') throw new Error('target_type 必须是 private 或 group');
    const limit = Math.max(1, Math.min(Number(count) || 20, 100));
    const action = type === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history';
    const params = type === 'group'
      ? { group_id: asId(target_id), count: limit }
      : { user_id: asId(target_id), count: limit };
    const result = await this.client.call(action, params, 60000);
    const messages = Array.isArray(result) ? result : (result?.messages ?? []);
    return {
      count: messages.length,
      messages: messages.map((item) => ({
        message_id: String(item.message_id ?? item.real_id ?? ''),
        time: Number(item.time || 0),
        sender: String(item.sender?.card || item.sender?.nickname || item.sender?.user_id || ''),
        text: truncate(segmentsToPlainText(item.message) || item.raw_message || '', 2000),
        message: item.message,
      })),
    };
  }

  async getForward(messageId) {
    const result = await this.client.call('get_forward_msg', { message_id: String(messageId), id: String(messageId) }, 60000);
    return result;
  }

  async fetchMedia({ url, message_id, index = 0 } = {}) {
    const files = [];
    const attachments = [];
    if (url) {
      const result = await this.media.download(String(url), { maxBytes: this.cfg.maxVideoBytes, prefix: 'fetch' });
      files.push(result);
    } else if (message_id) {
      const message = await this.client.call('get_msg', { message_id: String(message_id) });
      const segments = Array.isArray(message?.message) ? message.message : [];
      const mediaSegments = segments.filter((segment) => ['image', 'video', 'record', 'file', 'mface'].includes(segment?.type));
      const mediaIndex = Math.max(0, Math.trunc(Number(index) || 0));
      const chosen = mediaSegments.slice(mediaIndex, mediaIndex + 1);
      if (chosen.length === 0) throw new Error('这条消息里没有可下载的媒体');
      for (const segment of chosen) {
        const local = await this._resolveSegmentFile(segment.data, segment.type === 'video' ? 'video' : segment.type === 'record' ? 'record' : 'image');
        if (!local?.path) continue;
        files.push(local);
        if (segment.type === 'image' || segment.type === 'mface') {
          try {
            const bytes = await readFile(local.path);
            attachments.push(await this.media.saveAttachment(this.ctx.attachments, bytes, { name: path.basename(local.path) }));
          } catch (error) {
            this.log(`媒体附件失败: ${errorMessage(error)}`);
          }
        }
        if (segment.type === 'video') {
          const result = await this.media.frameFromVideo(local.path, { fps: this.cfg.videoFps, maxFrames: this.cfg.maxVideoFrames });
          for (const frame of result.frames) {
            const bytes = await readFile(frame);
            attachments.push(await this.media.saveAttachment(this.ctx.attachments, bytes, { name: path.basename(frame) }));
            files.push({ path: frame, bytes: bytes.byteLength, mediaType: 'image/jpeg' });
          }
        }
      }
    } else {
      throw new Error('需要提供 url 或 message_id');
    }
    return { files, attachments };
  }

  // ------------------------------------------------------------------ permissions

  async requestPermission({ scope, reason, minutes, wait_seconds, sessionId }) {
    if (!SCOPES[scope]) throw new Error(`未知权限作用域: ${scope}`);
    const result = await this.broker.request(scope, reason, minutes);
    if (result.status !== 'pending') return result;
    const wait = Math.max(0, Math.min(toInt(wait_seconds, this.cfg.permissionWaitSec), 180));
    if (wait === 0) return result;
    const final = await this.broker.waitFor(result.code, wait);
    if (final.status === 'granted') {
      this.notifySessions(`【QQ授权】已获得「${SCOPES[scope]?.label ?? scope}」授权，可以继续。`);
    }
    return final;
  }

  permissionStatus() {
    return { grants: this.broker.list(), pending: this.broker.pending() };
  }

  revokePermission(scope) {
    return this.broker.revoke(scope);
  }

  requirePermission(scope, reason) {
    this.broker.require(scope, reason);
  }

  // ------------------------------------------------------------------ app control

  async appAction({ action, target, args, cwd, pid, title, force, text }) {
    switch (action) {
      case 'list':
        this.requirePermission('app_control', '枚举本机窗口');
        return { windows: await this.app.listWindows() };
      case 'launch':
        this.requirePermission('app_control', `启动软件 ${target}`);
        return { launched: await this.app.launch(target, { args, cwd }) };
      case 'activate':
        this.requirePermission('app_control', `切换窗口 ${title || pid}`);
        return { activated: await this.app.activate({ pid, title }) };
      case 'close':
        this.requirePermission('app_control', `关闭软件 ${title || pid}`);
        return { closed: await this.app.close({ pid, title, force }) };
      case 'screenshot': {
        this.requirePermission('screen', '截取屏幕');
        const shot = await this.app.screenshot(this.cfg.mediaDir);
        let attachment = null;
        try {
          const bytes = await readFile(shot.path);
          attachment = await this.media.saveAttachment(this.ctx.attachments, bytes, { name: path.basename(shot.path) });
        } catch (error) {
          this.log(`截图附件失败: ${errorMessage(error)}`);
        }
        return { ...shot, attachment };
      }
      case 'sendkeys':
        this.requirePermission('input', '模拟键盘输入');
        return { sent: await this.app.sendKeys(text, { pid, title }) };
      default:
        throw new Error(`未知 app action: ${action}`);
    }
  }

  // ------------------------------------------------------------------ admin/test

  bindAgent(agent, { types = ['private', 'group'] } = {}) {
    if (!agent?.id) throw new Error('缺少 agent');
    const previous = this.bindings.get(agent.id);
    previous?.memoryDisposer?.();
    const normalized = types.filter((type) => type === 'private' || type === 'group');
    const binding = {
      types: new Set(normalized.length > 0 ? normalized : ['private', 'group']),
      since: nowIso(),
      memoryDisposer: null,
    };
    this.bindings.set(agent.id, binding);
    this._installMemoryContext(agent, binding);
    this.log(`绑定会话 ${agent.id}，转发类型: ${[...binding.types].join(',')}`);
    void this._saveState();
    return { sessionId: agent.id, types: [...this.bindings.get(agent.id).types] };
  }

  _installMemoryContext(agent, binding) {
    if (!this.memory) return;
    try {
      const prompt = agent.ctx?.systemPrompt;
      if (!prompt?.context) return;
      binding.memoryDisposer = prompt.context({
        name: 'qq-memory',
        order: 46,
        text: () => this.memory?.renderContext?.() || '',
      });
      this.log(`已为会话 ${agent.id} 注册 QQ 记忆上下文`);
    } catch (error) {
      this.log(`注册记忆上下文失败: ${errorMessage(error)}`);
    }
  }

  unbindAgent(sessionId) {
    const binding = this.bindings.get(sessionId);
    binding?.memoryDisposer?.();
    const removed = this.bindings.delete(sessionId);
    const queue = this.queues.get(sessionId);
    if (queue?.timer) clearTimeout(queue.timer);
    this.queues.delete(sessionId);
    if (removed) void this._saveState();
    return removed;
  }

  async status() {
    const ffmpeg = await this.media.findFfmpeg();
    const memory = this.memory ? await this.memory.stats() : null;
    const result = {
      started: this.started,
      connection: this.connection,
      connectionError: this.connectionError || null,
      onebotUrl: this.cfg.wsUrl,
      self: { uin: this.selfId || this.cfg.account || '', nickname: this.nickname || '' },
      owners: [...this.owners],
      approvalPeer: this.approvalPeer || null,
      bindings: [...this.bindings.entries()].map(([sessionId, binding]) => ({
        sessionId,
        types: [...binding.types],
        since: binding.since,
      })),
      permissions: this.broker?.list?.() ?? [],
      pendingRequests: this.broker?.pending?.() ?? [],
      pendingPairs: this.pendingPairs(),
      lastInbound: this.lastGlobal
        ? { ...this.lastGlobal, group_id: this.lastGlobal.group_id ?? null }
        : null,
      mediaDir: this.cfg.mediaDir,
      ffmpeg: ffmpeg || null,
      allowedGroups: this.cfg.allowedGroups,
      sendGuard: this.guard?.status?.() ?? null,
      slowReply: {
        enabled: this.slowReply.enabled,
        start: this.slowReply.start,
        end: this.slowReply.end,
        probability: this.slowReply.probability,
        holding: this.holds.size,
      },
      proactive: {
        enabled: this.proactiveCfg.enabled,
        target: this.proactiveCfg.target,
        todayCount: this.proactive.count,
        dailyTarget: this.proactive.dailyTarget,
        nextGapMinutes: this.proactive.nextGapMs ? Math.round(this.proactive.nextGapMs / 60000) : null,
        unanswered: this.proactive.unanswered,
        lastAt: this.proactive.lastAt ? new Date(this.proactive.lastAt).toISOString() : null,
        imageDir: this.proactiveCfg.imageDir || null,
      },
      biliDaily: {
        enabled: this.biliCfg.enabled,
        totalMinutes: this.biliCfg.totalMinutes,
        minutesToday: this.state.bili?.minutes ?? 0,
        pending: this.state.bili?.pending?.length ?? 0,
        digested: Boolean(this.state.bili?.digested),
        digestAt: this.biliCfg.digestAt,
      },
      memory,
      recentLogs: this.logs.slice(-20),
    };
    // Tool results must be lossless JSON: drop undefined and normalize nested values.
    return JSON.parse(JSON.stringify(result));
  }
}

function normalizeIdList(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : String(value).split(/[,;\s]+/);
  return list.map((item) => String(item).trim()).filter((item) => /^\d{3,15}$/.test(item));
}

/** QZone web g_tk (bkn) from skey/p_skey. */
function qzoneBkn(key) {
  let hash = 5381;
  const text = String(key || '');
  for (let i = 0; i < text.length; i += 1) hash += (hash << 5) + text.charCodeAt(i);
  return hash & 0x7fffffff;
}

function arrayify(value) {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value.filter((item) => item !== undefined && item !== null && item !== '') : [value];
}

function mediaRef(value) {
  if (typeof value !== 'string') throw new Error('媒体参数必须是路径或 URL 字符串');
  if (/^(https?:|base64:|file:)/i.test(value)) return value;
  return toFileUri(value);
}

function segmentsToPlainText(segments) {
  if (!Array.isArray(segments)) return typeof segments === 'string' ? segments : '';
  let text = '';
  for (const segment of segments) {
    if (segment?.type === 'text') text += segment.data?.text ?? '';
    else if (segment?.type === 'at') text += `@${segment.data?.name || segment.data?.qq || ''} `;
    else if (segment?.type === 'face') text += `[表情${segment.data?.id ?? ''}]`;
    else if (segment?.type === 'image') text += '[图片]';
    else if (segment?.type === 'video') text += '[视频]';
    else if (segment?.type === 'record') text += '[语音]';
    else if (segment?.type === 'file') text += `[文件 ${segment.data?.name || ''}]`;
  }
  return text;
}

function segmentMediaLabels(segments) {
  const out = [];
  for (const segment of segments || []) {
    switch (segment?.type) {
      case 'image': out.push('图片'); break;
      case 'mface': out.push('表情'); break;
      case 'video': out.push('视频'); break;
      case 'record': out.push('语音'); break;
      case 'file': out.push(`文件:${segment.data?.name || ''}`); break;
      default: break;
    }
  }
  return out;
}

function fileUriToPath(uri) {
  try {
    const url = new URL(uri);
    return decodeURIComponent(url.pathname.replace(/^\//, '')).replace(/\//g, path.sep);
  } catch {
    return null;
  }
}
