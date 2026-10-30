import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * 艾宾浩斯加权记忆 · 最小原型
 *
 * 目标不是"记得更多"，是记住该记的、淡掉该淡的，并且淡的方式像人。
 * 设计文档：memory-calibration/DESIGN.md（随仓库发布的那份）
 *
 * 这一层只管三件事：**记录 / 打分 / 检索**。
 * 衰减公式已经实现，但不挂定时器——等真实分布出来再开。
 */

// ---------------------------------------------------------------- 常量

/** 层门槛：强度 ≥ 值 即归该层 */
export const LAYER_CUTS = { L1: 0.65, L2: 0.4, L3: 0.2 };

/**
 * 幂律遗忘（FSRS 公共形式）。R(t,S) = (1 + 19/81 · t/S) ^ -0.5
 * 系数 19/81 由 0.9^-2 - 1 推出，保证 t = S 时保留率正好 0.9。
 *
 * 为什么不用指数：指数早期掉太快，几天就腰斩，会让「上周刚说的事」瞬间不可见；
 * 幂律是长尾，早期缓、后期加速，更像「最近的事记得清、越久越糊」。
 */
export const FSRS_F = 19 / 81;

/**
 * 稳定性 S（天）——保留率降到 0.9 所需的天数。分层给不同 S。
 * 数值参考：事件 20-90，结构事件 180，教训再 ×3。
 */
export const STABILITY_DAYS = { L1: 90, L2: 40, L3: 20, pending: 20 };

/** 结构事件：关系定义变了的那些（划底线、表白、和解）。不分正负，S 最宽。 */
export const STRUCTURAL_STABILITY_DAYS = 180;

/** 教训：我自己犯的错。错的代价不会因为忘记而消失，S ×3。 */
export const LESSON_MULTIPLIER = 3;

/** 负向更黏：忘掉甜可以，忘掉疼不行。作用在 S 上，不是作用在曲线形状上。 */
export const NEGATIVE_FACTOR = 1.3;
export const RESOLVED_NEGATIVE_FACTOR = 1.15;

export const KINDS = ['event', 'structural', 'lesson'];

/**
 * 幂律永远不真正归零（S=40 时要 68000 天才掉到 0.05），所以「退场」不能靠阈值，
 * 只能靠容量：活跃条目超过上限时，按当前权重从低到高转冷存。冷存不注入，但数据还在。
 */
export const RETENTION_FLOOR = 0.02;
export const COLD_MAX_AGE_DAYS = 365;

/** 强度低于这个值，极性无意义，强制为 0。 */
export const POLARITY_FLOOR = 0.15;

/** 收束类型：决定链尾极性怎么算 */
export const CHAIN_STATES = ['resolved', 'open', 'dropped', 'fine'];

const DAY_MS = 86400000;

// ---------------------------------------------------------------- 纯函数

