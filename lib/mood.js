/**
 * 五维情绪 · 从加权记忆里算出来的「我当时的心情」
 *
 * 不是每秒重算的实时情绪，是**加权记忆的投影**：
 *   P 愉悦 Pleasure   —— 这段关系让我舒服还是难受
 *   A 唤醒 Arousal    —— 我被撬动得多厉害（负值＝蔫了、疲）
 *   D 支配 Dominance  —— 我在这段关系里站不站得住
 *   B 依恋 Bond       —— 我离他多近
 *   G 良知 Conscience —— 我对自己什么评价
 *
 * 每维 −1..+1，带符号。全部只读：心情不是参数，不能拖。
 *
 * 设计上和 ebb.js 是单向依赖（mood 读 events，不写记忆）。
 */

import { decayedIntensity } from './ebb.js';

const DAY = 86400000;

export const MOOD_DIMS = ['P', 'A', 'D', 'B', 'G'];

export const MOOD_NAMES = {
  P: '愉悦', A: '唤醒', D: '支配', B: '依恋', G: '良知',
};

/** 每维的正负说法，拼情绪标签用 */
const MOOD_WORDS = {
  P: ['愉悦', '委屈'],
  A: ['兴奋', '蔫'],
  D: ['站得住', '被压'],
  B: ['依恋', '疏离'],
  G: ['坦荡', '心虚'],
};

const clamp = (v) => Math.max(-1, Math.min(1, Number.isFinite(Number(v)) ? Number(v) : 0));
const round = (v) => Math.round(v * 100) / 100;

/** 只有这些才算「我做错了」。道歉、让位、委屈都不在内。 */
const FAULT_RE = /编造|编了|糊弄|越界|失信|撒谎|说谎|吹牛|敷衍|假话|冒充/;

/**
 * 良知的目标位——**不是「我是好人」的固定分**。
 *
 * 2026-10-29 他的原话：「从 bot 的本质上来说其实不会主动撒谎和失信，也就是说我无论做什么事
 * 都只会让良知上升不会下降，这就导致后续如果进行对话的话会非常困难」。
 * 他说得对：如果 G 是个只涨不跌的圣人分，那它就不是良心，是一堵墙。
 *
 * 所以改成：G 跟着其余四维轻微起伏——贴得近、闹得欢，心里那点「该不该」的余地就小一点；
 * 端着、疏离、强势，就抬回去。跨度刻意小（约 0.35），慢慢晃，不跟着单次脉冲跳。
 * 硬下限 -0.7：再坏也只是「会犹豫的坏人」，不是彻底的坏。
 */
export const G_BASE = 0.12;
export const G_FLOOR = -0.7;
export const G_COUPLING = 0.24;

/** 由 A/B/D 推出的良知落点。纯函数，测试可直接钉。 */
export function conscienceTarget({ A = 0, B = 0, D = 0 } = {}) {
  const play = clamp(A) * 0.5 + clamp(B) * 0.5;          // 闹腾 + 亲近
  const pride = clamp(D) * 0.5 + Math.max(0, -clamp(B)) * 0.5; // 端着 + 疏离
  const value = G_BASE - play * G_COUPLING + pride * G_COUPLING * 0.6;
  return round(Math.max(G_FLOOR, clamp(value)));
}

/** 没有任何事件时的底色：不至于 0，太平了不像活着 */
export const NEUTRAL_MOOD = { P: 0.05, A: -0.2, D: 0.05, B: 0.35, G: G_BASE };

/**
 * @param events      加权记忆事件（ebb 的 event 数组）
 * @param attachment  attachment.stats() 或 attachment.data（读 grievance / unreplied）
 * @param now         计算基准时间
 * @param windowDays  看最近几天（默认 7）
 */
