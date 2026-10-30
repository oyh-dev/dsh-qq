import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { JudgmentsStore } from '../lib/judgments.js';

const DAY = 86400000;

async function withStore(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-judgments-'));
  try {
    const store = new JudgmentsStore({ dir });
    await store.load();
    await run(store, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('记一条判断要带出处，没出处直接拒', async () => {
  await withStore(async (store) => {
    await assert.rejects(() => store.add({ text: '他讨厌被嘱咐' }), /出处/);
    const { record } = await store.add({ text: '他讨厌被嘱咐', quote: '你别管我', day: '2026-10-22' });
    assert.equal(record.status, 'active');
    assert.equal(record.day, '2026-10-22');
    assert.equal(record.confirmed, 1);
  });
});

test('同一个判断再记一次 = 确认，不产生第二条', async () => {
  await withStore(async (store) => {
    await store.add({ text: '他讨厌被嘱咐', quote: '你别管我', day: '2026-10-22' });
    const again = await store.add({ text: '他讨厌被嘱咐 ', quote: '别说了', day: '2026-10-25' });
    assert.equal(again.merged, true);
    assert.equal(again.record.confirmed, 2);
    assert.equal(store.list({ status: 'active' }).length, 1);
  });
});

test('注入段跟记忆段分开：说清「可能不准」，并带出处', async () => {
  await withStore(async (store) => {
    await store.add({ text: '他讨厌被嘱咐', quote: '你别管我', day: '2026-10-22' });
    const text = store.render({ limit: 4 });
    assert.match(text, /可能不准/);
    assert.match(text, /10-22/);
    assert.match(text, /你别管我/);
    assert.ok(!/发生过|事实片段/.test(text), '不该跟记忆段一个口吻');
  });
});

test('推翻：标记 superseded，不删记录，也不再多说', async () => {
  await withStore(async (store) => {
    await store.add({ text: '他讨厌被嘱咐', quote: '你别管我', day: '2026-10-22' });
    await store.revoke({ key: '讨厌被嘱咐', reason: '他说不是这样' });
    assert.equal(store.list({ status: 'active' }).length, 0);
    assert.equal(store.list({ status: 'superseded' }).length, 1);
    assert.equal(store.render({ limit: 4 }), '', '推翻的判断不该继续影响语气');
    const all = store.list({ status: 'all' });
    assert.equal(all[0].revokedReason, '他说不是这样');
    assert.equal(all[0].rejected, 1);
  });
});

test('排序：确认过的靠前，久没被印证的往下掉', async () => {
  await withStore(async (store) => {
    const now = Date.now();
    // 旧的、只出现过一次
    await store.add({ text: '他喜欢被摸头', quote: '再摸一下', day: '2026-09-01', at: now - 40 * DAY });
    // 新的、被反复确认
    await store.add({ text: '他不喜欢被催', quote: '别催', day: '2026-10-25', at: now - 1 * DAY });
    await store.add({ text: '他不喜欢被催', quote: '说了别催', day: '2026-10-26', at: now - 1 * DAY });
    const ranked = store.rank({ now });
    assert.equal(ranked[0].text, '他不喜欢被催');
    assert.ok(ranked[0].confirmed >= 2);
  });
});

test('重新打开还在，append-only 折得回来', async () => {
  await withStore(async (store, dir) => {
    await store.add({ text: '他会把事拖到半夜', quote: '明天再说', day: '2026-10-20' });
    const reopened = new JudgmentsStore({ dir });
    await reopened.load();
    assert.equal(reopened.list({ status: 'active' }).length, 1);
    assert.equal(reopened.list({ status: 'active' })[0].quote, '明天再说');
  });
});

// ------------------------------------------------------------ 相关性 / 降权

test('跟这句无关的判断不注入——撞不上就闭嘴', async () => {
  await withStore(async (store) => {
    await store.add({ text: '他讨厌被嘱咐', quote: '你别管我', day: '2026-10-22' });
    const text = store.render({ text: '生图用哪个 key 啊', limit: 4 });
    assert.equal(text, '', '不相干的判断不该硬塞进来');
  });
});

test('撞上的判断才注入', async () => {
  await withStore(async (store) => {
    await store.add({ text: '他讨厌被嘱咐', quote: '你别管我', day: '2026-10-22' });
    const text = store.render({ text: '你别嘱咐我了行不行', limit: 4 });
    assert.match(text, /讨厌被嘱咐/);
  });
});

test('只撞一个字不算相关——「图」「用」这种会把什么句子都拉进来', async () => {
  await withStore(async (store) => {
    await store.add({ text: '他讨厌被嘱咐', quote: '你别管我', day: '2026-10-22' });
    await store.add({ text: '他看界面会盯细节', quote: '面板里只有图标', day: '2026-10-27' });
    // 只跟「面板里只有图标」共享一个「图」字
    assert.equal(store.render({ text: '生图用哪个 key 啊', limit: 4 }), '');
  });
});

test('撞不上时最多留一条底线判断，而且得确认过 3 次', async () => {
  await withStore(async (store) => {
    // 只确认过一次：没资格当底线
    await store.add({ text: '他讨厌被嘱咐', quote: '你别管我', day: '2026-10-22' });
    assert.equal(store.render({ text: '生图用哪个 key 啊', limit: 4 }), '');

    // 反复确认过的：允许当底线露一次
    await store.add({ text: '他讨厌被嘱咐', quote: '说了别管', day: '2026-10-23' });
    await store.add({ text: '他讨厌被嘱咐', quote: '真的别管', day: '2026-10-24' });
    const text = store.render({ text: '生图用哪个 key 啊', limit: 4 });
    assert.match(text, /讨厌被嘱咐/);
    assert.equal(text.split('\n').filter((line) => line.startsWith('·')).length, 1, '底线判断最多一条');
  });
});

test('刚注入过的判断降权，换一条说', async () => {
  await withStore(async (store) => {
    const now = Date.now();
    await store.add({ text: '他讨厌被嘱咐', quote: '你别管我', day: '2026-10-25', at: now - 3600000 });
    await store.add({ text: '他嫌人话多', quote: '别嘱咐了，烦', day: '2026-10-26', at: now - 3600000 });
    // 第一轮只放一条：先挑分高的
    const first = store.pick({ text: '你别嘱咐我了', limit: 1, now });
    assert.equal(first.length, 1);
    const firstKey = first[0].key;
    // 第二轮同话题：刚用过的降权，换成另一条
    const second = store.pick({ text: '你别嘱咐我了', limit: 1, now: now + 60000 });
    assert.equal(second.length, 1);
    assert.notEqual(second[0].key, firstKey, '两分钟内不该反复念同一条');
  });
});

test('没给消息文本时不筛（面板/自检用）', async () => {
  await withStore(async (store) => {
    await store.add({ text: '他讨厌被嘱咐', quote: '你别管我', day: '2026-10-22' });
    assert.match(store.render({ limit: 4 }), /讨厌被嘱咐/);
  });
});
