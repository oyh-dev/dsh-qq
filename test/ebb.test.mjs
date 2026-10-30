import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';

import {
  EbbStore,
  layerOf,
  normalizeScore,
  decayedIntensity,
  isZeroed,
  retention,
  retentionOf,
  stabilityDays,
  selectRecall,
  localDayKey,
  LAYER_CUTS,
  STABILITY_DAYS,
  STRUCTURAL_STABILITY_DAYS,
  RETENTION_FLOOR,
  NEGATIVE_FACTOR,
  RESOLVED_NEGATIVE_FACTOR,
} from '../lib/ebb.js';

const DAY = 86400000;

/**
 * 边界层夹具：形状和真实 bounds.json 一样（standing / crossing 两段），
 * 内容用中性占位——真实边界是使用者自己的事，不该写进测试。
 */
const BOUNDS_FIXTURE = {
  standing: {
    items: [
      { id: 'S01', what: '不许骗人。', strategy: '不确定就说不知道。' },
      { id: 'S02', what: '不翻别人的隐私。', strategy: '只读主动给的入口。' },
    ],
  },
  crossing: {
    items: [
      { id: 'C01', what: '把我当客服使唤还嫌慢。', strategy: '直说我在查，别催。' },
    ],
  },
};

async function tmpStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ebb-'));
  const boundsFile = path.join(dir, 'bounds.json');
  await writeFile(boundsFile, JSON.stringify(BOUNDS_FIXTURE), 'utf8');
  const store = new EbbStore({ dir, boundsFile });
  await store.ensure();
  return { store, dir };
}

// ---------------------------------------------------------------- 分层

test('层门槛：0.65 / 0.40 / 0.20 分界正确', () => {
  assert.equal(layerOf(0.9), 'L1');
  assert.equal(layerOf(0.65), 'L1');
  assert.equal(layerOf(0.64), 'L2');
  assert.equal(layerOf(0.4), 'L2');
  assert.equal(layerOf(0.39), 'L3');
  assert.equal(layerOf(0.2), 'L3');
  assert.equal(layerOf(0.19), 'pending');
});

test('层门槛常量没被改动', () => {
  assert.deepEqual(LAYER_CUTS, { L1: 0.65, L2: 0.4, L3: 0.2 });
});

// ---------------------------------------------------------------- 证据链

test('事件带原话和说话人——回溯「我为什么记得这条」靠它', async () => {
  const { store } = await tmpStore();
  const event = await store.record({
    intensity: 0.7,
    polarity_end: -0.4,
    trigger: '他说眼睛疼',
    quote: '上班盯了一天电脑，眼睛疼',
    speaker: 'him',
    chat: { type: 'private', id: '1000000001' },
  });
  assert.equal(event.quote, '上班盯了一天电脑，眼睛疼');
  assert.equal(event.speaker, 'him');
  const rows = await store.load();
  const back = rows.find((row) => row.id === event.id);
  assert.equal(back.quote, '上班盯了一天电脑，眼睛疼', '落盘后原话还在');
});

test('没给原话就留空，不拿 claim 顶上', async () => {
  const { store } = await tmpStore();
  const event = await store.record({
    intensity: 0.5,
    polarity_end: 0.2,
    claim: '他要求独处，我答应了',
  });
  assert.equal(event.quote, '', '推断不能冒充原话');
  assert.equal(event.speaker, '');
});

// ---------------------------------------------------------------- 打分

test('强度低于 0.15 时极性强制归 0——不给噪声强编方向', () => {
  const s = normalizeScore({ intensity: 0.1, polarity_end: -0.8 });
  assert.equal(s.polarity_end, 0);
  assert.equal(s.layer, 'pending');

  const high = normalizeScore({ intensity: 0.5, polarity_end: -0.8 });
  assert.equal(high.polarity_end, -0.8);
});

test('强度为 0 不允许写成事件', () => {
  assert.throws(() => normalizeScore({ intensity: 0 }), /强度必须大于 0/);
  assert.throws(() => normalizeScore({ intensity: 1.4 }), /超出 0-1/);
});

test('强度保留两位、极性夹到 -1..1', () => {
  const s = normalizeScore({ intensity: 0.6789, polarity_end: -3 });
  assert.equal(s.intensity, 0.68);
  assert.equal(s.polarity_end, -1);
});

