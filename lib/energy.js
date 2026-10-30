/**
 * 生理层（第一块）：能量槽。
 *
 * 出发点：累不累应该影响「我愿不愿意开口」，不该影响「我能不能接住他」。
 * 所以这里只产出三样东西：
 *   1. 主动消息 / 粘人的乘数（累 → 少找他、别闹）
 *   2. 一段**事实**（今天回了多少条、多久没休息），让语言模型自己判断累不累
 *   3. 心情的**瞬时偏置**（不写回五维，避免把疲劳永久腌进情绪里）
 *
 * 刻意不做的事：
 *   - 不给语言模型看数字（看到 0.23 就只会演「我好累哦」）
 *   - 不截断回复（截断会切断语义，还会漏掉他真正的急事）——低电量只让它「不主动」，
 *     他找我时我照常回，这比什么规则都像人
 *   - 乘数有地板：再累也不会变成 0，冷落他是底线不是效果
 */

export const ENERGY_MAX = 1;
/** 低于这个值进低功耗：不查岗、不轰炸、不主动找茬 */
export const ENERGY_LOW = 0.3;
/** 低于这个值开始有影响，但不至于进低功耗 */
export const ENERGY_MILD = 0.6;

/** 静默每小时恢复多少（约 5 小时从低电回满） */
const RECOVER_PER_HOUR = 0.12;
/** 一次对话消耗多少 */
const SPEND_PER_TURN = 0.01;
/** 超过这么久没说话，就当睡了一觉：满血 */
const SLEEP_HOURS = 6;

const clamp = (v, lo = 0, hi = ENERGY_MAX) => Math.max(lo, Math.min(hi, Number.isFinite(Number(v)) ? Number(v) : lo));
const round = (v) => Math.round(v * 1000) / 1000;

export function recoverEnergy(level, hours) {
  const h = Math.max(0, Number(hours) || 0);
  return round(clamp(clamp(level) + h * RECOVER_PER_HOUR));
}

export function spendEnergy(level, turnCost = SPEND_PER_TURN) {
  return round(clamp(clamp(level) - Math.max(0, Number(turnCost) || 0)));
}

/**
 * 能量 → 行为参数。
 * 高能量**不加成**：不累只是「正常」，不是「精神好」。
 */
export function energyEffects(level) {
  const value = clamp(level);
  const low = value < ENERGY_LOW;
  const mild = !low && value < ENERGY_MILD;
  // 低电：主动消息压到 0.3，粘连（nag）直接 0 —— 累的时候不该闹人
  const proactiveMul = low ? 0.3 : mild ? 0.7 : 1;
  const nagMul = low ? 0 : mild ? 0.5 : 1;
  return {
    level: round(value),
    low,
    mild,
    proactiveMul,
    nagMul,
    // 瞬时偏置：只在算行为时叠加，不写回 mood.json
    moodBias: {
      A: low ? -0.25 : mild ? -0.1 : 0,
      D: low ? 0.1 : 0,
      P: low ? -0.15 : 0,
    },
  };
}

/** 给状态事实用的一句话所需数据（只给可观察的量，不给分数）。 */
export function energyFacts({ turnsToday = 0, baselineTurns = 0, hoursSinceRest = 0 } = {}) {
  if (Number(hoursSinceRest) >= SLEEP_HOURS) return '';
  const turns = Math.round(Number(turnsToday) || 0);
  const base = Number(baselineTurns) || 0;
  if (turns < 20) return '';
  if (base > 0 && turns >= base * 1.5) {
    return `今天已经回了 ${turns} 条（这几天日均 ${Math.round(base)} 条）`;
  }
  return `今天已经回了 ${turns} 条`;
}

/** 能量槽本体：落盘、按时间恢复、按回合消耗。 */
export class EnergyStore {
  constructor({ file, logger = () => {} } = {}) {
    this.file = file || '';
    this.logger = logger;
    this.data = { level: ENERGY_MAX, lastAt: Date.now(), lastRestAt: Date.now(), day: '', turns: 0 };
    this.loaded = false;
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
          level: clamp(saved.level ?? ENERGY_MAX),
          lastAt: Number(saved.lastAt) || Date.now(),
          lastRestAt: Number(saved.lastRestAt) || Date.now(),
          day: String(saved.day || ''),
          turns: Number(saved.turns) || 0,
        };
      }
    } catch { /* 读不到就从满血开始 */ }
    this.tick();
    return this;
  }

  async save() {
    if (!this.file) return;
    try {
      const { writeJson } = await import('./util.js');
      await writeJson(this.file, this.data);
    } catch (error) {
      this.logger(`能量槽保存失败: ${error?.message ?? error}`);
    }
  }

  /**
   * 按时间恢复。
   *
   * 2026-10-29 去掉了「静默 6 小时直接回满」那条捷径：它和睡眠模块冲突——
   * 睡眠自己按「每小时回 45%」充电，能源层再直接拍满，等于把睡眠的账覆盖了；
   * 而且"静默 6 小时"不等于睡过（他只是没来聊天）。现在只按 RECOVER_PER_HOUR 慢慢回，
   * 睡够时间自然也能回满（8 小时 × 0.12 ≈ 1.0）。
   */
  tick(now = Date.now()) {
    const hours = Math.max(0, (now - Number(this.data.lastAt || now)) / 3600000);
    if (hours < 0.05) return this.data;
    this.data.level = recoverEnergy(this.data.level, hours);
    // 静默很久也算"歇过了"，让 hoursSinceRest 别无限涨
    if (hours >= SLEEP_HOURS) this.data.lastRestAt = now;
    this.data.lastAt = now;
    return this.data;
  }

  /** 聊完一轮：扣一点，并把当日计数推进。 */
  spend({ turns = 1, cost = SPEND_PER_TURN, day = '', now = Date.now() } = {}) {
    this.tick(now);
    const today = String(day || this.data.day || '');
    if (today && this.data.day !== today) {
      this.data.day = today;
      this.data.turns = 0;
    }
    this.data.level = spendEnergy(this.data.level, cost * Math.max(1, Number(turns) || 1));
    this.data.turns = (Number(this.data.turns) || 0) + Math.max(1, Number(turns) || 1);
    this.data.lastAt = now;
    return this.data;
  }

  effects() {
    return energyEffects(this.data.level);
  }

  snapshot() {
    const hoursSinceRest = Math.max(0, (Date.now() - Number(this.data.lastRestAt || Date.now())) / 3600000);
    return {
      level: round(this.data.level),
      turnsToday: Number(this.data.turns) || 0,
      hoursSinceRest: Math.round(hoursSinceRest * 10) / 10,
      ...this.effects(),
    };
  }
}
