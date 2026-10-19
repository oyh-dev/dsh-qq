import { sleep, errorMessage } from './util.js';

const DEFAULTS = {
  ratePerMinute: 15,
  ratePerChatPerMinute: 5,
  minSendIntervalMs: 1500,
  groupMinSendIntervalMs: 3000,
  groupRatePerMinute: 3,
  dedupWindowMs: 30000,
  jitterMs: 800,
  breakerFailures: 3,
  breakerCooldownMs: 10 * 60 * 1000,
  blockLinks: true,
  blockPhones: true,
};

// Explicit illegal / high-risk categories. Kept generic on purpose: the model
// still does the primary review, this is a deterministic backstop.
const DEFAULT_PATTERNS = [
  ['赌博', '赌博|博彩|下注|棋牌代理|六合彩'],
  ['色情', '色情|裸聊|约炮|成人视频|福利姬'],
  ['毒品', '毒品|冰毒|海洛因|大麻|摇头丸'],
  ['诈骗', '诈骗|刷单|洗钱|跑分|代开发票|杀猪盘'],
  ['违禁品', '枪支|弹药|迷药|假证|代考'],
  ['引流', '加微信|加VX|加v信|扫码进群|点击链接领取'],
];

export class SendGuard {
  constructor({ logger, notifyOwner, config = {} } = {}) {
    this.logger = logger ?? (() => {});
    this.notifyOwner = typeof notifyOwner === 'function' ? notifyOwner : async () => {};
    this.cfg = { ...DEFAULTS, ...config };
    const patterns = Array.isArray(this.cfg.blockPatterns) ? this.cfg.blockPatterns : DEFAULT_PATTERNS;
    this.patterns = patterns.map((entry) => {
      if (Array.isArray(entry)) return { label: String(entry[0]), re: new RegExp(String(entry[1]), 'i') };
      if (typeof entry === 'string') return { label: entry, re: new RegExp(entry, 'i') };
      return { label: String(entry?.label || '敏感词'), re: new RegExp(String(entry?.pattern || ''), 'i') };
    }).filter((item) => item.re.source);
    this.globalSent = [];
    this.chatSent = new Map();
    this.lastSentAt = new Map();
    this.recentText = new Map();
    this.failureStreak = 0;
    this.cooldownUntil = 0;
    this.alertedAt = 0;
    this.blockedCount = 0;
    this.sentCount = 0;
  }

  get coolingDown() {
    return Date.now() < this.cooldownUntil;
  }

  _key(targetType, targetId) {
    return `${targetType}:${targetId}`;
  }

  _prune(list, now) {
    while (list.length > 0 && now - list[0] > 60000) list.shift();
    return list;
  }

  assertContent(text) {
    const value = String(text || '');
    if (!value) return;
    if (this.cfg.blockLinks && /https?:\/\/|www\.|t\.cn\//i.test(value)) {
      this.blockedCount += 1;
      throw new Error('消息含链接，已被发送守卫拦截（如需发送请让主人临时关闭 blockLinks）');
    }
    if (this.cfg.blockPhones && /\b1[3-9]\d{9}\b/.test(value)) {
      this.blockedCount += 1;
      throw new Error('消息含手机号，已被发送守卫拦截');
    }
    for (const item of this.patterns) {
      if (item.re.test(value)) {
        this.blockedCount += 1;
        throw new Error(`消息含高风险词「${item.label}」，已被发送守卫拦截`);
      }
    }
  }

  assertNotDuplicate(text, targetType, targetId) {
    const value = String(text || '').trim();
    if (!value) return;
    const key = this._key(targetType, targetId) + '|' + value;
    const now = Date.now();
    const last = this.recentText.get(key) || 0;
    if (now - last < this.cfg.dedupWindowMs) {
      this.blockedCount += 1;
      throw new Error('30 秒内已给该会话发过相同内容，已拦截重复消息');
    }
  }

