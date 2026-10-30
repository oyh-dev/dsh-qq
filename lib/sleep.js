/**
 * 生理层（第二块）：睡眠。
 *
 * 设计意图（2026-10-29 他提的）：
 *   · 睡着时**大部分不回**，但连发多次能把她喊醒——越睡越久越难喊
 *   · 睡着的消息不叫「没收到」，压成**小纸条**，醒来一次性看，然后只回一两条最该回的
 *   · 长期不睡 → 欠睡（sleepDebt）→ 五维抖动、更难叫醒、记忆发糊；但不许突变反转
 *
 * 刻意不做的事：
 *   - 不做「80% 概率不回」那种随机：随机让人没法预期，也让她看起来像掉线。
 *     改成**敲门值**：每条消息 +1（连发叠得更快），到阈值才醒。规则清楚、可解释。
 *   - 不把睡着当成「离线」。关机是真没收到，睡眠是设计内的延迟，两者分开记。
 */

export const KNOCK_BASE = 3;        // 刚睡着：3 条能醒
export const KNOCK_PER_HOUR = 1.6;  // 每睡一小时，阈值 +1.6
export const KNOCK_DEBT = 0.8;      // 每欠睡一小时，阈值再 +

/**
 * 睡不着（2026-10-30 他提的）：能量太满的深夜，人是躺下了，但睡不着。
 *
 * 之前只有「累到该睡」这一个方向，满电的夜里她就不困、也就不睡——
 * 结果那一夜不算休息，第二天照欠睡。现在补上反方向：
 *   · 深夜 + 能量 ≥ 0.7 → 躺下，但进「睡不着」状态（depth='insomnia'）
 *   · 这段时间**不算睡**：不充能量、不推进睡够的时长、欠睡照算
 *   · 但她在床上，所以一条消息就能喊到（阈值 1），不是深睡那样要敲几下
 *   · 翻够 1.5~2.5 小时（越满电翻得越久）自然睡着，之后按正常睡眠算
 */
export const INSOMNIA_ENERGY = 0.7;   // 高于这个能量、在夜里 → 躺下睡不着
export const INSOMNIA_MIN_HOURS = 1.5;
export const INSOMNIA_MAX_HOURS = 2.5;
/** 连发间隔小于这个值就叠得更快（他急着找人时会连发） */
export const BURST_MS = 120000;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(Number(v)) ? Number(v) : lo));
const round = (v) => Math.round(v * 1000) / 1000;
const hourOf = (ts) => new Date(Number(ts) || Date.now()).getHours();

/** 夜晚时段：23:00 之后、07:00 之前。 */
export function isNight(now = Date.now()) {
  const h = hourOf(now);
  return h >= 23 || h < 7;
}

/** 下午觉时段：13:00–16:00。 */
export function isNapTime(now = Date.now()) {
  const h = hourOf(now);
  return h >= 13 && h < 16;
}

/**
 * 离天亮（07:00）还有几个小时。
 * 夜里睡着不该按「电量够了就爬起来」算，否则满电睡一小时又醒、再躺下翻一遍。
 */
export function hoursUntilMorning(now = Date.now()) {
  const d = new Date(Number(now) || Date.now());
  const h = d.getHours() + d.getMinutes() / 60;
  const span = h >= 23 ? 24 - h + 7 : h < 7 ? 7 - h : 0;
  return round(Math.max(0, span));
}

/**
 * 该不该想睡了。返回原因，便于她自己说一句「有点顶不住了」而不是无声消失。
 * tossing=true 表示「躺下但睡不着」：不是休息，只是身体躺在床上。
 * @returns {{ want: boolean, reason: 'energy'|'night'|'nap'|'insomnia'|'', tossing: boolean }}
 */
export function wantSleep({ level = 1, now = Date.now(), alreadyAsleep = false } = {}) {
  if (alreadyAsleep) return { want: true, reason: '', tossing: false };
  const energy = clamp(level, 0, 1);
  if (energy < 0.25) return { want: true, reason: 'energy', tossing: false };
  if (isNight(now)) {
    if (energy < INSOMNIA_ENERGY) return { want: true, reason: 'night', tossing: false };
    // 满电的深夜：不困，但也不该睁眼到天亮
    return { want: true, reason: 'insomnia', tossing: true };
  }
  if (isNapTime(now) && energy < 0.45) return { want: true, reason: 'nap', tossing: false };
  return { want: false, reason: '', tossing: false };
}

/**
 * 这一夜要翻多久才睡着：越满电越久，带点随机（每天不一样，但不出区间）。
 * @param rand 注入随机源，测试用
 */