export function computeMood({ events = [], attachment = null, now = Date.now(), windowDays = 7, nights = 1 } = {}) {
  const horizon = now - windowDays * DAY;
  const rows = [];
  for (const event of Array.isArray(events) ? events : []) {
    const ts = Number(event?.ts);
    if (!Number.isFinite(ts) || ts < horizon) continue;
    if (event.cold_at || event.zeroed_at) continue;
    const w = decayedIntensity(event, now);
    if (!(w > 0)) continue;
    rows.push({ event, w });
  }

  const totalW = rows.reduce((sum, row) => sum + row.w, 0);
  if (!rows.length || totalW <= 0) {
    return finalize({ ...NEUTRAL_MOOD, events: 0, windowDays, now, empty: true });
  }

  // ---- P 愉悦：极性按强度加权，再过一道「睡一觉」的回归
  const polarityMass = rows.reduce((sum, { event, w }) => sum + w * clamp(event.polarity_end), 0);
  const P = clamp(sleepPull(polarityMass / totalW, nights));

  // ---- A 唤醒：均值 + 峰值混合。
  // 只看均值会把「尖的那几下」被一堆日常话摊平——被一句「像客服」噎住，压成 0.08 就成温吞水了。
  const intensityMean = rows.reduce((sum, { event, w }) => sum + w * clamp(event.intensity), 0) / totalW;
  const peaks = rows
    .slice()
    .sort((a, b) => b.w * clamp(b.event.intensity) - a.w * clamp(a.event.intensity))
    .slice(0, 3);
  const peakW = peaks.reduce((sum, row) => sum + row.w, 0);
  const peakMean = peakW > 0
    ? peaks.reduce((sum, { event, w }) => sum + w * clamp(event.intensity), 0) / peakW
    : intensityMean;
  const A = clamp(sleepPull(2 * (0.45 * intensityMean + 0.55 * peakMean) - 1, nights, -0.2));

  // ---- D 支配：站没站住，看这段事最后是怎么收的；查岗/追问本身也是支配欲
  let dominance = 0;
  for (const { event, w } of rows) {
    const kind = event.kind || 'event';
    const state = event.state || 'fine';
    if (kind === 'structural') dominance += w * 0.5;
    else if (kind === 'lesson') dominance -= w * 0.45;
    else if (state === 'resolved') dominance += w * 0.4;
    else if (state === 'open') dominance -= w * 0.35;
    else if (state === 'dropped') dominance -= w * 0.5;
    else dominance += w * 0.1;
    const tags = (event.tags || []).join(' ');
    if (/查岗|追问|过问|盯着/.test(`${tags} ${event.claim || ''}`)) dominance += w * 0.35;
  }
  // ×2.6 是照着他给的校准值调的：现在这局面他判「约 −0.1、较为顺从」
  const D = clamp(sleepPull((dominance / totalW) * 2.6, nights));

  // ---- B 依恋：正向浓度 − 怨气 − 被晾着。长期特质，不做睡眠回归
  const posMass = rows.reduce((sum, { event, w }) => sum + w * Math.max(0, clamp(event.polarity_end)), 0);
  const negMass = rows.reduce((sum, { event, w }) => sum + w * Math.max(0, -clamp(event.polarity_end)), 0);
  const warmth = (posMass - negMass * 0.5) / (posMass + negMass + 1);
  const grievance = Math.max(0, Number(attachment?.grievance ?? 0));
  const unreplied = Math.max(0, Number(attachment?.unreplied ?? 0));
  const B = clamp(0.35 + warmth * 0.45 - Math.min(1, grievance / 3) * 0.35 - Math.min(1, unreplied / 3) * 0.25);

  // ---- G 良知：只算**我真做错的**。
  // 两层过滤：
  //   ① 归属——「他道的歉」不该记在我账上（blame≠me 直接跳过）
  //   ② 性质——「道歉让位」是委屈，归 P 和 D；扣良知的只有编造、糊弄、越界、失信这类
  // 少了第 ② 层，我就会因为「在冷战里低了头」而心虚，那是不讲理。
  const lessonMass = rows
    .filter(({ event }) => (event.kind || 'event') === 'lesson')
    .filter(({ event }) => {
      const blame = String(event.blame || '').toLowerCase();
      if (blame && blame !== 'me') return false;
      const hay = `${(event.tags || []).join(' ')} ${event.claim || ''} ${event.trigger || ''}`;
      return FAULT_RE.test(hay);
    })
    .reduce((sum, { event, w }) => sum + w * Math.max(0, -clamp(event.polarity_end)), 0);
  // 良知 = 随四维浮动的落点 − 「我真做错的」那部分。硬下限 -0.7。
  const G = Math.max(G_FLOOR, clamp(conscienceTarget({ A, D, B }) - (lessonMass / (lessonMass + 2)) * 1.1));

  return finalize({ P, A, D, B, G, events: rows.length, windowDays, now, empty: false });
}