test('极性轨迹被保留并夹紧；坏数据丢掉', () => {
  const s = normalizeScore({
    intensity: 0.7,
    polarity_end: 0.6,
    polarity_track: [[0, 0.8], [0.5, -2], 'bad', [1]],
  });
  assert.deepEqual(s.polarity_track, [[0, 0.8], [0.5, -1]]);
});

// ---------------------------------------------------------------- 衰减（幂律）

test('幂律：t = S 时保留率正好 0.9（FSRS 的性质）', () => {
  assert.ok(Math.abs(retention(30, 30) - 0.9) < 1e-9);
  assert.ok(Math.abs(retention(90, 90) - 0.9) < 1e-9);
  assert.equal(retention(0, 40), 1);
});

test('幂律：早期掉得比指数慢得多（这条就是指数的毛病）', () => {
  // S=40 的条目：7 天后还 0.97，30 天后 0.92；换成旧的指数（半衰期 21 天）只有 0.79 / 0.37
  assert.ok(retention(7, 40) > 0.97);
  assert.ok(retention(30, 40) > 0.91);
  assert.ok(retention(365, 40) > 0.55, `一年后仍有 ${retention(365, 40).toFixed(3)}，远高于地板`);
});

test('稳定性：负向比正向长（忘掉甜可以，忘掉疼不行）', () => {
  const pos = stabilityDays({ layer: 'L1', polarity_end: 0.5 });
  const neg = stabilityDays({ layer: 'L1', polarity_end: -0.5 });
  assert.ok(neg > pos);
  assert.ok(Math.abs(neg - STABILITY_DAYS.L1 * NEGATIVE_FACTOR) < 1e-9);
});

test('稳定性：结构事件不分正负，S 最宽', () => {
  const pos = stabilityDays({ layer: 'L3', polarity_end: 0.6, kind: 'structural' });
  const neg = stabilityDays({ layer: 'L3', polarity_end: -0.6, kind: 'structural' });
  assert.equal(pos, STRUCTURAL_STABILITY_DAYS);
  assert.equal(neg, STRUCTURAL_STABILITY_DAYS);
});

test('稳定性：教训 ×3——错的代价不随时间消失', () => {
  const plain = stabilityDays({ layer: 'L2', polarity_end: -0.5 });
  const lesson = stabilityDays({ layer: 'L2', polarity_end: -0.5, kind: 'lesson' });
  assert.ok(Math.abs(lesson - plain * 3) < 1e-9, `教训 ${lesson} 应为普通 ${plain} 的三倍`);
});

test('稳定性：和解之后负向不再加倍黏', () => {
  const open = stabilityDays({ layer: 'L1', polarity_end: -0.5, resolved: false });
  const done = stabilityDays({ layer: 'L1', polarity_end: -0.5, resolved: true });
  assert.ok(done < open, '和解过的事该比还僵着的淡得快');
  assert.ok(Math.abs(done - STABILITY_DAYS.L1 * RESOLVED_NEGATIVE_FACTOR) < 1e-9);
});

test('有效强度 = 原始强度 × 保留率', () => {
  const event = { intensity: 0.8, layer: 'L1', polarity_end: 0.5, ts: 0, last_touch: 0 };
  const got = decayedIntensity(event, 90 * DAY);
  assert.ok(Math.abs(got - 0.8 * 0.9) < 1e-6, `期望 0.72，实际 ${got}`);
});

test('衰减：last_touch 会重置计时器（泡腾片重新扔一次）', () => {
  const stale = { intensity: 0.5, layer: 'L2', polarity_end: 0.3, last_touch: 0 };
  const fresh = { ...stale, last_touch: 100 * DAY };
  assert.ok(decayedIntensity(fresh, 100 * DAY) > decayedIntensity(stale, 100 * DAY));
});

test('幂律下不会靠阈值退场——所以退场必须靠冷存', () => {
  const ancient = { intensity: 0.4, layer: 'L3', polarity_end: 0.3, last_touch: 0 };
  // 一年后保留率仍在 0.4 以上，远高于地板
  assert.ok(retentionOf(ancient, 365 * DAY) > 0.4);
  assert.equal(isZeroed(ancient, 365 * DAY), false);
  // 只有显式冷存才算退场
  assert.equal(isZeroed({ ...ancient, cold_at: 1 }, 365 * DAY), true);
  assert.ok(RETENTION_FLOOR < 0.03);
});