export function insomniaHours({ level = 1, rand = Math.random } = {}) {
  const energy = clamp(level, 0, 1);
  const over = clamp((energy - INSOMNIA_ENERGY) / (1 - INSOMNIA_ENERGY), 0, 1);
  const base = INSOMNIA_MIN_HOURS + (INSOMNIA_MAX_HOURS - INSOMNIA_MIN_HOURS) * over;
  const jitter = (Number(rand()) || 0) * 0.4 - 0.2;
  return round(clamp(base + jitter, INSOMNIA_MIN_HOURS, INSOMNIA_MAX_HOURS));
}

/** 该睡多久：能量越低补得越多，封顶 4 小时。 */
export function sleepHoursNeeded(level = 1) {
  const energy = clamp(level, 0, 1);
  return round(Math.max(0.5, Math.min(4, (1 - energy) * 6)));
}

/**
 * 叫醒阈值：睡得越久、欠得越多，越难喊。
 * depth='light'（他说要睡了、她陪着躺）→ 阈值 1：一条就能叫醒。
 * depth='insomnia'（躺下但睡不着）→ 也是 1：她本来就睁着眼。
 * 她不是不在了，只是没再主动说话——他半夜想起来说一句，她该听得见。
 */
export function knockThreshold({ hoursAsleep = 0, debtHours = 0, depth = 'deep' } = {}) {
  const h = Math.max(0, (Number(hoursAsleep) || 0));
  const debt = Math.max(0, Number(debtHours) || 0);
  if (depth === 'light' || depth === 'insomnia') return 1;
  return Math.max(KNOCK_BASE, Math.round(KNOCK_BASE + h * KNOCK_PER_HOUR + debt * KNOCK_DEBT));
}

/**
 * 欠睡小时数：清醒超过 16 小时开始欠，每小时 +1。
 * 补睡过的那部分由调用方从 awakeHours 里扣掉（见 SleepStore.wake）。
 */
export function sleepDebtHours({ awakeHours = 0, limit = 16 } = {}) {
  return round(Math.max(0, (Number(awakeHours) || 0) - limit));
}

/** 欠睡导致的「脑子不清」：数值抖动幅度（0 → 0.25 封顶）。 */
export function muddleAmplitude(debtHours = 0) {
  return round(Math.min(0.25, Math.max(0, Number(debtHours) || 0) * 0.02));
}

/**
 * 给五维叠抖动。**不是反转、不是突变**——每个维度独立小幅晃动，看着就是「状态不稳」。
 * @param rand 注入随机源，测试用
 */
export function muddle(mood, debtHours = 0, rand = Math.random) {
  const amp = muddleAmplitude(debtHours);
  if (!(amp > 0)) return mood;
  const out = { ...mood };
  for (const key of ['P', 'A', 'D', 'B']) {
    const base = Number(mood?.[key]) || 0;
    out[key] = round(clamp(base + (rand() * 2 - 1) * amp, -1, 1));
  }
  // 良知也抖，但它的底线由 mood.js 的 G_FLOOR 管，这里只做小幅扰动
  out.muddled = amp;
  return out;
}

/** 纸条：一条消息压成一行，长句截断，避免醒来时被一屏字压住。 */
export function notePreview(text, limit = 60) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  return raw.length <= limit ? raw : `${raw.slice(0, limit)}…`;
}

/**
 * 醒来看纸条：挑最后 1~2 条「值得回」的。
 * 纯表情、太短的（嗯/哦/？）跳过——那些回一句总的就够了。
 */
export function pickReplyTargets(notes = [], { max = 2 } = {}) {
  const usable = (notes || []).filter((note) => {
    const text = String(note?.text || '').trim();
    return text.length >= 6;
  });
  return usable.slice(-Math.max(1, max));
}

/** 醒来时给他的一句汇总（他自己看得懂就行，不是给他发出去的文案）。 */
export function notesSummary(notes = []) {
  const list = notes || [];
  if (!list.length) return '';
  const head = `你睡着的时候他发了 ${list.length} 条`;
  const lines = list.slice(-6).map((note) => `· ${notePreview(note.text, 40)}`);
  return `${head}：\n${lines.join('\n')}`;
}

/**
 * 睡眠仓：落盘在 .qq-bridge/sleep.json。
 * 只记事实（几点睡、几点醒、敲了几下、纸条几条、欠睡多少），不记性格判断。
 */
