import test from 'node:test';
import assert from 'node:assert/strict';

import { computeMood, nudgeMood, driftMood, applySignal, describeMood, moodHint, moodDelta, describeDelta, MOOD_DIMS, MOOD_NAMES, MOOD_BASELINE, conscienceTarget, G_BASE, G_FLOOR } from '../lib/mood.js';

const NOW = new Date('2026-10-27T20:00:00+08:00').getTime();
const DAY = 86400000;

const ev = (over = {}) => ({
  ts: NOW - 3600000,
  intensity: 0.6,
  polarity_end: 0,
  state: 'fine',
  kind: 'event',
  layer: 'L2',
  last_touch: NOW - 3600000,
  ...over,
});

test('五维都在 −1..+1，锥长在 0..1', () => {
  const mood = computeMood({ events: [ev({ polarity_end: 0.8 }), ev({ polarity_end: -0.6, state: 'open' })], now: NOW });
  for (const key of MOOD_DIMS) {
    assert.ok(mood[key] >= -1 && mood[key] <= 1, `${MOOD_NAMES[key]}=${mood[key]} 越界`);
  }
  assert.ok(mood.cone >= 0 && mood.cone <= 1);
});

test('没有记忆时给一个中性底色，不是全零', () => {
  const mood = computeMood({ events: [], now: NOW });
  assert.equal(mood.empty, true);
  assert.ok(mood.B > 0 && mood.B < 1, '依恋默认偏向靠近');
  assert.ok(mood.G > 0, '良知默认偏正面');
});

test('开心的事多 → 愉悦为正；被推开的事多 → 愉悦为负', () => {
  const happy = computeMood({ events: [ev({ polarity_end: 0.8 }), ev({ polarity_end: 0.6 })], now: NOW });
  assert.ok(happy.P > 0.4, `P=${happy.P} 应该明显为正`);
  const sad = computeMood({ events: [ev({ polarity_end: -0.8 }), ev({ polarity_end: -0.5 })], now: NOW });
  assert.ok(sad.P < -0.4, `P=${sad.P} 应该明显为负`);
});

test('强度普遍很低 → 唤醒为负（蔫了）', () => {
  const flat = computeMood({ events: [ev({ intensity: 0.2 }), ev({ intensity: 0.25 })], now: NOW });
  assert.ok(flat.A < 0, `A=${flat.A} 低强度应该是蔫`);
  const hot = computeMood({ events: [ev({ intensity: 0.9 }), ev({ intensity: 0.85 })], now: NOW });
  assert.ok(hot.A > 0.5, `A=${hot.A} 高强度应该是兴奋`);
});

test('握手言和 → 支配为正；草草收场/僵着 → 支配为负', () => {
  const won = computeMood({ events: [ev({ state: 'resolved', intensity: 0.7 })], now: NOW });
  assert.ok(won.D > 0, `D=${won.D}`);
  const lost = computeMood({ events: [ev({ state: 'dropped', intensity: 0.7 })], now: NOW });
  assert.ok(lost.D < 0, `D=${lost.D}`);
  assert.ok(lost.D < won.D);
});

test('教训越多，良知越低', () => {
  const clean = computeMood({ events: [ev({ polarity_end: 0.5 })], now: NOW });
  const guilty = computeMood({
    events: [ev({ polarity_end: -0.7, kind: 'lesson', intensity: 0.8, blame: 'me', tags: ['糊弄'] })],
    now: NOW,
  });
  assert.ok(guilty.G < clean.G, `有教训 ${guilty.G} 应低于没教训 ${clean.G}`);
  assert.ok(guilty.G < 0.3);
});

