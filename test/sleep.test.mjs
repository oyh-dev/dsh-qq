import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SleepStore,
  wantSleep,
  sleepHoursNeeded,
  knockThreshold,
  sleepDebtHours,
  muddleAmplitude,
  muddle,
  pickReplyTargets,
  notesSummary,
  notePreview,
  isNight,
  isNapTime,
  shouldMuddle,
} from '../lib/sleep.js';

/** 睡眠模式：睡着压纸条、敲够了叫醒、欠睡发糊（2026-10-29 他提的）。 */

const at = (hour) => {
  const d = new Date(2026, 9, 29, hour, 0, 0, 0);
  return d.getTime();
};

test('想睡的三种触发：能量低、深夜、下午困', () => {
  assert.equal(wantSleep({ level: 0.2, now: at(15) }).reason, 'energy');
  assert.equal(wantSleep({ level: 0.5, now: at(1) }).reason, 'night');
  assert.equal(wantSleep({ level: 0.5, now: at(1) }).tossing, false);
  assert.equal(wantSleep({ level: 0.7, now: at(1) }).reason, 'insomnia', '满电的深夜：不困，但也得躺下');
  assert.equal(wantSleep({ level: 0.7, now: at(1) }).tossing, true);
  assert.equal(wantSleep({ level: 0.4, now: at(14) }).reason, 'nap');
  assert.equal(wantSleep({ level: 0.9, now: at(14) }).want, false);
  assert.equal(wantSleep({ level: 0.9, now: at(10) }).want, false, '上午精神好不睡');
});

test('时段判定：夜里含 23 点后和 7 点前，下午等于 13–16', () => {
  assert.equal(isNight(at(23)), true);
  assert.equal(isNight(at(3)), true);
  assert.equal(isNight(at(6)), true);
  assert.equal(isNight(at(7)), false);
  assert.equal(isNapTime(at(13)), true);
  assert.equal(isNapTime(at(15)), true);
  assert.equal(isNapTime(at(16)), false);
});

test('能量越低补得越多，封顶 4 小时', () => {
  assert.ok(sleepHoursNeeded(0.1) > sleepHoursNeeded(0.5));
  assert.equal(sleepHoursNeeded(0), 4);
  assert.ok(sleepHoursNeeded(1) >= 0.5);
});

test('叫醒阈值：睡得越久越难喊，欠睡再加难度', () => {
  const fresh = knockThreshold({ hoursAsleep: 0, debtHours: 0 });
  const oneHour = knockThreshold({ hoursAsleep: 1, debtHours: 0 });
  const threeHours = knockThreshold({ hoursAsleep: 3, debtHours: 0 });
  const tired = knockThreshold({ hoursAsleep: 0, debtHours: 6 });
  assert.equal(fresh, 3, '刚睡着 3 条能醒');
  assert.ok(oneHour > fresh && threeHours > oneHour, '越睡越难');
  assert.ok(tired > fresh, '欠睡时更难喊');
});

test('连发叠得快：间隔两分钟内第二条算两下', () => {
  const store = new SleepStore({});
  store.enterSleep({ now: at(2) });
  const first = store.knockMessage({ text: '在吗', now: at(2) });
  assert.equal(first.knock, 1);
  const second = store.knockMessage({ text: '人呢', now: at(2) + 30000 });
  assert.equal(second.knock, 3, '连发第二条 +2');
});

test('敲门够了就叫醒，没够就继续压着', () => {
  const store = new SleepStore({});
  store.enterSleep({ now: at(2) });
  const a = store.knockMessage({ text: '在吗', now: at(2) });
  const b = store.knockMessage({ text: '人呢', now: at(2) + 5000 });
  assert.equal(a.woke, false);
  assert.equal(b.woke, true);
  assert.equal(b.asleep, true);
});

test('睡着期间消息变纸条，醒来交出来', () => {
  const store = new SleepStore({});
  store.enterSleep({ now: at(2) });
  store.knockMessage({ text: '我到宿舍了', now: at(2) });
  store.knockMessage({ text: '你睡了吗', now: at(2) + 600000 });
  const out = store.wake({ now: at(2) + 7200000, awakeHoursBefore: 10 });
  assert.equal(out.noteCount, 2);
  assert.ok(out.sleptHours >= 1.9, `睡了 ${out.sleptHours} 小时`);
  assert.match(out.summary, /发了 2 条/);
  assert.equal(store.asleep, false);
  assert.equal(store.data.notes.length, 0, '醒来后纸条清空');
});