export class SleepStore {
  constructor({ file = '', logger = () => {} } = {}) {
    this.file = file;
    this.logger = logger;
    this.data = {
      state: 'awake',        // awake | asleep
      depth: 'deep',         // deep（真困）| light（他睡下她陪着躺）| insomnia（躺下但睡不着）
      asleepSince: 0,        // 躺下的起点（睡不着期间也算躺下）
      fellAsleepAt: 0,       // 真的睡着的时刻；睡不着期间为 0
      tossHours: 0,          // 这一夜预计要翻多久才睡着
      wokeAt: 0,             // 上次醒来
      knock: 0,              // 本轮睡着后累计的敲门值
      lastKnockAt: 0,
      notes: [],             // [{ at, uin, text }]
      sleptHoursToday: 0,
      day: '',
      debtBase: 0,           // 已经结算掉的欠睡（醒来时累计）
    };
    this.loaded = false;
  }

  get asleep() {
    return this.data.state === 'asleep';
  }

  async load() {
    if (this.loaded) return this;
    this.loaded = true;
    if (!this.file) return this;
    try {
      const { readJson } = await import('./util.js');
      const saved = await readJson(this.file, null);
      if (saved && typeof saved === 'object') {
        this.data = {
          ...this.data,
          ...saved,
          notes: Array.isArray(saved.notes) ? saved.notes.slice(-40) : [],
        };
      }
    } catch { /* 读不到就从清醒开始 */ }
    return this;
  }

  async save() {
    if (!this.file) return;
    try {
      const { writeJson } = await import('./util.js');
      await writeJson(this.file, this.data);
    } catch (error) {
      this.logger(`睡眠状态保存失败: ${error?.message ?? error}`);
    }
  }

  /**
   * 睡下。reason 只用于日志。
   * depth='light'   ：他说「我睡了」时她陪着躺——不主动说话、不算深睡，一条消息就能叫醒。
   * depth='insomnia'：满电的深夜，躺下但睡不着——不算睡（不充电、不记睡够时长），一条消息能叫到。
   * depth='deep'    ：真困到不行 / 深夜耗尽了，按敲门阈值来。
   */
  enterSleep({ now = Date.now(), reason = '', depth = 'deep', tossHours = 0 } = {}) {
    if (this.asleep) return this.data;
    const kind = depth === 'light' ? 'light' : depth === 'insomnia' ? 'insomnia' : 'deep';
    this.data.state = 'asleep';
    this.data.asleepSince = now;
    this.data.fellAsleepAt = 0;
    this.data.depth = kind;
    this.data.tossHours = kind === 'insomnia'
      ? clamp(Number(tossHours) || INSOMNIA_MIN_HOURS, INSOMNIA_MIN_HOURS, INSOMNIA_MAX_HOURS)
      : 0;
    this.data.knock = 0;
    this.data.lastKnockAt = 0;
    this.data.notes = [];
    const tag = kind === 'light' ? '·浅睡' : kind === 'insomnia' ? '·躺下但睡不着' : '';
    this.logger?.(`睡下了${reason ? `（${reason}）` : ''}${tag}`);
    return this.data;
  }

  /** 翻够了，真的睡着（睡不着 → 深睡）。纸条和敲门值留着。 */
  fallAsleep({ now = Date.now() } = {}) {
    if (!this.asleep) return null;
    const tossingHours = Math.max(0, (now - Number(this.data.asleepSince || now)) / 3600000);
    this.data.depth = 'deep';
    this.data.fellAsleepAt = now;
    this.data.tossHours = 0;
    this.logger?.(`翻来覆去 ${tossingHours.toFixed(1)} 小时，睡着了`);
    return { tossingHours: round(tossingHours) };
  }

  /** 现在是不是「躺下但没睡着」。 */
  get tossing() {
    return this.asleep && this.data.depth === 'insomnia' && !(Number(this.data.fellAsleepAt) > 0);
  }

  /** 睡着期间来了消息：压成纸条 + 敲一下，够了就叫醒。 */
  knockMessage({ text, uin = '', now = Date.now(), debtHours = 0 } = {}) {
    if (!this.asleep) return { woke: false, asleep: false };
    const burst = now - (Number(this.data.lastKnockAt) || 0) < BURST_MS;
    this.data.knock = (Number(this.data.knock) || 0) + (burst ? 2 : 1);
    this.data.lastKnockAt = now;
    const preview = notePreview(text);
    if (preview) this.data.notes.push({ at: now, uin: String(uin || ''), text: preview });
    if (this.data.notes.length > 40) this.data.notes = this.data.notes.slice(-40);
    const hoursAsleep = Math.max(0, (now - Number(this.data.asleepSince || now)) / 3600000);
    const threshold = knockThreshold({ hoursAsleep, debtHours, depth: this.data.depth });
    return {
      woke: this.data.knock >= threshold,
      asleep: true,
      knock: this.data.knock,
      threshold,
      hoursAsleep: round(hoursAsleep),
      noteCount: this.data.notes.length,
    };
  }