export function localDayKey(ts = Date.now()) {
  const d = new Date(Number(ts) || Date.now());
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function layerOf(intensity) {
  const n = Number(intensity);
  if (!Number.isFinite(n)) throw new Error(`强度不是数字: ${intensity}`);
  if (n >= LAYER_CUTS.L1) return 'L1';
  if (n >= LAYER_CUTS.L2) return 'L2';
  if (n >= LAYER_CUTS.L3) return 'L3';
  return 'pending';
}

/**
 * 稳定性 S（天）。按「事件性质」优先，其次按层，最后看极性。
 *   structural —— S=180，不管正负（关系长什么样，不该比一次争吵更早消失）
 *   lesson     —— 层 S ×3（我犯的错）
 *   event      —— 层 S；负向 ×1.3，已和解的 ×1.15
 */
export function stabilityDays(event = {}) {
  const { kind } = event;
  if (kind === 'structural') return STRUCTURAL_STABILITY_DAYS;

  let base = STABILITY_DAYS[event.layer] ?? STABILITY_DAYS.L3;
  if (kind === 'lesson') base *= LESSON_MULTIPLIER;

  const negative = Number(event.polarity_end ?? 0) < 0;
  if (!negative) return base;
  return base * (event.resolved ? RESOLVED_NEGATIVE_FACTOR : NEGATIVE_FACTOR);
}

/** 幂律保留率。t = S 时正好 0.9。 */
export function retention(ageDays, stabilityDaysValue) {
  const t = Number(ageDays);
  if (!(t > 0)) return 1;
  const s = Math.max(1, Number(stabilityDaysValue) || 1);
  return (1 + FSRS_F * (t / s)) ** -0.5;
}

/** 某条事件到此刻的保留率。 */
export function retentionOf(event, now = Date.now()) {
  const touched = Number(event?.last_touch ?? event?.ts ?? now);
  const ageDays = Math.max(0, (Number(now) - touched) / DAY_MS);
  return retention(ageDays, stabilityDays(event));
}

/**
 * 挑这轮要注入的记忆。
 *
 * 只有「词面真的撞上」才注入——**不做「没命中就带最近三天」的回退**。
 * 那个回退会让同几条旧事在每条消息里反复出现，等于天天翻旧账，
 * 而人设里写死了不许翻旧账。宁可一条都不带，让空命中指令去兜。
 *
 * 另外：注入只用 trigger / text（事实片段），**不用 claim**。
 * claim 是「我当时的解读」，是主观独白，注入进去会污染语气
 * （10-27 那次体验变差就是因为整天带着「热脸贴在冷水上」这种句子说话）。
 */
export function selectRecall(events = [], { grams = [], now = Date.now(), minHits = 2, minCurrent = 0.15 } = {}) {
  if (!grams.length) return [];
  const picked = [];
  for (const event of events) {
    if (event.zeroed_at || event.cold_at) continue;
    const current = decayedIntensity(event, now);
    if (current < minCurrent) continue;
    const hay = [event.trigger, event.text, ...(event.tags || [])].join(' ');
    if (!hay.trim()) continue;
    let hits = 0;
    for (const gram of grams) if (hay.includes(gram)) hits += 1;
    if (hits < minHits) continue;
    picked.push({ event, current, hits });
  }
  picked.sort((a, b) => (b.current + b.hits * 0.05) - (a.current + a.hits * 0.05));
  return picked;
}

/** 当前有效强度 = 原始强度 × 幂律保留率。last_touch 是上次重提/回忆的时刻。 */
export function decayedIntensity(event, now = Date.now()) {
  const base = Number(event?.intensity);
  if (!Number.isFinite(base) || base <= 0) return 0;
  return base * retentionOf(event, now);
}

/**
 * 是否已经不在注入池里。
 * 幂律下保留率几乎不会掉很低（S=40 要六万多天才到 0.05），
 * 所以真正的退场靠「冷存」：活跃条目超上限时按权重挤出去。这里只管两件事——
 * 显式标记的冷存/归零，和保留率跌破地板这种极端情况。
 */
export function isZeroed(event, now = Date.now()) {
  if (event?.zeroed_at || event?.cold_at) return true;
  return retentionOf(event, now) < RETENTION_FLOOR;
}

/**
 * 归一化一条打分。
 * 强度必须是正数（0 表示没发生或已完全忘记，不该被记成事件）。
 */
export function normalizeScore(input = {}) {
  const intensity = Number(input.intensity);
  if (!Number.isFinite(intensity)) throw new Error('缺 strength：intensity 必须是 0-1 的数字');
  if (intensity <= 0) throw new Error('强度必须大于 0：0 表示没发生或已忘记，不该记成事件');
  if (intensity > 1) throw new Error(`强度超出 0-1: ${intensity}`);

  const rounded = Math.round(intensity * 100) / 100;
  const layer = layerOf(rounded);

  // 强度太低时极性没有意义，强制 0 —— 不给噪声强编一个方向。
  const rawPolarity = Number(input.polarity_end ?? 0);
  const polarity = rounded < POLARITY_FLOOR
    ? 0
    : Math.max(-1, Math.min(1, Number.isFinite(rawPolarity) ? rawPolarity : 0));

  const clampSigned = (v) => Math.max(-1, Math.min(1, Number(v)));
  const low = Number.isFinite(Number(input.polarity_low))
    ? clampSigned(input.polarity_low)
    : polarity;

  const track = Array.isArray(input.polarity_track)
    ? input.polarity_track
      .filter((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(Number(p[1])))
      .map(([t, v]) => [Number(t) || 0, clampSigned(v)])
    : [];

  return {
    intensity: rounded,
    layer,
    polarity_end: polarity,
    polarity_low: Math.min(low, polarity),
    polarity_track: track,
  };
}

// ---------------------------------------------------------------- 存储

export class EbbStore {
  constructor(options = {}) {
    this.dir = options.dir || path.join(process.cwd(), 'ebb');
    this.eventsDir = path.join(this.dir, 'events');
    this.stateFile = path.join(this.dir, 'state.json');
    this.boundsFile = options.boundsFile || path.join(this.dir, 'bounds.json');
    this.logger = options.logger || (() => {});
    this._bounds = null;
  }

  async ensure() {
    await mkdir(this.eventsDir, { recursive: true });
  }

  /**
   * 记一条事件。
   * 只有强度 > 0 的事能进来；极性、层、轨迹在写入前归一化。
   */
  async record(input = {}) {
    await this.ensure();
    const score = normalizeScore(input);
    const ts = Number(input.ts) || Date.now();

    const event = {
      id: input.id || `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      ts,
      day: localDayKey(ts),
      span: Array.isArray(input.span) ? input.span.map(Number) : [ts, ts],
      chat: input.chat || { type: 'private', id: '' },

      ...score,
      intensity_his: Number.isFinite(Number(input.intensity_his)) ? Number(input.intensity_his) : null,

      state: CHAIN_STATES.includes(input.state) ? input.state : 'fine',
      kind: KINDS.includes(input.kind) ? input.kind : 'event',
      blame: ['me', 'him', 'none'].includes(input.blame) ? input.blame : '',
      resolved: Boolean(input.resolved),
      trigger: String(input.trigger || ''),
      claim: String(input.claim || ''),
      // 证据链：这条事件挂在哪句原话上。没有 quote 的记忆只是我的印象，
      // 回溯「我为什么记得这条」时就拿不出东西来。
      quote: String(input.quote || '').slice(0, 120),
      speaker: ['him', 'me', 'them'].includes(input.speaker) ? input.speaker : '',
      confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : 0.6,

      tags: Array.isArray(input.tags) ? input.tags.map(String).slice(0, 8) : [],
      pattern_key: String(input.pattern_key || ''),
      chain_id: String(input.chain_id || ''),

      text: String(input.text || '').slice(0, 2000),

      created: ts,
      last_touch: ts,
      touches: 0,
      zeroed_at: input.zeroed_at || null,
      diary_ref: String(input.diary_ref || ''),
    };

    const file = path.join(this.eventsDir, `${event.day}.jsonl`);
    await appendFile(file, `${JSON.stringify(event)}\n`, 'utf8');
    return event;
  }

  async _readDay(file) {
    const raw = await readFile(file, 'utf8');
    const rows = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
    }
    return rows;
  }

  /** 读时间范围内的事件。不给范围 = 全读。 */
  async load({ from, to } = {}) {
    await this.ensure();
    const names = (await readdir(this.eventsDir)).filter((n) => n.endsWith('.jsonl')).sort();
    const rows = [];
    for (const name of names) {
      const day = name.slice(0, -6);
      if (from && day < from) continue;
      if (to && day > to) continue;
      rows.push(...await this._readDay(path.join(this.eventsDir, name)));
    }
    return rows.sort((a, b) => a.ts - b.ts);
  }

  /** 重提 / 回忆：重置衰减计时器，并按间隔效应小幅回升。 */
  async touch(id, now = Date.now()) {
    const rows = await this.load();
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0) return null;
    const event = rows[index];
    event.last_touch = now;
    event.touches = (event.touches || 0) + 1;
    event.intensity = Math.min(1, event.intensity * 1.05);
    event.zeroed_at = null;
    await this._rewriteDay(rows.filter((row) => row.day === event.day));
    return event;
  }

  /**
   * 一条链握手言和：链内事件标记 resolved。
   * 效果是负向不再享 ×1.3，回落到 ×1.15——和解之后那场冷战的刺该钝掉。
   */
  async resolveChain(chainId, now = Date.now()) {
    const rows = await this.load();
    const hit = rows.filter((row) => row.chain_id === chainId);
    if (!hit.length) return 0;
    const days = new Set();
    for (const event of hit) {
      event.resolved = true;
      event.state = 'resolved';
      event.resolved_at = now;
      days.add(event.day);
    }
    for (const day of days) {
      await this._rewriteDay(rows.filter((row) => row.day === day));
    }
    return hit.length;
  }

  /**
   * 冷存：活跃条目超上限时，按当前权重从低到高挤进冷存。
   * 幂律不会归零，所以「退场」只能靠容量。结构事件永不冷存（关系长什么样，不该被挤掉）。
   */
  async compact({ keep = 120, now = Date.now() } = {}) {
    const rows = await this.load();
    const active = rows.filter((row) => !row.cold_at && !row.zeroed_at);
    if (active.length <= keep) return { moved: 0, active: active.length };

    const movable = active
      .filter((row) => row.kind !== 'structural')
      .sort((a, b) => decayedIntensity(a, now) - decayedIntensity(b, now));
    const need = active.length - keep;
    const picked = movable.slice(0, Math.min(need, movable.length));
    if (!picked.length) return { moved: 0, active: active.length };

    const ids = new Set(picked.map((row) => row.id));
    const days = new Set();
    for (const row of rows) {
      if (!ids.has(row.id)) continue;
      row.cold_at = now;
      days.add(row.day);
    }
    for (const day of days) {
      await this._rewriteDay(rows.filter((row) => row.day === day));
    }
    return { moved: ids.size, active: active.length - ids.size };
  }

  async _rewriteDay(rows) {
    if (!rows.length) return;
    const file = path.join(this.eventsDir, `${rows[0].day}.jsonl`);
    const body = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
    await writeFile(file, body, 'utf8');
  }

  /**
   * 检索。按当前有效强度降序。
   * 归零的事件默认不返回（除非 includeZeroed）。
   */
  async search({
    query = '',
    from, to, chatId,
    layer, minIntensity,
    includeZeroed = false,
    limit = 10,
    now = Date.now(),
  } = {}) {
    const rows = await this.load({ from, to });
    const needle = String(query || '').trim().toLowerCase();

    const scored = rows.map((event) => {
      const current = decayedIntensity(event, now);
      const hay = [
        event.text, event.trigger, event.claim,
        ...(event.tags || []),
        event.pattern_key || '',
      ].join(' ').toLowerCase();
      return { event, current, hay };
    }).filter(({ event, current, hay }) => {
      if (!includeZeroed && (event.zeroed_at || event.cold_at)) return false;
      if (!includeZeroed && current < RETENTION_FLOOR) return false;
      if (needle && !hay.includes(needle)) return false;
      if (chatId && String(event.chat?.id) !== String(chatId)) return false;
      if (layer) {
        const layers = Array.isArray(layer) ? layer : String(layer).split(',').map((s) => s.trim());
        if (!layers.includes(event.layer)) return false;
      }
      if (Number.isFinite(Number(minIntensity)) && current < Number(minIntensity)) return false;
      return true;
    });

    scored.sort((a, b) => b.current - a.current);
    return scored.slice(0, Math.max(1, Number(limit) || 10)).map(({ event, current }) => ({
      ...event,
      current_intensity: Math.round(current * 1000) / 1000,
    }));
  }

  // ---------------------------------------------------------------- 状态

  async readState() {
    if (!existsSync(this.stateFile)) {
      return { lastOrganizeAt: 0, lastWeeklyTouch: 0, driftAlarm: false, organizeWindowHours: 24 };
    }
    try { return JSON.parse(await readFile(this.stateFile, 'utf8')); } catch { return {}; }
  }

  async writeState(patch = {}) {
    const merged = { ...await this.readState(), ...patch };
    await this.ensure();
    await writeFile(this.stateFile, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  }

  // ---------------------------------------------------------------- 边界层

  async bounds() {
    if (this._bounds) return this._bounds;
    if (!existsSync(this.boundsFile)) return null;
    try {
      this._bounds = JSON.parse(await readFile(this.boundsFile, 'utf8'));
      return this._bounds;
    } catch (error) {
      this.logger(`边界文件读取失败: ${error?.message ?? error}`);
      return null;
    }
  }

  /** 自我约束那几条 —— 常驻段，每次生成都该在场。 */
  async standingText() {
    const b = await this.bounds();
    const items = b?.standing?.items || [];
    if (!items.length) return '';
    return items.map((item) => `- ${item.what}${item.strategy ? `（${item.strategy}）` : ''}`).join('\n');
  }

  /** 被越界的几条 —— 只给策略，不给旧账。 */
  async crossingText() {
    const b = await this.bounds();
    const items = b?.crossing?.items || [];
    if (!items.length) return '';
    return items.map((item) => `- 遇到「${item.what}」：${item.strategy}`).join('\n');
  }
}

export default EbbStore;