  async waitTurn(targetType, targetId) {
    if (this.coolingDown) {
      const seconds = Math.ceil((this.cooldownUntil - Date.now()) / 1000);
      throw new Error(`发送已熔断（风控保护），还需等待 ${seconds} 秒`);
    }
    const key = this._key(targetType, targetId);
    const perChatLimit = targetType === 'group'
      ? Math.min(this.cfg.ratePerChatPerMinute, this.cfg.groupRatePerMinute)
      : this.cfg.ratePerChatPerMinute;
    const minInterval = targetType === 'group' ? this.cfg.groupMinSendIntervalMs : this.cfg.minSendIntervalMs;
    let waitMs = 0;
    for (;;) {
      const now = Date.now();
      this._prune(this.globalSent, now);
      let chat = this.chatSent.get(key) || [];
      chat = this._prune(chat, now);
      this.chatSent.set(key, chat);
      let need = 0;
      if (this.globalSent.length >= this.cfg.ratePerMinute) {
        need = Math.max(need, 60000 - (now - this.globalSent[0]));
      }
      if (chat.length >= perChatLimit) {
        need = Math.max(need, 60000 - (now - chat[0]));
      }
      const last = this.lastSentAt.get(key) || 0;
      if (last) need = Math.max(need, minInterval - (now - last));
      if (need <= 0) break;
      waitMs = Math.max(waitMs, need);
      await sleep(need + 20);
    }
    if (this.cfg.jitterMs > 0) {
      const jitter = Math.floor(Math.random() * this.cfg.jitterMs);
      if (jitter > 0) await sleep(jitter);
    }
    const now = Date.now();
    this.globalSent.push(now);
    const chat = this.chatSent.get(key) || [];
    chat.push(now);
    this.chatSent.set(key, chat);
    this.lastSentAt.set(key, now);
  }

  recordSuccess(text, targetType, targetId) {
    this.failureStreak = 0;
    this.sentCount += 1;
    const value = String(text || '').trim();
    if (value) this.recentText.set(this._key(targetType, targetId) + '|' + value, Date.now());
  }

  recordFailure(error) {
    const message = errorMessage(error);
    const riskLike = /风控|频繁|禁言|封禁|冻结|risk|blocked|1200|1400|发送失败/i.test(message);
    if (!riskLike) return { tripped: false };
    this.failureStreak += 1;
    if (this.failureStreak < this.cfg.breakerFailures || this.coolingDown) return { tripped: false };
    this.cooldownUntil = Date.now() + this.cfg.breakerCooldownMs;
    this.failureStreak = 0;
    if (Date.now() - this.alertedAt > this.cfg.breakerCooldownMs) {
      this.alertedAt = Date.now();
      const minutes = Math.round(this.cfg.breakerCooldownMs / 60000);
      const reason = message.slice(0, 200);
      void Promise.resolve(this.notifyOwner(
        `【风控熔断】连续发送失败，已暂停对外发送 ${minutes} 分钟。\n原因：${reason}\n这条只发给你，不会发给其他人。`,
      )).catch(() => {});
    }
    return { tripped: true };
  }

  status() {
    return {
      coolingDown: this.coolingDown,
      cooldownRemainingSec: Math.max(0, Math.ceil((this.cooldownUntil - Date.now()) / 1000)),
      failureStreak: this.failureStreak,
      sentCount: this.sentCount,
      blockedCount: this.blockedCount,
      limits: {
        ratePerMinute: this.cfg.ratePerMinute,
        ratePerChatPerMinute: this.cfg.ratePerChatPerMinute,
        minSendIntervalMs: this.cfg.minSendIntervalMs,
        groupMinSendIntervalMs: this.cfg.groupMinSendIntervalMs,
        groupRatePerMinute: this.cfg.groupRatePerMinute,
        dedupWindowMs: this.cfg.dedupWindowMs,
        breakerFailures: this.cfg.breakerFailures,
        breakerCooldownMs: this.cfg.breakerCooldownMs,
      },
    };
  }
}
