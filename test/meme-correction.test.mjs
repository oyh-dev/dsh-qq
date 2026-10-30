import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { MemeBook, MEME_BLOCK_HOURS } from '../lib/memes.js';
import { MOOD_SIGNALS, applySignal, computeMood } from '../lib/mood.js';

async function withBook(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-meme-fix-'));
  try {
    const book = new MemeBook({ file: path.join(dir, 'memes.json') });
    await book.load();
    await run(book, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('被否一次就降级并锁一天，用对两次才解锁', async () => {
  await withBook(async (book) => {
    await book.add({ name: '示例梗甲', meaning: '某个方言词的意思', usage: '闲聊里随口用' });
    const wrong = await book.markWrong('示例梗甲', { quote: '这句用得不对' });
    assert.equal(wrong.status, 'doubt');
    assert.equal(wrong.wrongCount, 1);
    assert.equal(wrong.lastCorrection, '这句用得不对');
    const blockMs = wrong.blockedUntil - Date.now();
    assert.ok(blockMs > (MEME_BLOCK_HOURS - 1) * 3600000, '禁期应该是 24 小时左右');
    assert.deepEqual(book.stats(), { total: 1, doubt: 1, blocked: 1 });

    // 用对一次还不够——一次可能是运气
    await book.markOk('示例梗甲');
    assert.equal(book.entries[0].status, 'doubt');
    assert.ok(book.entries[0].blockedUntil > Date.now());

    // 用对两次才回到 ok，并且解禁
    await book.markOk('示例梗甲');
    assert.equal(book.entries[0].status, 'ok');
    assert.equal(book.entries[0].blockedUntil, 0);
    assert.equal(book.entries[0].okCount, 2);
  });
});

test('两种说法打架时不再静默覆盖：旧说法进 history，状态升 conflict', async () => {
  await withBook(async (book) => {
    await book.add({ name: '示例梗乙', meaning: '第一种解释：形容人爱吹嘘，口气很大' });
    const merged = await book.add({ name: '示例梗乙', meaning: '第二种解释：指皮肤过敏起红点，跟吹牛没关系' });
    assert.equal(merged.created, false);
    assert.equal(merged.conflicted, true);
    assert.equal(merged.entry.status, 'conflict');
    assert.equal(merged.entry.history.length, 1);
    assert.match(merged.entry.history[0].meaning, /吹嘘/);
    assert.match(merged.entry.meaning, /过敏/);
  });
});

test('同一个意思换个说法算补充，不算打架', async () => {
  await withBook(async (book) => {
    await book.add({ name: '示例梗丙', meaning: '某款游戏的圈子简称，玩这游戏就叫打它' });
    const merged = await book.add({ name: '示例梗丙', meaning: '那款游戏在圈内的简称，常说打它' });
    assert.equal(merged.conflicted, false);
    assert.equal(merged.entry.status, 'ok');
    assert.equal(merged.entry.history.length, 0);
    assert.equal(merged.entry.usage, '');
  });
});

test('她能认出自己句子里用了哪几个梗', async () => {
  await withBook(async (book) => {
    await book.add({ name: '示例梗甲', meaning: '第一种意思' });
    await book.add({ name: '示例梗乙', meaning: '第二种意思' });
    const hits = book.matchIn('今天遇到示例梗甲，又想到示例梗乙');
    assert.deepEqual(hits.map((item) => item.name).sort(), ['示例梗乙', '示例梗甲'].sort());
    assert.equal(book.matchIn('一句根本没提到梗的话').length, 0);
  });
});

test('纠正带来的正收益明显大于被反驳的负收益', () => {
  assert.ok(MOOD_SIGNALS.memeWrong && MOOD_SIGNALS.memeLearned);
  assert.ok(
    MOOD_SIGNALS.memeLearned.P > Math.abs(MOOD_SIGNALS.memeWrong.P) * 2,
    '正收益要至少是负收益的两倍，否则一天被否两次就爬不回来',
  );
  const base = computeMood({ events: [], now: Date.now() });
  const afterWrong = applySignal(base, 'memeWrong', { weight: 0.6 });
  const afterLearn = applySignal(base, 'memeLearned', { weight: 0.5 });
  assert.ok(afterWrong.P < base.P, '被否要真的掉一点，不能装作没事');
  assert.ok(afterLearn.P > base.P, '学明白要真的涨');
  assert.ok(afterLearn.P - base.P > base.P - afterWrong.P, '涨的要比掉的多');
});