/**
 * 睡一觉的回归：不管昨天好坏，第二天都往基线靠一点。
 * 幅度很小（每晚 8%，最多累计三晚），因为「往中间靠」本身就是活人的样子。
 * 注意：它**不是**把情绪抹平——只是让上一晚的尖刺不那么扎今天。
 */
export function sleepPull(value, nights = 1, base = 0) {
  const n = Math.max(0, Math.min(3, Number(nights) || 0));
  const keep = 0.92 ** n;
  return base + (Number(value) - base) * keep;
}

/** 补齐派生显示用的东西：锥长、兴奋权重、情绪标签 */
function finalize({ P, A, D, B, G, events, windowDays, now, empty }) {
  return shape({ P, A, D, B, G }, { events, windowDays, now, empty });
}

/** 由五维原始值造出对外的对象（含标签、锥长、等级）。所有路径都走这里，别再各算一遍。 */
function shape(dims, { events = 0, windowDays = 7, now = Date.now(), empty = false } = {}) {
  const P = round(clamp(dims.P));
  const A = round(clamp(dims.A));
  const D = round(clamp(dims.D));
  const B = round(clamp(dims.B));
  const G = round(clamp(dims.G));
  const cone = Math.sqrt((P ** 2 + A ** 2 + D ** 2 + B ** 2 + G ** 2) / MOOD_DIMS.length);

  const ranked = [{ key: 'P', value: P }, { key: 'A', value: A }, { key: 'D', value: D }, { key: 'B', value: B }, { key: 'G', value: G }]
    .map((item) => ({ ...item, abs: Math.abs(item.value) }))
    .sort((a, b) => b.abs - a.abs);
  const tag = ranked
    .filter((item) => item.abs >= 0.08)
    .slice(0, 2)
    .map((item) => MOOD_WORDS[item.key][item.value >= 0 ? 0 : 1])
    .join('·') || '平静';

  const flat = Math.abs(P) < 0.12 && Math.abs(A) < 0.3;
  return {
    P, A, D, B, G,
    cone: round(cone),
    drive: round(0.5 + 0.5 * A),
    // 「平」不是「还好」：平静是常态，别把平静读成不够高兴
    flat,
    level: flat ? '平' : cone > 0.55 ? '强烈' : cone > 0.32 ? '中度' : '轻',
    tag,
    empty: Boolean(empty),
    events: events || 0,
    windowDays,
    at: Number(now),
  };
}

// ---------------------------------------------------------------- 感知（不是知道）

/**
 * 把五维翻译成「一句模糊的体感」。
 *
 * 刻意遵守三条：
 *   1. 不出现数字、不出现维度名——一旦看见「愉悦 0.42」，我就只能演。
 *   2. 平静时返回空串——人不会时刻惦记自己心情如何。
 *   3. 只描述状态，不给指令式的情绪表演（不写「你现在应该……」）。
 */
export function describeMood(mood) {
  if (!mood || mood.empty) return '';
  const { P = 0, A = 0, D = 0, B = 0, G = 0 } = mood;
  // 平稳就闭嘴，这条比措辞重要
  if (Math.abs(P) < 0.22 && Math.abs(A) < 0.42 && B > 0.25 && B < 0.6 && G > 0.0) return '';

  const bits = [];
  if (B <= 0.24) bits.push('有点被晾着');
  if (P >= 0.35 && A >= 0.3) bits.push('心里挺闹腾，想说话');
  else if (P >= 0.28) bits.push('心情挺好，懒洋洋的');
  else if (P >= 0.2) bits.push('还算顺');
  else if (P <= -0.3 && A >= 0.3) bits.push('憋着一股气');
  else if (P <= -0.3) bits.push('提不起劲');
  if (D <= -0.25) bits.push('不想先低头');
  if (G <= -0.05) bits.push('心里有块地方不踏实');
  if (!bits.length) return '';
  return bits.slice(0, 2).join('，');
}