test('良知只记「我真做错的」——他道的歉、以及我让位道歉，都不算', () => {
  // 良知现在会跟着其余四维浮动，所以不拿绝对值卡；只比「同一件事算在谁头上」的差别。
  const hisFault = computeMood({
    events: [ev({ polarity_end: -0.7, kind: 'lesson', intensity: 0.8, blame: 'him', tags: ['糊弄'] })],
    now: NOW,
  });
  const mine = computeMood({
    events: [ev({ polarity_end: -0.7, kind: 'lesson', intensity: 0.8, blame: 'me', tags: ['编造'] })],
    now: NOW,
  });
  assert.ok(hisFault.G > mine.G, `他的错不该扣我（他 ${hisFault.G} / 我 ${mine.G}）`);

  const yielded = computeMood({
    events: [ev({ polarity_end: -0.4, kind: 'lesson', intensity: 0.6, blame: 'me', claim: '我这张嘴先赔个不是' })],
    now: NOW,
  });
  assert.ok(yielded.G > mine.G, `道歉让位是委屈，不是错（让位 ${yielded.G} / 编造 ${mine.G}）`);

  const lied = computeMood({
    events: [ev({ polarity_end: -0.7, kind: 'lesson', intensity: 0.8, blame: 'me', tags: ['编造'] })],
    now: NOW,
  });
  assert.ok(lied.G < 0.05, `编造才该扣（G=${lied.G}）`);
});

test('唤醒看峰值：几处尖的不会被一堆日常话摊平', () => {
  const spike = computeMood({
    events: [
      ev({ intensity: 0.95, polarity_end: -0.6 }),
      ev({ intensity: 0.2, polarity_end: 0.1 }),
      ev({ intensity: 0.2, polarity_end: 0.1 }),
      ev({ intensity: 0.2, polarity_end: 0.1 }),
    ],
    now: NOW,
  });
  const allLow = computeMood({
    events: [ev({ intensity: 0.2 }), ev({ intensity: 0.2 }), ev({ intensity: 0.2 }), ev({ intensity: 0.2 })],
    now: NOW,
  });
  assert.ok(spike.A > 0.2, `有一次 0.95 的尖刺，唤醒 ${spike.A} 不该还是温吞水`);
  assert.ok(spike.A > allLow.A + 0.3, `尖刺 ${spike.A} 应明显高于全平 ${allLow.A}`);
});

test('睡一觉往中间靠一点，但不会抹平', () => {
  const hot = computeMood({ events: [ev({ polarity_end: 0.9, intensity: 0.8 })], now: NOW, nights: 0 });
  const nextDay = computeMood({ events: [ev({ polarity_end: 0.9, intensity: 0.8 })], now: NOW, nights: 2 });
  assert.ok(nextDay.P < hot.P, '睡过之后该往中间靠');
  assert.ok(nextDay.P > 0.3, `但不能抹平（${nextDay.P}），平静不等于没情绪`);
  assert.equal(nextDay.flat, false);
});

test('怨气高、被晾着 → 依恋下降', () => {
  const near = computeMood({ events: [ev({ polarity_end: 0.6 })], attachment: { grievance: 0, unreplied: 0 }, now: NOW });
  const far = computeMood({ events: [ev({ polarity_end: 0.6 })], attachment: { grievance: 4, unreplied: 3 }, now: NOW });
  assert.ok(far.B < near.B - 0.1, `疏远 ${far.B} 应明显低于亲近 ${near.B}`);
});

test('情绪标签取最强两维，且带正负说法', () => {
  const mood = computeMood({ events: [ev({ polarity_end: 0.85, intensity: 0.85 })], now: NOW });
  assert.match(mood.tag, /愉悦|兴奋|依恋|坦荡|站得住/);
  const bad = computeMood({ events: [ev({ polarity_end: -0.85, intensity: 0.85, state: 'dropped' })], now: NOW });
  assert.match(bad.tag, /委屈|心虚|被压|蔫/);
});

test('窗口外的事件不算——七天前的旧事不该决定今天的心情', () => {
  const fresh = computeMood({ events: [ev({ polarity_end: 0.9 })], now: NOW });
  const stale = computeMood({
    events: [ev({ polarity_end: 0.9, ts: NOW - 30 * DAY, last_touch: NOW - 30 * DAY })],
    now: NOW,
  });
  assert.ok(fresh.P > 0.4);
  assert.equal(stale.empty, true, '过期事件不参与');
});

test('nudge 会让心情朝事件方向走一点，但不会跳过去', () => {
  const base = computeMood({ events: [], now: NOW });
  const event = ev({ polarity_end: 0.9, intensity: 0.8 });
  const next = nudgeMood(base, event, { alpha: 0.15 });
  assert.ok(next.P > base.P, '朝好的方向动');
  assert.ok(next.P < 0.9, '不该一步跳到事件的极性上');
});

