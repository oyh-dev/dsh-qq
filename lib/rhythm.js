/**
 * 生理层（第二块）：昼夜节律。
 *
 * 三层，一层比一层难，也一层比一层容易做假：
 *   1. 事实：现在几点、今天第一次开口、这一轮聊了多久        —— 已经在跑
 *   2. 时段：按他的真实活跃分布，调整「我主动开口的频率」      —— 只压次数，不改语气
 *   3. 软区：深夜 + 他主动倾诉 + 当天有情绪事件，才让话变软    —— 靠触发，不靠钟点
 *
 * 硬规矩（写在这里，别改）：
 *   - 节律**不许**下调良知/安全层。深夜说错话不能变成「时间不对」。
 *   - 软区只影响「语气和反应速度」，不影响「回不回」。累了困了都是换种说法，不是不接。
 */

const MINUTE = 60000;

/** 把毫秒差写成「1 小时 40 分钟」这种人话；不足一分钟返回空。 */
export function humanSpan(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / MINUTE);
  if (total < 1) return '';
  const hours = Math.floor(total / 60);
  const minutes = Math.round(total % 60);
  if (hours <= 0) return `${minutes} 分钟`;
  if (minutes <= 0) return `${hours} 小时`;
  return `${hours} 小时 ${minutes} 分钟`;
}