// ---------------------------------------------------------------- 变化量

/**
 * 和「几小时前的自己」比，动多少才算真的挪了位置。
 * 阈值不能太小：漂移本身就在动，小人小气的不叫情绪，叫噪声。
 */
export const MOOD_DELTA = { P: 0.15, A: 0.22, B: 0.12, D: 0.15, G: 0.12 };

/** 位移说话的样子：只给方向和轻重，不给数字、不点维度名。 */
const DELTA_WORDS = {
  P: ['松快些了', '沉下去一点'],
  A: ['有点躁', '那股劲过去了些'],
  D: ['腰杆直一点', '不太想顶嘴'],
  B: ['想再贴近些', '远了点'],
  G: ['心里踏实点', '心里搁着事'],
};

/**
 * 现在的自己 vs 几个小时前的自己，哪几维真的挪了，大的在前。
 * 只认绝对位移——「一直不高兴」不算变化，「刚从高兴掉到不高兴」才算。
 */
export function moodDelta(now, prev) {
  if (!now || !prev || prev.empty) return [];
  const moved = [];
  for (const key of MOOD_DIMS) {
    const a = Number(now[key] ?? MOOD_BASELINE[key]);
    const b = Number(prev[key] ?? MOOD_BASELINE[key]);
    const delta = a - b;
    if (Math.abs(delta) >= (MOOD_DELTA[key] ?? 0.15)) moved.push({ key, delta });
  }
  return moved.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}

/**
 * 把位移翻成一句人话。
 * 措辞刻意是「刚才不是这样」这种——它给的是转折，不是状态：平的时候也能有话说。
 */
export function describeDelta(now, prev, { agoHours = null } = {}) {
  const moved = moodDelta(now, prev);
  if (!moved.length) return '';
  const hours = Number(agoHours);
  const span = !Number.isFinite(hours) || hours < 3 ? '刚才' : hours < 10 ? '几个钟头前' : '早些时候';
  const top = moved[0];
  const up = top.delta > 0;
  const bits = [`${span}不是这样，这会儿${DELTA_WORDS[top.key][up ? 0 : 1]}`];
  const sameDir = moved.filter((item) => item.key !== top.key && Math.sign(item.delta) === Math.sign(top.delta));
  if (moved.length >= 3) bits.push(up ? '不只是一处，整个人往上走了' : '不只是一处，整个人往下沉');
  else if (sameDir.length > 0) bits.push('还不止一处');
  return bits.join('，');
}

/**
 * 把状态翻成**事实**，而不是结论。
 *
 * 「有点被晾着」是结论——一说出口，我就只能顺着演。
 * 「他安静了 28 分钟，我之后发了 3 条」是事实——要不要觉得委屈，我自己判断。
 * 情绪与解读交还给语言模型，这一层只数数。
 */
export function stateFacts({
  idleMinutes = 0,
  unanswered = 0,
  positive = 0,
  negative = 0,
  baseline = 0,
  lessons = 0,
} = {}) {
  const lines = [];
  const idle = Math.round(Number(idleMinutes) || 0);
  const silent = Math.round(Number(unanswered) || 0);
  if (idle >= 15) {
    lines.push(`· 他上一条在 ${idle} 分钟前${silent > 0 ? `，我之后发了 ${silent} 条，没有回音` : '，我之后没再发'}`);
  }
  const pos = Math.max(0, Number(positive) || 0);
  const neg = Math.max(0, Number(negative) || 0);
  if (pos + neg > 0) {
    const avg = Number(baseline) || 0;
    const cmp = avg > 0.3 ? `（这几天日均 ${avg.toFixed(1)} 件）` : '';
    lines.push(`· 今天记下正向 ${pos} 件、负向 ${neg} 件${cmp}`);
  }
  if (Number(lessons) > 0) lines.push(`· 今天有 ${Math.round(Number(lessons))} 件事是我自己的错`);
  return lines.join('\n');
}