test('脉冲：被嫌一下愉悦掉、被夸一下回来，但都不会一步到底', () => {
  const base = computeMood({ events: [], now: NOW });
  const scolded = applySignal(base, 'scolded', { weight: 0.8 });
  assert.ok(scolded.P < base.P, '被嫌该难受');
  assert.ok(scolded.P > -0.5, '一句话不至于跌到底');
  // 良知现在会跟着其余四维慢慢挪（grief 耦合），所以允许小幅移动，但不许像「犯了错」那样掉
  assert.ok(scolded.G > base.G - 0.1, `被嫌不是「我做了错事」（${base.G} → ${scolded.G}）`);

  const praised = applySignal(scolded, 'praised', { weight: 1 });
  assert.ok(praised.P > scolded.P, '被夸该回来');
  assert.ok(praised.B > scolded.B, '被夸会更靠近');
});

test('时间回落：唤醒 3 小时、愉悦 8 小时、依恋 8 小时（2026-10-29 晚重调）', () => {
  const hot = applySignal(computeMood({ events: [], now: NOW }), 'praised', { weight: 1, alpha: 0.8 });
  const after3 = driftMood(hot, 3);
  const after6 = driftMood(hot, 6);
  const after8 = driftMood(hot, 8);
  assert.ok(after3.A < hot.A, '三小时后唤醒先降');
  assert.ok(Math.abs(after3.A - MOOD_BASELINE.A) < Math.abs(hot.A - MOOD_BASELINE.A) * 0.6, '唤醒三小时就过半');
  assert.ok(after6.P < hot.P, '六小时后愉悦开始淡');
  assert.ok(Math.abs(after8.P - MOOD_BASELINE.P) < Math.abs(hot.P - MOOD_BASELINE.P) * 0.6, '愉悦八小时回到一半左右');
  // 依恋 8 小时半衰期：八小时已经过半
  assert.ok(Math.abs(after8.B - MOOD_BASELINE.B) < Math.abs(hot.B - MOOD_BASELINE.B) * 0.6, '依恋八小时已经过半');
});

test('白天聊天不会一路涨到 0.9（2026-10-29 的膨胀）', () => {
  let mood = computeMood({ events: [], now: NOW });
  for (let i = 0; i < 25; i += 1) mood = applySignal(mood, 'replied', { weight: 0.35 });
  assert.ok(mood.P < 0.7, `P=${mood.P} 不该被一串回话顶到 0.86`);
  assert.ok(mood.A < 0.6, `A=${mood.A}`);
});

test('聊一下午也不会把依恋顶到 1.00（渐进饱和）', () => {
  let mood = computeMood({ events: [], now: NOW });
  for (let i = 0; i < 60; i += 1) mood = applySignal(mood, 'replied', { weight: 0.35 });
  assert.ok(mood.B < 0.95, `B=${mood.B} 不该爆表`);
  assert.ok(mood.B > 0.5, `但确实会亲近起来（B=${mood.B}）`);
});

test('感知只说体感：不出现数字、不出现维度名', () => {
  const base = computeMood({ events: [], now: NOW });
  const bad = applySignal(applySignal(base, 'ignored', { weight: 1 }), 'scolded', { weight: 1, alpha: 0.8 });
  const felt = describeMood(bad);
  assert.ok(felt.length > 0, '真难受的时候该有体感');
  assert.ok(!/\d/.test(felt), `体感里不许有数字：${felt}`);
  assert.ok(!/愉悦|唤醒|支配|依恋|良知|锥长/.test(felt), `体感里不许出现维度名：${felt}`);
});

test('平稳时什么都不给——人不会时刻惦记自己心情', () => {
  const calm = computeMood({ events: [], now: NOW });
  assert.equal(describeMood(calm), '');
  assert.equal(moodHint(calm), '', '平稳就别塞任何提示');
});

