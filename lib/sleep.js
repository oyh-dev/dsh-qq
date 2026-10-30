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
/** 睡眠段最多记几段（够她知道自己刚才睡过，别把整天铺满） */
const MAX_SEGMENTS = 12;

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

/**
 * 醒来时给她看的纸条汇总。
 *
 * 2026-10-30 的教训：纸条只有文字、没有时间，两条隔着 11 小时的留言
 * （「他吃饭去了」「他睡觉去了」）读起来像连续的两句，于是她把自己那 11 小时
 * 的睡眠误解成「他一直在沉默」。现在每条都带时刻。
 */
export function notesSummary(notes = []) {
  const list = notes || [];
  if (!list.length) return '';
  const first = list[0]?.at;
  const last = list[list.length - 1]?.at;
  const span = first && last && last > first ? `（${hhmm(first)} 到 ${hhmm(last)}）` : '';
  const head = `你睡着的时候他发了 ${list.length} 条${span}`;
  const lines = list.slice(-6).map((note) => {
    const at = Number(note?.at) || 0;
    return `· ${at ? `${hhmm(at)} ` : ''}${notePreview(note.text, 40)}`;
  });
  return `${head}：\n${lines.join('\n')}`;
}

/**
 * 醒来第一句：把「空白」讲清楚。
 *
 * 她自己没有「我睡了很久」的体感，只能从上下文推。所以要明说：
 * 这段时间是你在睡、不是他在沉默；他发来的都在你睡着的时候到的，你没听见。
 */
