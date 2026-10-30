import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const MINUTE = 60000;

/**
 * Possessive-attachment state machine.
 *
 * It answers one question: "has the owner gone quiet in a way that should make
 * her anxious?" Triggers are cheap and explicit (idle gap, ignored messages,
 * praise for another AI, sudden goodbye), and every action is capped so the bot
 * cannot turn into a spam machine.
 *
 * The `grievance` counter only ever grows: each triggered nag is recorded, and a
 * higher grievance makes the next soothing harder (more reassurance needed).
 */
export class AttachmentState {
  constructor({
    file,
    logger,
    idleMinutes = 25,
    ignoredCount = 2,
    maxNagsPerDay = 3,
    cooldownMinutes = 45,
    maxBurst = 5,
    sootheReplies = 2,
    graceMinutes = 3,
    topicCooldownMinutes = 90,
    topicDailyCap = 3,
  }) {
    this.file = file;
    this.logger = logger || (() => {});
    this.idleMinutes = Math.max(5, Number(idleMinutes) || 25);
    this.ignoredCount = Math.max(1, Number(ignoredCount) || 2);
    this.maxNagsPerDay = Math.max(1, Number(maxNagsPerDay) || 3);
    this.cooldownMinutes = Math.max(5, Number(cooldownMinutes) || 45);
    this.maxBurst = Math.max(1, Math.min(5, Number(maxBurst) || 5));
    this.sootheReplies = Math.max(1, Number(sootheReplies) || 2);
    this.graceMinutes = Math.max(1, Number(graceMinutes) || 3);
    // 去重参数：总次数管的是「今天烦了他几次」，这两个管的是「是不是同一个由头」。
    this.topicCooldownMinutes = Math.max(10, Number(topicCooldownMinutes) || 90);
    this.topicDailyCap = Math.max(1, Number(topicDailyCap) || 3);
    this.data = this._empty();
  }