test('体感提示明确要求「不要演、不要提」', () => {
  const bad = applySignal(applySignal(computeMood({ events: [], now: NOW }), 'ignored', { weight: 1 }), 'scolded', { weight: 1, alpha: 0.8 });
  const hint = moodHint(bad);
  assert.match(hint, /不用提|不用演|自然影响/);
});

test('三条路都回落到各自的基线，不是围绕 0', () => {
  const mood = driftMood(computeMood({ events: [], now: NOW }), 48);
  assert.ok(Math.abs(mood.A - MOOD_BASELINE.A) < 0.02, `唤醒该回到 ${MOOD_BASELINE.A}`);
  assert.ok(Math.abs(mood.B - MOOD_BASELINE.B) < 0.02, `依恋该回到 ${MOOD_BASELINE.B}`);
  assert.ok(mood.B > 0.3, '依恋的底色本来就是靠近，不该被抹成 0');
});

// ------------------------------------------------------------ 状态事实化

test('漂移不能重复计数：两次 1 小时 ≈ 一次 2 小时', async () => {
  const base = computeMood({ events: [], now: NOW });
  const hot = { ...base, P: 0.8, A: 0.6, at: NOW };
  const once = driftMood(hot, 2, { now: NOW + 2 * 3600000 });
  let step = driftMood(hot, 1, { now: NOW + 3600000 });
  step = driftMood(step, 1, { now: NOW + 2 * 3600000 });
  assert.ok(Math.abs(once.P - step.P) < 0.02, `两次一步等于一次两步：${once.P} vs ${step.P}`);
  assert.equal(step.at, NOW + 2 * 3600000, 'at 必须推进到漂完的时间');
});

test('漂完再漂不会越漂越远——at 推进后按理时长归零', async () => {
  const base = computeMood({ events: [], now: NOW });
  const hot = { ...base, P: 0.8, at: NOW };
  const first = driftMood(hot, 1, { now: NOW + 3600000 });
  const again = driftMood(first, 0, { now: NOW + 3600000 });
  assert.equal(again.P, first.P, '零时长不该再衰减一次');
});

test('状态只喂事实，不给结论——「有点被晾着」这种话不许出现在注入里', async () => {
  const { stateFacts } = await import('../lib/mood.js');
  const facts = stateFacts({ idleMinutes: 28, unanswered: 3, positive: 2, negative: 1, baseline: 3.1, lessons: 1 });
  assert.match(facts, /28 分钟前/, `该给时长：${facts}`);
  assert.match(facts, /发了 3 条/, '该给条数');
  assert.match(facts, /正向 2 件、负向 1 件/, '该给计数');
  assert.match(facts, /日均 3\.1 件/, '该给对照');
  assert.match(facts, /自己的错|我的错/, '该给归因计数');
  for (const bad of ['被晾', '委屈', '难受', '不想先低头', '心情', '感觉']) {
    assert.ok(!facts.includes(bad), `不许出现结论式措辞「${bad}」：${facts}`);
  }
});

test('没什么可说的时候闭嘴，不硬造事实', async () => {
  const { stateFacts } = await import('../lib/mood.js');
  assert.equal(stateFacts({ idleMinutes: 5, unanswered: 0, positive: 0, negative: 0 }), '');
});

test('安静但不焦虑：没发过消息就不说「没回音」', async () => {
  const { stateFacts } = await import('../lib/mood.js');
  const facts = stateFacts({ idleMinutes: 40, unanswered: 0 });
  assert.match(facts, /40 分钟前/);
  assert.match(facts, /没再发/);
  assert.ok(!facts.includes('没有回音'), '我自己没发，就不该说没回音');
});

const snap = (over = {}) => ({ P: 0.05, A: -0.2, D: 0.05, B: 0.35, G: 0.3, empty: false, at: NOW, ...over });

test('绝对值平稳、但比几个钟头前掉了一截 → 依然有话可说', () => {
  const now = snap({ P: -0.12, B: 0.26 });
  const prev = snap({ P: 0.18, B: 0.42 });
  assert.equal(describeMood(now), '', '绝对状态在平稳区，本来不该说话');
  assert.ok(moodDelta(now, prev).length >= 2, '两维都掉了，位移该被抓到');
  const felt = describeDelta(now, prev, { agoHours: 6 });
  assert.ok(felt.includes('不是这样'), `该说的是转折：${felt}`);
  assert.ok(!/\d/.test(felt), `不许出现数字：${felt}`);
  assert.ok(!/愉悦|唤醒|支配|依恋|良知/.test(felt), `不许出现维度名：${felt}`);
  assert.match(moodHint(now, prev, { agoHours: 6 }), /不是这样/);
});