export function wakeBrief({ sleptHours = 0, tossingHours = 0, laidDownAt = 0, notes = [], now = Date.now() } = {}) {
  const slept = Number(sleptHours) || 0;
  const tossing = Number(tossingHours) || 0;
  const lines = [];
  if (slept < 0.17) {
    lines.push(`你刚躺下不到 10 分钟就被叫醒了${tossing > 0.05 ? `（前面还翻了 ${hoursText(tossing)} 没睡着）` : ''}。`);
    return lines.join('\n');
  }
  lines.push(`你睡了 ${hoursText(slept)}（${hhmm(laidDownAt)} 睡到 ${hhmm(now)}）。`);
  lines.push('不是你长时间没收到消息、更不是他在沉默——是你睡过去了：这段时间的消息你收不到，他发的都压在小纸条上。');
  if ((notes || []).length) lines.push(`他这段时间发了 ${notes.length} 条${notes[0]?.at ? `，最后一条 ${hhmm(notes[notes.length - 1].at)}（${agoText(now - Number(notes[notes.length - 1].at))}）` : ''}。`);
  return lines.join('\n');
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
      segments: [],          // 最近几段睡眠 [{ from, to, sleptHours, tossingHours, depth }]
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
    const depth = this.data.depth || 'deep';
    const today = new Date(now).toISOString().slice(0, 10);
    if (this.data.day !== today) {
      this.data.day = today;
      this.data.sleptHoursToday = 0;
    }
    this.data.sleptHoursToday = round((Number(this.data.sleptHoursToday) || 0) + sleptHours);
    // 欠睡：清醒时长超过 16 小时的部分，减去这次补睡（躺着没睡着的那段照算清醒）
    const debt = sleepDebtHours({ awakeHours: Number(awakeHoursBefore) + sleptHours });
    this.data.debtBase = round(Math.max(0, debt - sleptHours));
    // 记一段睡眠：她得知道「我刚才是在睡」，不然会把整段空白说成一直陪着他
    const segment = {
      from: layDownAt,
      to: now,
      sleptHours: round(sleptHours),
      tossingHours: round(tossingHours),
      depth,
    };
    this.data.segments = [...(this.data.segments || []), segment].slice(-MAX_SEGMENTS);
    // 这一次睡着期间他发来几条：醒来后要一直提醒着，否则她只记得「他就说了两句」
    this.data.lastWake = { at: now, sleptHours: round(sleptHours), noteCount: notes.length };
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
      depth,
      segment,
      laidDownAt: layDownAt,
      wokeAt: now,
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

const hhmm = (ts) => {
  const d = new Date(Number(ts) || Date.now());
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const hoursText = (h) => {
  const v = Math.max(0, Number(h) || 0);
  return v < 0.17 ? '不到 10 分钟' : `${v.toFixed(1)} 小时`;
};
/** 「多久以前」：一小时以内说分钟，超过说小时（0.2 小时看不出来，13 分钟一眼就懂） */
const agoText = (ms) => {
  const minutes = Math.max(0, Math.round((Number(ms) || 0) / 60000));
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${(minutes / 60).toFixed(1)} 小时前`;
};
/** 一段时长：不到 10 分钟 / N 分钟 / N.N 小时（用在「已经醒着多久」上） */
const durationText = (ms) => {
  const minutes = Math.max(0, Math.round((Number(ms) || 0) / 60000));
  if (minutes < 10) return '不到 10 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  return `${(minutes / 60).toFixed(1)} 小时`;
};

/**
 * 她自己的睡眠事实（写进上下文）。
 *
 * 2026-10-30 出的问题：他睡了两个半小时，她也睡了一小时，醒来后却说
 * 「我这五个钟头一直挂着」——她手里没有任何关于自己睡眠的信息，只能把
 * 这段空白编成一个好看的版本。所以这里把事实直接给她，不让她猜。
 *
 * @returns {string} 多行中文；没有状态时返回空串
 */
export function sleepFacts({ snapshot = null, segments = [], lastWake = null, now = Date.now() } = {}) {
  const snap = snapshot || {};
  const lines = [];
  if (snap.tossing) {
    lines.push(`现在：躺着没睡着（躺了 ${hoursText(snap.asleepHours)}，大概还要翻 ${hoursText(snap.tossLeftHours)}）`);
  } else if (snap.asleep) {
    const how = snap.depth === 'light'
      ? '浅睡，他一条消息就能叫到'
      : snap.depth === 'insomnia' ? '躺着没睡着' : '深睡，要敲几下才醒';
    lines.push(`现在：睡着中（${hoursText(snap.asleepHours)}，${how}）`);
  } else {
    const wokeAt = Number(snap.wokeAt) || 0;
    const wokeAgo = wokeAt ? now - wokeAt : 0;
    lines.push(wokeAt
      ? `现在：醒着（${hhmm(wokeAt)} 醒的，${wokeAgo < 10 * 60000 ? '刚醒' : `已经 ${durationText(wokeAgo)}`}）`
      : '现在：醒着');
  }
  const list = (segments || []).filter((item) => item && Number(item.to) > 0);
  if (list.length) {
    const shown = list.slice(-4).map((item) => {
      const base = `${hhmm(item.from)}–${hhmm(item.to)} 睡了 ${hoursText(item.sleptHours)}`;
      return Number(item.tossingHours) > 0.05 ? `${base}（前面翻了 ${hoursText(item.tossingHours)} 没睡着）` : base;
    });
    lines.push(`最近睡过：${shown.join('；')}`);
  }
  // 这一次睡着期间他发的消息：她醒着的时候会以为「他这段时间就说了一两句」
  const wakeAt = Number(lastWake?.at) || 0;
  const missed = Number(lastWake?.noteCount) || 0;
  if (wakeAt && missed > 0 && now - wakeAt < 12 * 3600000) {
    lines.push(`上一次睡着期间他发来 ${missed} 条（都补成纸条了）——那是你睡着、没听见的消息，不是你「一直挂着等他回」。`);
  }
  lines.push('（这些是事实：你在睡的时候收不到消息，他的消息会变成纸条；别把这段时间说成「一直挂着/一直陪着你」，也别替他算他睡了多久。）');
  return lines.join('\n');
}