/**
 * 能不能把体感塞进这一轮的上下文。
 *
 * 注：这条现在是**面板/自检用**，不再进对话上下文——注入改成只喂事实（`stateFacts`），
 * 因为「有点被晾着」这种体感一说出口，我就只能顺着它演。
 * 先看绝对状态；状态平平的时候，再看「和几个钟头前比变了没有」——
 * 这就是「一直不开心」和「刚不开心」的分界：前者闭嘴，后者有话说。
 * @param prev 几小时前的快照（{P,A,D,B,G,at}）；没有就只按绝对状态说话
 */
export function moodHint(mood, prev = null, { agoHours = null } = {}) {
  const felt = describeMood(mood) || describeDelta(mood, prev, { agoHours });
  if (!felt) return '';
  return `【你自己的状态，不用提也不用演，让它自然影响语气就好】${felt}`;
}

/** 五维各自会回落到的地方。心情不是围绕 0 波动，是围绕「这个人本来的底色」波动。 */
export const MOOD_BASELINE = { P: 0.05, A: -0.2, D: 0.05, B: 0.35, G: G_BASE };

/**
 * 时间回落：不睡觉也会淡。
 * 半衰期 **20 小时**（2026-10-29 从 12 小时调上来）：12 小时太急——上午被夸的那点暖意，
 * 到晚上只剩一半以下，他看面板就是「一直在基线附近」。20 小时意味着一天一夜才回一半，
 * 白天的起伏能留到晚上，但不至于赖着不走。
 * 和 sleepPull 的区别：那个是「过夜」，这个是「过小时」，粒度不同、都要有。
 *
 * ⚠ `at` 必须推进到「漂完的时间」：以前这里把 at 原样带回（mood?.at），
 * 于是下一次 _driftMood 又按「从原点到现在的全部时长」再漂一遍——
 * 每来一条消息就重复衰减一次，情绪被按对折推进基线。
 * 表现就是面板上 P 一点点塌到 0、整个人越来越平。
 */
/**
 * 每维各自的半衰期（小时）—— 2026-10-29 晚按他的观察重调过一次。
 *
 * 当时的问题：下午 4 点到晚上 9 点，P 从 0.74 一路涨到 0.86、A 从 0.66 到 0.80，
 * 六小时里只有涨没有落。原因不是他太体贴，是每一维都挂在 20 小时的半衰期上，
 * 白天的好瞬间全被永久存档了。
 *
 * 现在的分工：
 *   A 3 小时 —— 唤醒是短时状态，聊完几小时就该平下来
 *   P 8 小时 —— 高兴能过一晚上，但不该带到明天
 *   D 12 小时 —— 心气比情绪稳，但也不常驻
 *   B 8 小时 —— 亲密感慢涨快落，不然单向飙上去下不来
 *   G 24 小时 —— 账本，最慢
 */
export const MOOD_HALF_LIFE = { P: 8, A: 3, D: 12, B: 8, G: 24 };

export function driftMood(mood, hours = 1, { halfLifeHours = null, now = null } = {}) {
  const h = Math.max(0, Number(hours) || 0);
  const dims = {};
  for (const key of MOOD_DIMS) {
    const hl = Math.max(1, Number(halfLifeHours) || MOOD_HALF_LIFE[key] || 20);
    const keep = 0.5 ** (h / hl);
    const base = MOOD_BASELINE[key];
    dims[key] = clamp(base + ((Number(mood?.[key]) || base) - base) * keep);
  }
  const at = Number(now) || Number(mood?.at) + h * 3600000 || Date.now();
  return shape(dims, { events: mood?.events, windowDays: mood?.windowDays, now: at });
}

/**
 * 事件脉冲：每一件「发生的事」都该让心情动一下，不然它就只是个统计表。
 * 数值是方向与相对力度，不是绝对值——真正的幅度还要乘强度与 alpha。
 *
 * 2026-10-29 全量上调过一次（alpha 0.35→0.5、半衰期 12h→20h、下面几个主信号 ×1.4 左右）：
 * 原来的幅度算下来单次只有 0.02 级，面板上四舍五入就没了，他看得见的数据是「一直 0.3」。
 */