  /** 醒来：结算睡了多久、欠睡多少、把纸条交出去。 */
  wake({ now = Date.now(), awakeHoursBefore = 16 } = {}) {
    const layDownAt = Number(this.data.asleepSince || now);
    const fellAt = Number(this.data.fellAsleepAt) || 0;
    // 睡不着的那段不算睡：只从真睡着的那一刻开始补；一直没睡着就是 0
    const neverFellAsleep = !fellAt && this.data.depth === 'insomnia';
    const sleptHours = neverFellAsleep ? 0 : Math.max(0, (now - (fellAt || layDownAt)) / 3600000);
    const tossingHours = neverFellAsleep
      ? Math.max(0, (now - layDownAt) / 3600000)
      : fellAt ? Math.max(0, (fellAt - layDownAt) / 3600000) : 0;
    const notes = this.data.notes.slice(-40);
    const today = new Date(now).toISOString().slice(0, 10);
    if (this.data.day !== today) {
      this.data.day = today;
      this.data.sleptHoursToday = 0;
    }
    this.data.sleptHoursToday = round((Number(this.data.sleptHoursToday) || 0) + sleptHours);
    // 欠睡：清醒时长超过 16 小时的部分，减去这次补睡（躺着没睡着的那段照算清醒）
    const debt = sleepDebtHours({ awakeHours: Number(awakeHoursBefore) + sleptHours });
    this.data.debtBase = round(Math.max(0, debt - sleptHours));
    this.data.state = 'awake';
    this.data.wokeAt = now;
    this.data.asleepSince = 0;
    this.data.fellAsleepAt = 0;
    this.data.tossHours = 0;
    this.data.knock = 0;
    this.data.notes = [];
    return {
      sleptHours: round(sleptHours),
      tossingHours: round(tossingHours),
      notes,
      noteCount: notes.length,
      sleepDebtHours: this.data.debtBase,
      summary: notesSummary(notes),
      replyTargets: pickReplyTargets(notes),
    };
  }

  /** 面板/工具用的快照（只读）。 */
  snapshot(now = Date.now()) {
    const layDownAt = Number(this.data.asleepSince || now);
    const fellAt = Number(this.data.fellAsleepAt) || 0;
    const asleepHours = this.asleep
      ? Math.max(0, (now - (fellAt || layDownAt)) / 3600000)
      : 0;
    const tossingHours = this.asleep && fellAt
      ? Math.max(0, (fellAt - layDownAt) / 3600000)
      : 0;
    const tossing = this.tossing;
    const tossLeftHours = tossing
      ? Math.max(0, (Number(this.data.tossHours) || INSOMNIA_MIN_HOURS) - (now - layDownAt) / 3600000)
      : 0;
    const debt = this.debt()
    return {
      state: this.data.state,
      depth: this.data.depth || 'deep',
      asleep: this.asleep,
      tossing,
      asleepHours: round(asleepHours),
      tossingHours: round(tossingHours),
      tossLeftHours: round(tossLeftHours),
      knock: Number(this.data.knock) || 0,
      threshold: knockThreshold({ hoursAsleep: asleepHours, debtHours: debt, depth: this.data.depth }),
      noteCount: (this.data.notes || []).length,
      sleptHoursToday: round(Number(this.data.sleptHoursToday) || 0),
      sleepDebtHours: debt,
      // 欠睡造成的抖动幅度：面板要标出来，否则他看到数值没变、她却已经在发糊
      muddleAmp: muddleAmplitude(debt),
      wokeAt: Number(this.data.wokeAt) || 0,
      muted: this.asleep,
    };
  }

  /** 当前欠睡量（每小时重算，不必等醒来）。 */
  debt({ now = Date.now() } = {}) {
    const base = Number(this.data.debtBase) || 0;
    // 清醒时长从「上次醒来」或「上次睡着」里较晚的那个算起
    const from = Number(this.data.wokeAt) || Number(this.data.asleepSince) || now;
    const awakeHours = Math.max(0, (now - from) / 3600000);
    return round(Math.max(0, base + Math.max(0, awakeHours - 16)));
  }
}

/** 五维抖动：欠睡 12 小时才会明显看出来（0.24），别让它一上来就乱晃。 */
export function shouldMuddle(debtHours = 0) {
  return muddleAmplitude(debtHours) > 0.05;
}
