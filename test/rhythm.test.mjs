import test from 'node:test';
import assert from 'node:assert/strict';

import { clockFacts, humanSpan, RhythmClock, dayPhase, softZone, softZoneFacts, isTransactional } from '../lib/rhythm.js';

const MIN = 60000;
const NOW = new Date('2026-10-28T23:40:00+08:00').getTime();

test('时长说人话', () => {
  assert.equal(humanSpan(0), '');
  assert.equal(humanSpan(20 * 1000), '');
  assert.equal(humanSpan(25 * MIN), '25 分钟');
  assert.equal(humanSpan(2 * 60 * MIN), '2 小时');
  assert.equal(humanSpan(100 * MIN), '1 小时 40 分钟');
});

test('连着聊得久 → 说这一轮从几点开始', () => {
  const line = clockFacts({ now: NOW, streakStartAt: NOW - 100 * MIN, firstTalkAt: NOW - 200 * MIN });
  assert.match(line, /21:?60?|22:00/, `该报起点：${line}`);
  assert.match(line, /1 小时 40 分钟/);
});

test('只给时间，不给「困/累/该睡了」这种判断', () => {
  const line = clockFacts({ now: NOW, streakStartAt: NOW - 100 * MIN });
  for (const bad of ['困', '累', '该睡', '熬夜', '深夜', '疲惫']) {
    assert.ok(!line.includes(bad), `不许出现「${bad}」：${line}`);
  }
});

test('聊得短就闭嘴，别每句都报时', () => {
  assert.equal(clockFacts({ now: NOW, streakStartAt: NOW - 10 * MIN }), '');
});

test('同一段对话里不重复报「今天第一次开口」', () => {
  const first = NOW - 100 * MIN;
  const line = clockFacts({ now: NOW, streakStartAt: first, firstTalkAt: first });
  assert.ok(!line.includes('第一次'), `同一段里不用再说第一次：${line}`);
});

test('今天第一次开口、但中间断过 → 单独说一句', () => {
  const line = clockFacts({ now: NOW, streakStartAt: NOW - 10 * MIN, firstTalkAt: NOW - 300 * MIN });
  assert.match(line, /第一次说话是/);
});

test('启动补账不许编「连了一整天」', () => {
  const clock = new RhythmClock();
  // 今天第一条 08:41，最后一条 18:24，中间断过好几次
  clock.seed({ firstAt: NOW - 10 * 60 * MIN, lastAt: NOW - 27 * MIN }, NOW, '2026-10-28');
  const state = clock.state(NOW);
  assert.equal(state.firstAt, NOW - 10 * 60 * MIN, '第一次开口照实记');
  assert.equal(state.streakAt, NOW - 27 * MIN, '这一轮只能从最后一条算起');
});

test('状态机：断档 40 分钟以上算新的一轮，跨日重置', () => {
  const clock = new RhythmClock();
  clock.noteInbound(NOW - 120 * MIN, '2026-10-28');
  clock.noteInbound(NOW - 110 * MIN, '2026-10-28');
  const sameSession = clock.state(NOW - 110 * MIN);
  assert.equal(sameSession.streakAt, NOW - 120 * MIN, '连着聊，起点不变');

  clock.noteInbound(NOW, '2026-10-28'); // 中间空了 110 分钟
  const newSession = clock.state(NOW);
  assert.equal(newSession.streakAt, NOW, '断档后重新起一轮');
  assert.equal(newSession.firstAt, NOW - 120 * MIN, '但今天第一次开口还是原来那个');

  const nextDay = clock.noteInbound(NOW + 24 * 60 * MIN, '2026-10-29');
  assert.equal(nextDay.firstAt, NOW + 24 * 60 * MIN, '跨日重新算第一次');
});

// ------------------------------------------------------------ 第二层：时段

const clockAt = (hhmm) => {
  const [hour, minute] = hhmm.split(':').map(Number);
  const date = new Date('2026-10-28T00:00:00+08:00');
  date.setHours(hour, minute, 0, 0);
  return date;
};

test('时段乘数：早醒压、白天放、深夜再压', () => {
  assert.equal(dayPhase(clockAt('08:30')).proactiveMul, 0.6);
  assert.equal(dayPhase(clockAt('11:00')).proactiveMul, 1);
  assert.equal(dayPhase(clockAt('13:00')).proactiveMul, 0.7);
  assert.equal(dayPhase(clockAt('20:00')).proactiveMul, 1);
  assert.equal(dayPhase(clockAt('23:40')).proactiveMul, 0.5);
});

test('14–18 点这段节律不压——那是成本节律的活，双重惩罚会安静到像掉线', () => {
  assert.equal(dayPhase(clockAt('15:30')).proactiveMul, 1);
});

// ------------------------------------------------------------ 第三层：软区

const softArgs = (over = {}) => ({
  now: clockAt('23:40'),
  streakMinutes: 42,
  transactional: false,
  hasEmotionToday: true,
  ...over,
});

test('四个条件全中才进软区', () => {
  assert.equal(softZone(softArgs()).active, true);
});

test('缺任何一个条件都不进', () => {
  assert.equal(softZone(softArgs({ now: clockAt('20:00') })).active, false, '不在窗口');
  assert.equal(softZone(softArgs({ transactional: true })).active, false, '这句是办事的');
  assert.equal(softZone(softArgs({ hasEmotionToday: false })).active, false, '今天没情绪事件');
  assert.equal(softZone(softArgs({ streakMinutes: 5 })).active, false, '这一轮太短');
});

test('不进的时候要说清楚为什么', () => {
  const reasons = softZone(softArgs({ transactional: true })).reasons;
  assert.ok(reasons.some((r) => r.includes('办事')), `要给出原因：${reasons.join('/')}`);
});

test('事务性判定：办事的不算倾诉', () => {
  assert.equal(isTransactional('帮我看下插件报错'), true);
  assert.equal(isTransactional('今天好累啊'), false);
  assert.equal(isTransactional(''), false);
});

test('软区事实只说时间和时长，不说「该 emo 了」', () => {
  const line = softZoneFacts({ now: clockAt('23:40'), streakMinutes: 42 });
  assert.match(line, /23:40/);
  assert.match(line, /42 分钟/);
  for (const bad of ['emo', '难过', '脆弱', '该睡', '困']) {
    assert.ok(!line.includes(bad), `不许出现「${bad}」：${line}`);
  }
});