// ---------------------------------------------------------------- 冷存（容量制退场）

test('冷存：超过上限时挤掉权重最低的', async () => {
  const { store } = await tmpStore();
  const now = Date.now();
  for (let i = 0; i < 6; i += 1) {
    await store.record({ intensity: 0.2 + i * 0.1, polarity_end: 0.3, text: `事件${i}`, ts: now });
  }
  const result = await store.compact({ keep: 3, now });
  assert.equal(result.moved, 3, '6 条压到 3 条，应该挤掉 3 条');
  const alive = await store.search({ now });
  assert.equal(alive.length, 3);
  const all = await store.search({ now, includeZeroed: true });
  assert.equal(all.length, 6, '冷存不是删除，数据还在');
});

test('冷存：结构事件永远不被挤掉', async () => {
  const { store } = await tmpStore();
  const now = Date.now();
  await store.record({ intensity: 0.3, polarity_end: 0.6, kind: 'structural', text: '他划了底线', ts: now });
  for (let i = 0; i < 4; i += 1) {
    await store.record({ intensity: 0.9, polarity_end: 0.2, text: `普通${i}`, ts: now });
  }
  await store.compact({ keep: 3, now });
  const alive = await store.search({ now });
  const texts = alive.map((row) => row.text);
  assert.ok(texts.includes('他划了底线'), '结构事件不该被挤走');
});

// ---------------------------------------------------------------- 记录