function clock(ts) {
  return new Date(Number(ts)).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

/**
 * 时间事实。
 * @param now          当前时间
 * @param firstTalkAt  今天他第一次开口的时间戳（没有就别传）
 * @param streakStartAt 这一轮连着聊的起点（中间断了就重置）
 * @param streakGapMs  多久不说话算「断了」，默认 40 分钟
 */
export function clockFacts({
  now = Date.now(),
  firstTalkAt = 0,
  streakStartAt = 0,
  streakGapMs = 40 * MINUTE,
} = {}) {
  const lines = [];
  const first = Number(firstTalkAt) || 0;
  const streak = Number(streakStartAt) || 0;

  if (streak > 0 && now - streak >= 30 * MINUTE) {
    const span = humanSpan(now - streak);
    if (span) lines.push(`· 这一轮从 ${clock(streak)} 聊到现在，${span}`);
  }
  if (first > 0 && (!streak || Math.abs(streak - first) > streakGapMs)) {
    lines.push(`· 他今天第一次说话是 ${clock(first)}`);
  }
  // 只保留一条：加起来超过两行就变成流水账了
  return lines.slice(0, 1).join('\n');
}

/**
 * 维护「今天第一次开口」和「这一轮连着聊」的起点。
 * 纯状态机，不落盘——重启就当今天重新开始，错了也只是少说一句。
 */
export class RhythmClock {
  constructor({ gapMs = 40 * MINUTE } = {}) {
    this.gapMs = gapMs;
    this.day = '';
    this.firstAt = 0;
    this.streakAt = 0;
    this.lastAt = 0;
  }

  /** 记一次他开口；返回当前状态。 */
  noteInbound(now = Date.now(), day = '') {
    const today = String(day || this._dayOf(now));
    if (this.day !== today) {
      this.day = today;
      this.firstAt = 0;
      this.streakAt = 0;
    }
    if (!this.firstAt) this.firstAt = now;
    if (!this.streakAt || now - this.lastAt > this.gapMs) this.streakAt = now;
    this.lastAt = now;
    return this.state(now);
  }

  /**
   * 启动时用今天已有的记录补一次起点（不补也行，只是当天少一句）。
   *
   * 注意：这里只知道「今天第一条」和「最后一条」，中间可能断过好几次。
   * 所以**不许**把 streakAt 猜成 firstAt——那会说出「从早上 8 点聊到现在」这种 10 小时的假话。
   * 宁可低估：从最后一条算起。
   */
  seed({ firstAt = 0, lastAt = 0 } = {}, now = Date.now(), day = '') {
    this.day = String(day || this._dayOf(now));
    this.firstAt = Number(firstAt) || 0;
    this.lastAt = Number(lastAt) || 0;
    this.streakAt = this.lastAt;
    return this.state(now);
  }

  state(now = Date.now()) {
    return { day: this.day, firstAt: this.firstAt, streakAt: this.streakAt, lastAt: this.lastAt };
  }

  facts(now = Date.now()) {
    return clockFacts({ now, firstTalkAt: this.firstAt, streakStartAt: this.streakAt });
  }

  _dayOf(now) {
    const date = new Date(now);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
}

// ------------------------------------------------------------ 第二层：时段

const minutesOf = (date) => date.getHours() * 60 + date.getMinutes();

/**
 * 一天里的相位表。乘数**只作用于「我主动开口」**，回复不受影响。
 *
 * 14:00–18:00 这里刻意写 1.0：那段由成本节律压（0.3），两边都压就是双重惩罚，
 * 会安静到像掉线。要压也只在一边压。
 */
export const DAY_PHASES = [
  { from: '00:30', to: '08:00', name: '静默', proactiveMul: 0 },
  { from: '08:00', to: '10:00', name: '刚醒', proactiveMul: 0.6 },
  { from: '10:00', to: '12:00', name: '上午', proactiveMul: 1 },
  { from: '12:00', to: '14:00', name: '午间', proactiveMul: 0.7 },
  { from: '14:00', to: '18:00', name: '下午', proactiveMul: 1 },
  { from: '18:00', to: '23:00', name: '晚上', proactiveMul: 1 },
  { from: '23:00', to: '00:30', name: '夜里', proactiveMul: 0.5 },
];

function toMinutes(text) {
  const [hour, minute] = String(text || '').split(':').map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return ((hour % 24) + 24) % 24 * 60 + minute;
}

function inWindow(nowMinutes, from, to) {
  const start = toMinutes(from);
  const end = toMinutes(to);
  if (start === null || end === null) return false;
  if (start === end) return true;
  return start < end ? nowMinutes >= start && nowMinutes < end : nowMinutes >= start || nowMinutes < end;
}

/** 现在处在哪个相位、主动频率乘数是多少。 */
export function dayPhase(now = new Date()) {
  const current = minutesOf(now);
  for (const phase of DAY_PHASES) {
    if (inWindow(current, phase.from, phase.to)) return { ...phase };
  }
  return { from: '', to: '', name: '白天', proactiveMul: 1 };
}

// ------------------------------------------------------------ 第三层：软区

/** 「事务性」的话不算倾诉：查东西、改配置、要授权、发文件。 */
const TRANSACTIONAL_RE = /帮我(改|看|查|弄|写|装|下)|插件|配置|报错|日志|接口|代码|文件|授权|同意|部署|安装|重启|重启一下|token|api|bug|修一下/i;

export function isTransactional(text = '') {
  return TRANSACTIONAL_RE.test(String(text || ''));
}

/**
 * 深夜软区：**四个条件全中**才进，缺一个就按平常。
 *
 * 为什么这么严：到 23 点就自动变软，三天就能被他摸到规律，那就不是「她夜里更软」，
 * 而是「她夜里会演」。软区必须是「事情发生了，她才软」，不是「钟点到了，她该软」。
 */
export function softZone({
  now = new Date(),
  streakMinutes = 0,
  transactional = false,
  hasEmotionToday = false,
  from = '23:00',
  to = '01:00',
  minStreakMinutes = 20,
} = {}) {
  const inWindowNow = inWindow(minutesOf(now), from, to);
  const reasons = [];
  if (!inWindowNow) reasons.push('不在深夜窗口');
  if (transactional) reasons.push('这句是办事的');
  if (!hasEmotionToday) reasons.push('今天没有情绪事件');
  if (Number(streakMinutes) < minStreakMinutes) reasons.push('这一轮太短');
  return {
    active: reasons.length === 0,
    reasons,
    from,
    to,
    minStreakMinutes,
  };
}

/** 软区里多说的那一句事实（只给时间，不给「该 emo 了」）。 */
export function softZoneFacts({ now = Date.now(), streakMinutes = 0 } = {}) {
  const minutes = Math.round(Number(streakMinutes) || 0);
  if (minutes < 20) return '';
  const clock = new Date(now).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
  return `· 现在 ${clock}，这一轮已经聊了 ${humanSpan(minutes * MINUTE)}`;
}