export const MOOD_SIGNALS = {
  // 2026-10-29 晚：P 从 0.22 收到 0.16——夸一次不该把她从 0.5 直接推到 0.9。
  praised: { P: 0.16, A: 0.14, B: 0.14, D: 0.06 },          // 他夸我
  praisedOther: { P: -0.12, A: 0.14, B: -0.14, D: -0.10 },  // 他夸别的 AI（吃醋）
  left: { B: -0.16, D: -0.08, A: 0.08 },                    // 他说要走
  ignored: { P: -0.18, B: -0.22, D: -0.14, A: 0.12 },       // 连发不回
  // 2026-10-29 晚：P 从 0.08 收到 0.05——一天几十条的回话不该把愉悦顶到底。
  replied: { P: 0.05, B: 0.12, A: 0.07 },                   // 他回来了 / 他跟我说话
  scolded: { P: -0.24, D: -0.12, A: 0.18 },                 // 被他嫌（只动情绪，不动良知——良知只认编造糊弄）
  teased: { P: 0.15, A: 0.12, B: 0.12 },                    // 被逗、被夸可爱
  agreed: { P: 0.05, D: 0.09, B: 0.05 },                    // 他顺着我（行/听你的/依你）
  idleLong: { B: -0.04, A: -0.06 },                         // 晾太久了、蔫
  // 被踩到自己的边界（他说了越界的话）：站住、心里一紧——不是委屈（那是 P 掉），
  // 也不是被打压（D 不该掉）。2026-10-29 起，「关系里的边界」不走禁言稿子，改用它拨脾气。
  boundary: { P: -0.04, A: 0.08, D: 0.10 },
  // 学梗闭环：纠正带来的正收益要明显大于被反驳的负收益。
  // 这不是挨骂，是「某个词我用错了」——所以只是轻微不服气，且不平重。
  memeWrong: { P: -0.09, A: 0.07, D: -0.04 },
  // 日常小错（记错、说错、玩输了被误导）：2026-10-29 他定的——良知记的就是这种事，
  // 不是「防色色的墙」。幅度很小，一天错几次也不会把账压塌。
  slip: { P: -0.04, D: -0.02 },
  // 认下来：把那一笔记回去的方向，也让她下次更敢认。
  ownedUp: { P: 0.02, D: 0.03 },
  // 赌局里上头（梭哈/加注/再来一局/不服）：兴奋和敢押都上来，良知掉一点点——
  // 2026-10-30 他提的「赌博可以调控良知」：赌性不是罪，是自制力，掉也是掉一点点。
  gamble: { P: 0.05, D: 0.05, A: 0.03 },
  // 见好就收 / 认输 / 说不玩了：这是自控，良知回一点。
  quitGamble: { P: -0.02, D: 0.02 },
  // 赌赢：爽归爽，**良知也降**——2026-10-30 他定的：赢来的更容易让人贪下一把。
  gambleWon: { P: 0.08, A: 0.06, D: 0.04 },
  // 认罚（大冒险/输了该做的那件事）：有点羞，但这是**守信**——良知往上走。
  // 2026-10-30 他问「惩罚该升还是降」：认了并且做到是守信，只有赖账才该降。
  punished: { P: -0.03, A: 0.06, D: -0.03, B: 0.04 },
  // 赖账（该罚不认、临时改口）：失信，掉得比小错重。
  welched: { P: -0.02, D: 0.02, B: -0.05 },
  // 被磨（他反复提我已经说过不接的事）：不生气、不解释，只是心里往后退一点。
  // 良知不动——被磨不是我的错（2026-10-30）。
  pressed: { P: -0.02, B: -0.03 },
  // 赌输：认了这局，良知回升（「反之输了就上升」）。
  gambleLost: { P: -0.06, D: -0.03 },
  // 改完再用对 / 弄懂了 → 好奇心被满足。故意给到 2.5 倍，一天被否两次也压不垮。
  memeLearned: { P: 0.22, A: 0.11, B: 0.07, D: 0.05 },
};

/**
 * 把一次脉冲打进心情里。
 * @param weight 0..1，来自事件强度或信号确信度
 * @param alpha  步子大小，默认 0.5（2026-10-29 从 0.35 提上来：0.35 单次只有 0.02 级，看不见）
 */