test('record 写到 events/<自然日>.jsonl，一行一条', async () => {
  const { store, dir } = await tmpStore();
  const ts = new Date('2026-10-25T21:07:46+08:00').getTime();
  await store.record({
    ts, chat: { type: 'private', id: '1000000001' },
    intensity: 0.6, polarity_end: -0.4, polarity_low: -0.5,
    trigger: '「不了，我想自己待会」', state: 'open',
    text: '咕噜 突然有点想你了',
  });
  const file = path.join(dir, 'events', '2026-10-25.jsonl');
  const lines = (await readFile(file, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  const row = JSON.parse(lines[0]);
  assert.equal(row.layer, 'L2');
  assert.equal(row.day, '2026-10-25');
  assert.equal(row.state, 'open');
  assert.equal(row.text, '咕噜 突然有点想你了');
  assert.equal(localDayKey(ts), '2026-10-25');
});

test('record 拒绝强度为 0 的噪声', async () => {
  const { store } = await tmpStore();
  await assert.rejects(() => store.record({ intensity: 0, text: '嗯' }), /强度必须大于 0/);
});

// ---------------------------------------------------------------- 检索

test('注入选择：没撞上关键词就一条都不带（不许回退到「最近三天」）', () => {
  const now = Date.now();
  const events = [
    { trigger: '不了，我想自己待会', text: '不了，我想自己待会', intensity: 0.6, layer: 'L2', polarity_end: -0.4, ts: now },
    { trigger: '今晚吃洋葱', text: '今晚吃洋葱', intensity: 0.75, layer: 'L1', polarity_end: 0.6, ts: now },
  ];
  // 「今天中午吃啥」跟上面两条一个字都不撞
  const grams = ['今天', '天中', '中午', '午吃', '吃啥'];
  assert.equal(selectRecall(events, { grams, now }).length, 0, '撞不上就别带，宁可空着');
});

test('注入选择：撞上了才带，且至少命中两个二元组', () => {
  const now = Date.now();
  const events = [
    { trigger: '不了，我想自己待会', text: '', intensity: 0.6, layer: 'L2', polarity_end: -0.4, ts: now },
  ];
  const one = selectRecall(events, { grams: ['自己'], now });
  assert.equal(one.length, 0, '只撞一个字不算相关');
  const two = selectRecall(events, { grams: ['自己', '待会'], now });
  assert.equal(two.length, 1);
});

test('注入选择：不看 claim——主观独白不参与匹配也不进注入文本', () => {
  const now = Date.now();
  const events = [
    {
      trigger: '（无）',
      text: '',
      claim: '我被明确推开了一次，热脸贴在冷水上',
      intensity: 0.9,
      layer: 'L1',
      polarity_end: -0.5,
      ts: now,
    },
  ];
  const picked = selectRecall(events, { grams: ['推开', '冷水'], now });
  assert.equal(picked.length, 0, 'claim 里的词不该命中');
});

test('注入选择：冷存和低权重的不带', () => {
  const now = Date.now();
  const events = [
    { trigger: '不了，我想自己待会', text: '', intensity: 0.9, layer: 'L1', polarity_end: -0.4, ts: now, cold_at: 1 },
    { trigger: '不了，我想自己待会', text: '', intensity: 0.1, layer: 'L3', polarity_end: -0.4, ts: now - 400 * DAY },
  ];
  assert.equal(selectRecall(events, { grams: ['自己', '待会'], now }).length, 0);
});

test('检索按有效强度降序，冷存的不返回', async () => {
  const { store } = await tmpStore();
  const now = Date.now();
  await store.record({ intensity: 0.9, polarity_end: -0.6, text: '冷战的晚上', tags: ['冷战'], ts: now });
  await store.record({ intensity: 0.5, polarity_end: 0.5, text: '洋葱求婚', tags: ['恶搞'], ts: now });
  await store.record({ intensity: 0.3, polarity_end: 0.2, text: '食堂七块', tags: ['日常'], ts: now });

  const all = await store.search({ now });
  assert.equal(all.length, 3);
  assert.equal(all[0].text, '冷战的晚上');
  assert.ok(all[0].current_intensity > all[1].current_intensity);

  // 幂律下一年后三条都还在，只是权重都低了——退场不靠阈值
  const later = await store.search({ now: now + 400 * DAY });
  assert.equal(later.length, 3);

  // 退场靠冷存：压到 1 条，最弱的先被挤出去
  await store.compact({ keep: 1, now: now + 400 * DAY });
  const after = await store.search({ now: now + 400 * DAY });
  assert.equal(after.length, 1);
  assert.equal(after[0].text, '冷战的晚上');
});

test('检索能按关键词、层、会话过滤', async () => {
  const { store } = await tmpStore();
  await store.record({ intensity: 0.7, polarity_end: 0.6, text: '闹掰了就不好了', tags: ['划底线'], chat: { type: 'private', id: '1' } });
  await store.record({ intensity: 0.3, polarity_end: 0.1, text: '食堂七块', chat: { type: 'private', id: '2' } });

  assert.equal((await store.search({ query: '划底线' })).length, 1);
  assert.equal((await store.search({ query: '食堂' })).length, 1);
  assert.equal((await store.search({ chatId: '2' })).length, 1);
  assert.equal((await store.search({ layer: 'L1' })).length, 1);
  assert.equal((await store.search({ minIntensity: 0.5 })).length, 1);
});

test('touch 重置衰减并让强度小幅回升 5%', async () => {
  const { store } = await tmpStore();
  const ev = await store.record({ intensity: 0.5, polarity_end: 0.4, text: '想起来了' });
  const later = Date.now() + 30 * DAY;
  const touched = await store.touch(ev.id, later);
  assert.equal(touched.touches, 1);
  assert.ok(touched.intensity > 0.5);
  assert.equal(touched.zeroed_at, null);
  const again = await store.search({ now: later });
  assert.equal(again.length, 1, '重提之后又回到池子里');
});

// ---------------------------------------------------------------- 边界层

test('边界层：常驻段和被越界段分开读取', async () => {
  const { store } = await tmpStore();
  const standing = await store.standingText();
  const crossing = await store.crossingText();

  assert.match(standing, /不许骗人/);
  assert.match(standing, /不翻别人的隐私/);
  assert.ok(!standing.includes('当客服'), '被越界的不该混进常驻段');

  assert.match(crossing, /客服/);
  assert.ok(!crossing.includes('不许骗人'), '常驻的不该混进被越界段');
});

test('边界文件缺失时返回空串而不是炸', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ebb-'));
  const store = new EbbStore({ dir, boundsFile: path.join(dir, 'nope.json') });
  assert.equal(await store.standingText(), '');
  assert.equal(await store.crossingText(), '');
});
