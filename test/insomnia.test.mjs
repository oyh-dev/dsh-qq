import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SleepStore,
  wantSleep,
  insomniaHours,
  knockThreshold,
  hoursUntilMorning,
  isNight,
  INSOMNIA_MIN_HOURS,
  INSOMNIA_MAX_HOURS,
} from '../lib/sleep.js';

/**
 * 睡不着（2026-10-30 他提的）：能量太满的深夜，人躺下了，但睡不着。
 *
 * 要点：
 *   · 深夜 + 满电 → 躺下但没睡着，**不算休息**（不充电、不记睡够时长、欠睡照算）
 *   · 但她在床上，一条消息就能叫到（阈值 1）
 *   · 翻够时间自然睡着，之后按正常睡眠走
 */

const at = (hour, day = 30) => new Date(2026, 9, day, hour, 0, 0, 0).getTime();

test('满电的深夜：不困，但得躺下', () => {
  const want = wantSleep({ level: 1, now: at(0) });
  assert.equal(want.want, true);
  assert.equal(want.reason, 'insomnia');
  assert.equal(want.tossing, true);
});

test('白天满电不躺：只有夜里才翻来覆去', () => {
  assert.equal(wantSleep({ level: 1, now: at(10) }).want, false);
  assert.equal(wantSleep({ level: 1, now: at(19) }).want, false);
  assert.equal(wantSleep({ level: 1, now: at(7) }).want, false, '早上七点已经不算法夜里');
});

test('累的深夜照常睡，不掺失眠', () => {
  const want = wantSleep({ level: 0.3, now: at(1) });
  assert.equal(want.reason, 'night');
  assert.equal(want.tossing, false);
});

test('越满电翻得越久，但不出区间', () => {
  const half = insomniaHours({ level: 0.7, rand: () => 0.5 });
  const full = insomniaHours({ level: 1, rand: () => 0.5 });
  assert.ok(full > half, `满电该翻更久：${half} vs ${full}`);
  for (const level of [0.7, 0.85, 1]) {
    for (const r of [0, 0.5, 1]) {
      const h = insomniaHours({ level, rand: () => r });
      assert.ok(h >= INSOMNIA_MIN_HOURS && h <= INSOMNIA_MAX_HOURS, `${level}/${r} → ${h}`);
    }
  }
});

test('躺下没睡着：一条消息就能叫到', () => {
  assert.equal(knockThreshold({ depth: 'insomnia' }), 1);
  const store = new SleepStore({});
  store.enterSleep({ now: at(0), reason: 'insomnia', depth: 'insomnia', tossHours: 2 });
  assert.equal(store.tossing, true, '还没睡着');
  const first = store.knockMessage({ text: '还没睡吧', now: at(0) + 60000 });
  assert.equal(first.threshold, 1);
  assert.equal(first.woke, true, '本来就睁着眼，不用敲几下');
});

test('躺着的两个小时不算睡：不推进睡够时长、欠睡照算', () => {
  const store = new SleepStore({});
  store.enterSleep({ now: at(0), reason: 'insomnia', depth: 'insomnia', tossHours: 2 });
  const out = store.wake({ now: at(2), awakeHoursBefore: 21 });
  assert.equal(out.sleptHours, 0, '没睡着就是 0');
  assert.equal(out.tossingHours, 2, '翻了两小时要记下来');
  assert.equal(store.data.sleptHoursToday, 0);
  // 清醒 21 小时 → 欠 5 小时；躺着没补上，一分都不能扣
  assert.equal(out.sleepDebtHours, 5);
});

test('翻够了自然睡着，之后按正常睡眠算', () => {
  const store = new SleepStore({});
  store.enterSleep({ now: at(0), reason: 'insomnia', depth: 'insomnia', tossHours: 2 });
  const fell = store.fallAsleep({ now: at(2) });
  assert.equal(fell.tossingHours, 2);
  assert.equal(store.tossing, false);
  const snap = store.snapshot(at(4));
  assert.equal(snap.depth, 'deep');
  assert.ok(Math.abs(snap.asleepHours - 2) < 0.01, `睡着两小时，实际 ${snap.asleepHours}`);
  assert.equal(snap.tossingHours, 2);
  // 醒的时候只补真睡着那段：2 小时，不是 4 小时
  const out = store.wake({ now: at(7), awakeHoursBefore: 20 });
  assert.ok(Math.abs(out.sleptHours - 5) < 0.01, `只补睡着后的 5 小时，实际 ${out.sleptHours}`);
  assert.equal(out.tossingHours, 2);
  assert.equal(store.data.sleptHoursToday, 5, '躺着那两小时不进今天睡过的时间');
});

test('快照里能看出「躺着没睡着」和还剩多久', () => {
  const store = new SleepStore({});
  store.enterSleep({ now: at(1), depth: 'insomnia', tossHours: 2 });
  const snap = store.snapshot(at(1) + 1800000);
  assert.equal(snap.tossing, true);
  assert.equal(snap.asleep, true, '对外仍是睡眠态：不主动说话');
  assert.ok(Math.abs(snap.tossLeftHours - 1.5) < 0.01, `还剩 ${snap.tossLeftHours} 小时`);
  assert.equal(snap.threshold, 1);
});

test('深睡照旧：没有 tossHours 就不是失眠', () => {
  const store = new SleepStore({});
  store.enterSleep({ now: at(2), depth: 'deep' });
  assert.equal(store.tossing, false);
  assert.equal(store.data.tossHours, 0);
});

test('离天亮：夜里按钟点算，白天是 0', () => {
  assert.equal(hoursUntilMorning(at(23)), 8);
  assert.equal(hoursUntilMorning(at(2)), 5);
  assert.ok(Math.abs(hoursUntilMorning(at(6)) - 1) < 0.01);
  assert.equal(hoursUntilMorning(at(7)), 0);
  assert.equal(hoursUntilMorning(at(14)), 0);
  assert.equal(isNight(at(23)), true);
});

test('落盘：躺下没睡着的状态也能存回来', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'insomnia-'));
  const file = path.join(dir, 'sleep.json');
  const a = new SleepStore({ file });
  a.enterSleep({ now: at(0), depth: 'insomnia', tossHours: 2 });
  await a.save();
  const b = new SleepStore({ file });
  await b.load();
  assert.equal(b.tossing, true);
  assert.equal(b.data.tossHours, 2);
  await fs.rm(dir, { recursive: true, force: true });
});