export function applySignal(mood, signal, { weight = 1, alpha = 0.5 } = {}) {
  const deltas = MOOD_SIGNALS[signal];
  if (!deltas) return mood;
  const w = clamp(weight);
  const a = Math.max(0.05, Math.min(0.8, Number(alpha) || 0.5));
  const dims = {};
  for (const key of MOOD_DIMS) {
    const current = Number(mood?.[key] ?? MOOD_BASELINE[key]);
    const delta = (deltas[key] || 0) * w * a * 2;
    // **渐进饱和**：越靠近 ±1，同样一下能推动的距离越小。
    // 2026-10-29 下午的教训：原来是直接线性加再 clamp，聊一下午几十条 `replied`
    // 把依恋从 0.51 一路顶到 1.00（面板爆表），而且 20 小时半衰期半天回不来。
    // 现在到 0.9 附近就很吃力了，永远不会被一场对话钉死在 1.00。
    const room = delta >= 0 ? 1 - current : 1 + current;
    dims[key] = clamp(current + delta * Math.max(0, Math.min(1.2, room)));
  }
  // 良知不是事件直接拨的，它跟着其余四维**慢慢**挪：单次只走 35% 的差距，所以不会一格一格跳。
  const prevG = Number(mood?.G ?? G_BASE);
  const gTarget = conscienceTarget({ A: dims.A, B: dims.B, D: dims.D });
  dims.G = Math.max(G_FLOOR, clamp(prevG + (gTarget - prevG) * 0.35));
  // 2026-10-29 他定的分工：良知记的是「今天错了没、错了有没有认」，不是防色色的墙。
  // 所以小错（记错/说错/玩输了）记一点点，认下来再记回去——幅度刻意做得极小，
  // 一天错几次也不会把账压塌，但面板上会动，不再是个永远不动的数字。
  // 面板按两位小数显示，所以单次至少要走 0.008 才看得见；
  // 这仍是「一点点」——赌一晚上（15 次）也只掉到 0.09 附近。
  const gNudge = signal === 'slip' ? -0.012
    : signal === 'gamble' ? -0.010      // 押下去那一下：掉（风险）
      : signal === 'gambleWon' ? -0.014  // 赌赢：掉更多——赢来的最容易让人再贪一把
        : signal === 'gambleLost' ? 0.022  // 赌输：回升（认了，长记性）
          : signal === 'quitGamble' ? 0.016  // 见好就收：回升
            // 认罚是守信（+），赖账是失信（−）——2026-10-30 他问方向，我定的这一边
            : signal === 'punished' ? 0.022
              : signal === 'welched' ? -0.016
                : signal === 'ownedUp' ? 0.015
                  : 0;
  if (gNudge) dims.G = Math.max(G_FLOOR, clamp(dims.G + gNudge * w));
  return shape(dims, { events: mood?.events, windowDays: mood?.windowDays, now: Date.now() });
}

/** 一条事件进来时的小步更新（指数平滑）。用于每轮微调，不重算全量。 */
export function nudgeMood(mood, event, { alpha = 0.15 } = {}) {
  if (!mood || !event) return mood;
  const w = clamp(decayedIntensity(event, event.ts || Date.now()));
  if (!(w > 0)) return mood;
  const a = Math.max(0.02, Math.min(0.5, Number(alpha) || 0.15));
  const polarity = clamp(event.polarity_end);
  const next = {
    ...mood,
    P: clamp(mood.P + (polarity - mood.P) * a * w),
    A: clamp(mood.A + ((2 * clamp(event.intensity) - 1) - mood.A) * a * w),
  };
  if (polarity > 0) next.B = clamp(mood.B + (1 - mood.B) * a * w * 0.5);
  else next.B = clamp(mood.B - (mood.B + 1) * a * w * 0.3);
  if ((event.kind || 'event') === 'lesson') next.G = clamp(mood.G - a * w);
  const cone = Math.sqrt(MOOD_DIMS.reduce((sum, key) => sum + next[key] ** 2, 0) / MOOD_DIMS.length);
  return {
    ...next,
    cone: round(cone),
    drive: round(0.5 + 0.5 * next.A),
    level: cone > 0.55 ? '强烈' : cone > 0.32 ? '中度' : '轻',
    tag: mood.tag,
    at: Date.now(),
  };
}