test('醒着的时候来消息不会变成纸条', () => {
  const store = new SleepStore({});
  const out = store.knockMessage({ text: '在吗', now: at(12) });
  assert.equal(out.asleep, false);
  assert.equal(store.data.notes.length, 0);
});

test('欠睡：清醒超 16 小时才开始欠，每小时加一', () => {
  assert.equal(sleepDebtHours({ awakeHours: 10 }), 0);
  assert.equal(sleepDebtHours({ awakeHours: 20 }), 4);
});

test('欠睡让五维抖，但不是反转：幅度小、方向随机', () => {
  assert.equal(muddleAmplitude(0), 0);
  assert.ok(shouldMuddle(12));
  assert.equal(shouldMuddle(1), false, '欠一点点不该乱晃');
  const mood = { P: 0.5, A: 0.2, D: 0.1, B: 0.6 };
  const hi = muddle(mood, 12, () => 1);   // 永远取正向极值
  const lo = muddle(mood, 12, () => 0);   // 永远取负向极值
  assert.ok(hi.P > mood.P && lo.P < mood.P, '有上有下');
  assert.ok(Math.abs(hi.P - mood.P) <= 0.26, '幅度受控');
  assert.ok(!('muddled' in mood), '不改原对象');
});

test('纸条挑重点：太短的（嗯/哦）只回汇总，不单拎出来', () => {
  const notes = [
    { text: '嗯' },
    { text: '?' },
    { text: '我今天面试过了，虽然有点紧张' },
  ];
  const picked = pickReplyTargets(notes);
  assert.equal(picked.length, 1);
  assert.match(picked[0].text, /面试/);
});

test('纸条预览长句截断，不换行', () => {
  assert.equal(notePreview('一\n二\n三'), '一 二 三');
  assert.ok(notePreview('字'.repeat(100)).length <= 61);
});

test('汇总里带条数和最近几条', () => {
  const summary = notesSummary([{ text: '我先睡了' }, { text: '晚安' }]);
  assert.match(summary, /发了 2 条/);
  assert.match(summary, /我先睡了/);
});

test('快照：睡着时 muted 为真，阈值随睡久上升', () => {
  const store = new SleepStore({});
  store.enterSleep({ now: at(2) });
  const early = store.snapshot(at(2) + 60000);
  const later = store.snapshot(at(2) + 3 * 3600000);
  assert.equal(early.asleep, true);
  assert.equal(early.muted, true);
  assert.ok(later.threshold > early.threshold);
  assert.ok(later.asleepHours > 2.9);
});

// 2026-10-29 深夜：他说「晚安」时她也跟着躺下——但那是**浅睡**，
// 不主动说话，一条消息就能叫醒（他半夜睡不着还能找她）。
test('浅睡：他说睡了，她跟着躺，一条就能叫醒', () => {
  const store = new SleepStore({});
  store.enterSleep({ now: at(23), reason: '他睡了', depth: 'light' });
  assert.equal(store.snapshot(at(23)).depth, 'light');
  const first = store.knockMessage({ text: '睡不着', now: at(23) });
  assert.equal(first.threshold, 1, '浅睡阈值就是 1');
  assert.equal(first.woke, true, '第一条就醒');
});

test('深睡照旧：自己不睡到点了才睡，得敲几下', () => {
  const store = new SleepStore({});
  store.enterSleep({ now: at(2), reason: '困了', depth: 'deep' });
  const first = store.knockMessage({ text: '在吗', now: at(2) });
  assert.equal(first.threshold, 3);
  assert.equal(first.woke, false);
});

test('落盘：写出去再读回来，睡着状态还在', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sleep-'));
  const file = path.join(dir, 'sleep.json');
  const a = new SleepStore({ file });
  a.enterSleep({ now: at(2) });
  a.knockMessage({ text: '在吗', now: at(2) });
  await a.save();
  const b = new SleepStore({ file });
  await b.load();
  assert.equal(b.asleep, true);
  assert.equal(b.data.notes.length, 1);
  await fs.rm(dir, { recursive: true, force: true });
});
