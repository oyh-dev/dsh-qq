import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { SleepStore, sleepFacts, wakeBrief, notesSummary } from '../lib/sleep.js';

/**
 * 睡眠事实（2026-10-30）。
 *
 * 那天：他睡了两个半小时，她也睡了一小时，醒来后她说「我这五个钟头一直挂着」。
 * 因为她手里没有关于自己睡眠的任何信息，只能把空白编成一个好看的版本。
 * 这一层把事实直接交给她：现在什么状态、最近几段睡了多久。
 */

const at = (hour, minute = 0, day = 30) => new Date(2026, 9, day, hour, minute, 0, 0).getTime();

test('醒来会记下一段睡眠：从躺下到醒来', () => {
  const store = new SleepStore({});
  store.enterSleep({ now: at(15, 55), depth: 'deep' });
  store.wake({ now: at(16, 56), awakeHoursBefore: 12 });
  const [segment] = store.data.segments;
  assert.equal(segment.from, at(15, 55));
  assert.equal(segment.to, at(16, 56));
  assert.ok(Math.abs(segment.sleptHours - 1.016) < 0.01, `睡了 ${segment.sleptHours}`);
  assert.equal(segment.depth, 'deep');
});

test('躺着没睡着那段单独记，不算睡', () => {
  const store = new SleepStore({});
  store.enterSleep({ now: at(0), depth: 'insomnia', tossHours: 2 });
  store.fallAsleep({ now: at(2) });
  store.wake({ now: at(5), awakeHoursBefore: 20 });
  const [segment] = store.data.segments;
  assert.ok(Math.abs(segment.sleptHours - 3) < 0.01);
  assert.ok(Math.abs(segment.tossingHours - 2) < 0.01);
});

test('睡眠段能落盘再读回来（重启后她还知道自己睡过）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sleep-facts-'));
  const file = path.join(dir, 'sleep.json');
  const a = new SleepStore({ file });
  a.enterSleep({ now: at(15, 55), depth: 'light' });
  a.wake({ now: at(17, 34), awakeHoursBefore: 12 });
  await a.save();

  const b = new SleepStore({ file });
  await b.load();
  assert.equal(b.data.segments.length, 1);
  assert.equal(b.data.segments[0].depth, 'light');
});

test('事实：醒着时给「几点醒的、已经多久」', () => {
  const now = at(18, 0);
  const text = sleepFacts({
    snapshot: { asleep: false, tossing: false, wokeAt: at(17, 34) },
    segments: [{ from: at(17, 33), to: at(17, 34), sleptHours: 0.024, tossingHours: 0 }],
    now,
  });
  assert.match(text, /现在：醒着/);
  assert.match(text, /17:34 醒的/);
  assert.match(text, /最近睡过：17:33–17:34/);
  assert.match(text, /不到 10 分钟/, '不到十分钟要这么说，别写成 0.0 小时');
});

test('事实：睡着和躺下没睡着是两种说法', () => {
  const asleep = sleepFacts({ snapshot: { asleep: true, depth: 'light', asleepHours: 1.2 }, segments: [], now: at(2) });
  assert.match(asleep, /现在：睡着中/);
  assert.match(asleep, /浅睡/);
  const tossing = sleepFacts({
    snapshot: { asleep: true, tossing: true, asleepHours: 1, tossLeftHours: 1.5 },
    segments: [],
    now: at(1),
  });
  assert.match(tossing, /躺着没睡着/);
  assert.match(tossing, /1\.5 小时/);
});

test('事实里带着那句防编造的话', () => {
  const text = sleepFacts({ snapshot: { asleep: false, wokeAt: at(17, 34) }, segments: [], now: at(18) });
  assert.match(text, /别把这段时间说成/);
  assert.match(text, /一直挂着/);
  assert.match(text, /别替他算他睡了多久/);
});

// 2026-10-30 实况：11:36 睡到 15:45，中间 13:16「吃饭去了」、15:37「钻被窝」两条都成了纸条。
// 她醒来把它读成「我这五个钟头一直挂着，没收到你的消息」——把「我没听见」说成「你没说」。
test('上一次睡着期间收到几条，要一直挂在她眼前', () => {
  const text = sleepFacts({
    snapshot: { asleep: false, wokeAt: at(15, 45) },
    segments: [{ from: at(11, 36), to: at(15, 45), sleptHours: 4.15, tossingHours: 0 }],
    lastWake: { at: at(15, 45), sleptHours: 4.15, noteCount: 2 },
    now: at(15, 50),
  });
  assert.match(text, /上一次睡着期间他发来 2 条/);
  assert.match(text, /那是你睡着、没听见的消息/);
  assert.match(text, /最近睡过：11:36–15:45/);
});

test('没收到纸条就不提那一行；隔了太久也不再提', () => {
  const none = sleepFacts({
    snapshot: { asleep: false, wokeAt: at(15, 45) },
    lastWake: { at: at(15, 45), noteCount: 0 },
    now: at(15, 50),
  });
  assert.doesNotMatch(none, /上一次睡着期间/);
  const stale = sleepFacts({
    snapshot: { asleep: false, wokeAt: at(3, 0) },
    lastWake: { at: at(3, 0), noteCount: 2 },
    now: at(16, 0),
  });
  assert.doesNotMatch(stale, /上一次睡着期间/);
});

test('空快照不炸，返回能看懂的一行', () => {
  const text = sleepFacts({});
  assert.match(text, /现在：醒着/);
});

test('睡眠段只留最近几条，不会无限长', () => {
  const store = new SleepStore({});
  for (let i = 0; i < 20; i += 1) {
    store.enterSleep({ now: at(0) + i * 3600000, depth: 'light' });
    store.wake({ now: at(0) + i * 3600000 + 600000, awakeHoursBefore: 12 });
  }
  assert.equal(store.data.segments.length, 12);
});

// 2026-10-30 第二次：她 11:36 趴下，直到晚上他睡下才被叫醒。
// 纸条上只有「他吃饭去了」「他睡觉去了」，两条隔了十几个小时，读起来像连续的；
// 于是她把自己整段睡眠误读成「他一直在沉默没发消息」。
test('纸条带时刻和跨度：隔了十几个小时的两条不能再读成连着说的', () => {
  const notes = [
    { at: at(12, 31), text: '我吃饭去了' },
    { at: at(23, 2), text: '我先睡了' },
  ];
  const summary = notesSummary(notes);
  assert.match(summary, /12:31/, '第一条要带时刻');
  assert.match(summary, /23:02/, '最后一条要带时刻');
  assert.match(summary, /（12:31 到 23:02）/, '要标出跨度');
});

test('醒来第一句说清楚：是你在睡，不是他在沉默', () => {
  const notes = [
    { at: at(12, 31), text: '我吃饭去了' },
    { at: at(23, 2), text: '我先睡了' },
  ];
  const text = wakeBrief({ sleptHours: 11.3, laidDownAt: at(12, 3), notes, now: at(23, 20) });
  assert.match(text, /你睡了 11\.3 小时/);
  assert.match(text, /12:03 睡到 23:20/);
  assert.match(text, /不是他长时间没收到消息|不是他在沉默/);
  assert.match(text, /最后一条 23:02/, '要告诉他最后一条是什么时候的');
});

test('刚躺下就被叫醒时不吹成「睡了很久」', () => {
  const text = wakeBrief({ sleptHours: 0.02, laidDownAt: at(17, 33), notes: [], now: at(17, 34) });
  assert.match(text, /不到 10 分钟/);
  assert.doesNotMatch(text, /你睡了/);
});