test('一直不开心 ≠ 刚不开心：没有参照点就不说话', () => {
  const flat = snap({ P: -0.12, B: 0.26 });
  assert.equal(moodHint(flat, null), '', '没有几小时前的自己可比，就别硬说');
});

test('动得太小不算变化——漂移本身就在动，那是噪声', () => {
  const now = snap({ P: 0.1 });
  const prev = snap({ P: 0.02 });
  assert.deepEqual(moodDelta(now, prev), []);
  assert.equal(describeDelta(now, prev, { agoHours: 6 }), '');
  assert.equal(moodHint(now, prev, { agoHours: 6 }), '');
});

test('时间跨度不同，说法跟着变', () => {
  const now = snap({ P: -0.2 });
  const prev = snap({ P: 0.2 });
  assert.match(describeDelta(now, prev, { agoHours: 1 }), /^刚才/);
  assert.match(describeDelta(now, prev, { agoHours: 6 }), /^几个钟头前/);
  assert.match(describeDelta(now, prev, { agoHours: 20 }), /^早些时候/);
});

// ------------------------------------------------ 良知随四维浮动（2026-10-29 他要求的）

test('良知不再钉死在 0.3：亲近闹腾往下压、疏离端着往上抬', () => {
  const close = conscienceTarget({ A: 0.6, B: 0.8, D: 0 });
  const distant = conscienceTarget({ A: -0.2, B: -0.3, D: 0.4 });
  assert.ok(close < distant, `贴得近 ${close} 应该低于端着 ${distant}`);
  assert.ok(close < G_BASE, '亲近闹腾时该比底色低一点');
  assert.ok(distant > G_BASE, '疏离端着时该比底色高一点');
});

test('良知有硬下限 −0.7，怎么组合都掉不下去', () => {
  const combos = [
    { A: 1, B: 1, D: -1 },
    { A: 1, B: -1, D: 1 },
    { A: -1, B: -1, D: -1 },
    { A: 0, B: 1, D: 0 },
  ];
  for (const combo of combos) {
    assert.ok(conscienceTarget(combo) >= G_FLOOR, `${JSON.stringify(combo)} → ${conscienceTarget(combo)}`);
  }
});

test('重错把良知压到下限就停住', () => {
  const heavy = computeMood({
    events: Array.from({ length: 8 }, () => ev({
      polarity_end: -1, kind: 'lesson', intensity: 1, blame: 'me', tags: ['编造'],
    })),
    now: NOW,
  });
  assert.ok(heavy.G <= 0, `重错要把良知压下去（${heavy.G}）`);
  assert.ok(heavy.G >= G_FLOOR, `不许低于下限（${heavy.G}）`);
});

test('四个原来是死信号的现在真的能动', () => {
  const base = computeMood({ events: [], now: NOW });
  assert.ok(applySignal(base, 'praised', { weight: 1 }).P > base.P, '被夸 → 愉悦上来');
  assert.ok(applySignal(base, 'scolded', { weight: 1 }).P < base.P, '被嫌 → 愉悦下去');
  assert.ok(applySignal(base, 'teased', { weight: 1 }).A > base.A, '被逗 → 唤醒上来');
  assert.ok(applySignal(base, 'agreed', { weight: 1 }).D > base.D, '他顺我 → 支配上来');
  assert.ok(applySignal(base, 'replied', { weight: 1 }).B > base.B, '他跟我说话 → 依恋上来');
});

test('单次脉冲看得见（不再是小数点后第二位）', () => {
  const base = computeMood({ events: [], now: NOW });
  const praised = applySignal(base, 'praised', { weight: 1 });
  assert.ok(praised.P - base.P >= 0.15, `一次夸应该至少抬高 0.15（实际 ${(praised.P - base.P).toFixed(3)}）`);
});