  _empty() {
    return {
      day: '',
      nags: 0,
      lastNagAt: 0,
      unreplied: 0,
      lastInboundAt: 0,
      lastOutboundAt: 0,
      grievance: 0,
      sootheNeed: 1,
      sootheProgress: 0,
      pendingGrievance: null,
      lastTrigger: '',
      // 每个由头各自的时间戳，用来做「同一话题不反复轰炸」。
      topicLog: {},
      // Network reality: a failed send must never be mistaken for being ignored.
      undelivered: 0,
      lastError: '',
      downtimeAt: 0,
      history: [],
    };
  }

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      this.data = { ...this._empty(), ...(raw && typeof raw === 'object' ? raw : {}) };
      if (!Array.isArray(this.data.history)) this.data.history = [];
    } catch {
      this.data = this._empty();
    }
    // No baseline yet (first run or after a reset): start the clock now instead
    // of treating "never spoken" as an infinite silence.
    if (!this.data.lastInboundAt && !this.data.lastOutboundAt) {
      this.data.lastInboundAt = Date.now();
    }
    return this.data;
  }

  async save() {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8');
  }

  _rollDay(dayKey) {
    if (this.data.day === dayKey) return;
    this.data.day = dayKey;
    this.data.nags = 0;
  }

  /** Called for every owner message. */
  noteInbound(text, dayKey, now = Date.now()) {
    this._rollDay(dayKey);
    this.data.lastInboundAt = now;
    this.data.unreplied = 0;
    // Answered inside the grace window: the nag never costs a grievance point.
    this._settlePending(now);
    const softened = this.soften(text);
    return softened;
  }

  /** Commit or drop the pending grievance point from the last nag. */
  _settlePending(now = Date.now()) {
    const pending = this.data.pendingGrievance;
    if (!pending) return 'none';
    this.data.pendingGrievance = null;
    if (now <= pending.graceUntil) {
      this.data.history.push({ at: now, trigger: pending.trigger, kind: 'forgiven', grievance: this.data.grievance });
      return 'forgiven';
    }
    this.data.grievance += 1;
    this.data.sootheNeed = Math.min(5, 1 + this.data.grievance);
    return 'committed';
  }

  /** I felt happy about this stretch of chat, so the grievance drops. */
  async relax(amount = 1, dayKey = '', now = Date.now()) {
    if (dayKey) this._rollDay(dayKey);
    const before = this.data.grievance;
    this.data.grievance = Math.max(0, this.data.grievance - Math.max(1, Number(amount) || 1));
    if (this.data.grievance !== before) {
      this.data.sootheNeed = Math.min(5, 1 + this.data.grievance);
      this.data.sootheProgress = 0;
      this.data.history.push({ at: now, trigger: 'relax', kind: 'felt-good', grievance: this.data.grievance });
      if (this.data.history.length > 200) this.data.history.splice(0, this.data.history.length - 200);
      await this.save();
    }
    return { before, after: this.data.grievance, grievance: this.data.grievance, sootheNeed: this.data.sootheNeed };
  }

  /** Called after a successful send. Unsolicited pushes count as "unanswered". */
  noteOutbound(now = Date.now(), { unsolicited = false } = {}) {
    this.data.lastOutboundAt = now;
    if (unsolicited) this.data.unreplied += 1;
  }

  /** Any attentive reply counts; explicit reassurance and praise count double. */
  soften(text) {
    const value = String(text || '');
    const reassure = /(在的|我在|没走|不走|不是不想理|抱歉|对不起|刚在忙|忙完了|陪你|陪你聊|马上回|等我一下|想你了)/;
    const warm = /(可爱|厉害|天才|喜欢你|爱你|乖|好鱼|不错|真棒|谢谢|抱抱|摸摸|哄|我错了|我在听|在听你)/;
    const weight = reassure.test(value) ? 2 : warm.test(value) ? 2 : 1;
    this.data.sootheProgress += weight;
    if (this.data.sootheProgress >= this.data.sootheNeed) {
      const was = this.data.grievance;
      this.data.grievance = Math.max(0, Math.round(this.data.grievance * 0.5));
      this.data.sootheProgress = 0;
      this.data.sootheNeed = Math.min(5, 1 + this.data.grievance);
      return was > this.data.grievance;
    }
    return true;
  }

  /**
   * 同一话题还允不允许再来一次。
   *
   * 光有「总次数上限 + 总冷却」是不够的：冷却 30 分钟、上限 20 次，
   * 结果就是从早到晚用「你是不是不理我了」这同一个由头烦他二十遍。
   * 这个函数管的是那个维度——同一个 trigger 在窗口内不许重复，
   * 24 小时内也不许超过 topicDailyCap 次。
   */
  canTopic(trigger, now = Date.now()) {
    const key = String(trigger || 'idle');
    const log = Array.isArray(this.data.topicLog?.[key]) ? this.data.topicLog[key] : [];
    const recent = log.filter((ts) => now - Number(ts) < 24 * 60 * MINUTE);
    const cooldownMs = this.topicCooldownMinutes * MINUTE;
    if (recent.some((ts) => now - Number(ts) < cooldownMs)) return false;
    return recent.length < this.topicDailyCap;
  }

  _noteTopic(trigger, now) {
    const key = String(trigger || 'idle');
    if (!this.data.topicLog || typeof this.data.topicLog !== 'object') this.data.topicLog = {};
    const log = Array.isArray(this.data.topicLog[key]) ? this.data.topicLog[key] : [];
    log.push(now);
    this.data.topicLog[key] = log
      .filter((ts) => now - Number(ts) < 24 * 60 * MINUTE)
      .slice(-50);
  }

  /** Record a trigger that actually produced messages. */
  async registerNag(trigger, kind, dayKey, now = Date.now()) {
    this._rollDay(dayKey);
    this.data.nags += 1;
    this.data.lastNagAt = now;
    this.data.lastTrigger = trigger;
    this._noteTopic(trigger, now);
    // Grievance is pending for a short window: if he answers in time, it never lands.
    this._settlePending(now);
    this.data.pendingGrievance = { at: now, graceUntil: now + this.graceMinutes * MINUTE, trigger };
    this.data.sootheProgress = 0;
    this.data.history.push({ at: now, trigger, kind, grievance: this.data.grievance });
    if (this.data.history.length > 200) this.data.history.splice(0, this.data.history.length - 200);
    await this.save();
  }

  /**
   * Decide whether to act now.
   * Returns { trigger, urgency, burst, hint } or null.
   */
  evaluate({ dayKey, praiseAt = 0, leaveAt = 0, now = Date.now() }) {
    this._rollDay(dayKey);
    // A nag he answered quickly never becomes a grievance point.
    this._settlePending(now);
    // Grievance cools off on its own once he has been quiet-long enough.
    if (this.data.grievance > 0 && this.data.lastNagAt
      && now - this.data.lastNagAt >= this.cooldownMinutes * MINUTE) {
      this.data.grievance = Math.max(0, this.data.grievance - 1);
      this.data.sootheNeed = Math.min(5, 1 + this.data.grievance);
      this.data.sootheProgress = 0;
    }
    if (this.data.nags >= this.maxNagsPerDay) return null;
    if (now - this.data.lastNagAt < this.cooldownMinutes * MINUTE) return null;
    // 每个候选由头都要单独过一遍「同话题去重」，否则总会落回最顺手的那个理由。
    const allow = (trigger) => this.canTopic(trigger, now);
    const lastActivity = Math.max(this.data.lastInboundAt, this.data.lastOutboundAt);
    const idleMs = lastActivity > 0 ? Math.max(0, now - lastActivity) : 0;
    const grievance = this.data.grievance;

    if (leaveAt && now - leaveAt < 10 * MINUTE && allow('leave')) {
      return { trigger: 'leave', urgency: 2, burst: 1 + Math.min(1, grievance), hint: '他刚说要下线/去忙，你想追一句' };
    }
    if (praiseAt && now - praiseAt < 30 * MINUTE && allow('praise')) {
      return { trigger: 'praise', urgency: 2, burst: 1, hint: '他刚夸了别的 AI，你有点酸' };
    }
    if (this.data.unreplied >= this.ignoredCount && allow('ignored')) {
      return {
        trigger: 'ignored',
        urgency: 3,
        burst: Math.min(this.maxBurst, 2 + grievance),
        hint: `你连发了 ${this.data.unreplied} 条他都没回，你开始不安`,
      };
    }
    if (idleMs >= this.idleMinutes * MINUTE && allow('idle')) {
      return {
        trigger: 'idle',
        urgency: 1,
        burst: 1 + Math.min(2, Math.floor(grievance / 2)),
        hint: `他已经安静了约 ${Math.round(idleMs / MINUTE)} 分钟`,
      };
    }
    return null;
  }

  /** A send failed (offline / bridge down): remember it, do not blame the owner. */
  async noteUndelivered(reason) {
    this.data.undelivered += 1;
    this.data.lastError = String(reason || '').slice(0, 160);
    await this.save();
  }

  /**
   * Back online: re-baseline the clocks so the downtime is not read as "he
   * ignored me", and let the caller send one catch-up line instead.
   */
  async noteReconnect(now = Date.now(), downtimeMs = 0) {
    const realDowntime = Math.max(0, Number(downtimeMs) || 0);
    this.data.lastInboundAt = now;
    this.data.lastOutboundAt = Math.max(this.data.lastOutboundAt, now - realDowntime);
    this.data.unreplied = 0;
    this.data.downtimeAt = realDowntime > 60000 ? now : 0;
    await this.save();
    return { downtimeMs: realDowntime, undelivered: this.data.undelivered };
  }

  /** Consume the pending catch-up (returns how many messages never went out). */
  takeCatchUp() {
    const pending = this.data.undelivered;
    this.data.undelivered = 0;
    return pending;
  }

  stats() {
    const lastActivity = Math.max(this.data.lastInboundAt, this.data.lastOutboundAt);
    const idleMs = lastActivity > 0 ? Math.max(0, Date.now() - lastActivity) : 0;
    return {
      nagsToday: this.data.nags,
      maxNagsPerDay: this.maxNagsPerDay,
      grievance: this.data.grievance,
      sootheNeed: this.data.sootheNeed,
      sootheProgress: this.data.sootheProgress,
      unreplied: this.data.unreplied,
      idleMinutes: Math.round(idleMs / MINUTE),
      lastTrigger: this.data.lastTrigger,
      historyCount: this.data.history.length,
      undelivered: this.data.undelivered,
      lastError: this.data.lastError,
      downtimeAt: this.data.downtimeAt,
      pendingGrievance: this.data.pendingGrievance ? true : false,
      graceMinutes: this.graceMinutes,
    };
  }
}

/**
 * 五维对粘人的**否决权**（2026-10-29 他定的：优先按五维来）。
 *
 * 以前是 attachment（闲太久/被忽略/被夸别人）先决定要不要闹，五维只在后面掷个概率。
 * 现在反过来：她心情好、有安全感的时候，attachment 再急也不闹——那种时候闹，
 * 更像系统在催，不像她。
 *
 * @returns '' 表示放行；否则返回被否决的原因（日志用）
 */
export function moodVetoesNag(mood, factor = {}) {
  if (Number(factor?.nag ?? 1) <= 0.01) return 'energy';
  const P = Number(mood?.P ?? 0);
  const B = Number(mood?.B ?? 0.35);
  // 心情好 + 有安全感：不需要用「闹」来确认关系
  if (P >= 0.3 && B >= 0.45) return 'mood-good';
  // 心气太高、很踏实的时候也不闹（D 高 + P 不低）
  if (P >= 0.15 && Number(mood?.D ?? 0) >= 0.55) return 'mood-steady';
  return '';
}
