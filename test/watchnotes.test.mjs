import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { WatchNotes } from '../lib/watchnotes.js';
import { normalizeTranscript } from '../lib/asr.js';

async function withNotes(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-watch-'));
  try {
    const notes = new WatchNotes({ dir });
    await notes.load();
    await run(notes, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('视频笔记独立存放，能存能查能按关键词命中', async () => {
  await withNotes(async (notes) => {
    await notes.add({
      kind: 'bili',
      bvid: 'BV1xx411c7mD',
      title: '一个测试视频',
      author: '某UP',
      duration: 180,
      day: '2026-10-28',
      source: 'asr',
      chars: 1200,
      points: ['讲的是相机怎么用', '结论是别乱买'],
      memes: ['示例梗甲'],
    });
    await notes.add({
      kind: 'meme',
      bvid: 'BV1yy411c7mE',
      title: '梗百科测试',
      author: '某UP',
      duration: 90,
      day: '2026-10-28',
      source: 'none',
      points: ['讲了一个梗的来历'],
      memes: ['示例梗乙'],
    });
    assert.equal(notes.stats().total, 2);
    assert.equal(notes.stats().withAudio, 1);

    // 标题、要点、梗名都能搜到
    assert.equal(notes.search('相机').length, 1);
    assert.equal(notes.search('示例梗乙')[0].bvid, 'BV1yy411c7mE');
    assert.equal(notes.search('完全不相干的东西').length, 0);

    assert.equal(notes.get('BV1xx411c7mD').points.length, 2);
    assert.equal(notes.list(1).length, 1);
  });
});

test('同一条视频只留一份笔记，重新写会覆盖', async () => {
  await withNotes(async (notes) => {
    await notes.add({ kind: 'bili', bvid: 'BV1aaa', title: '旧标题', points: ['旧要点'] });
    await notes.add({ kind: 'bili', bvid: 'BV1aaa', title: '新标题', points: ['新要点'] });
    assert.equal(notes.entries.length, 1);
    assert.equal(notes.get('BV1aaa').title, '新标题');
    assert.deepEqual(notes.get('BV1aaa').points, ['新要点']);
  });
});

test('没看完就关掉会记下来（看到第几张 / 一共几张）', async () => {
  await withNotes(async (notes, dir) => {
    await notes.add({
      kind: 'bili',
      bvid: 'BV1half',
      title: '看了两张就关掉的视频',
      points: ['讲了一半'],
      shown: 2,
      total: 6,
      partial: true,
    });
    const entry = notes.get('BV1half');
    assert.equal(entry.partial, true);
    assert.equal(entry.shown, 2);
    assert.equal(entry.total, 6);

    // 重新读盘也要保住这几个字段（不然「她没看完」这件事就丢了）
    const reloaded = new WatchNotes({ dir });
    await reloaded.load();
    assert.equal(reloaded.get('BV1half').partial, true);
    assert.equal(reloaded.get('BV1half').total, 6);
  });
});

test('看完的那条 partial 是 false', async () => {
  await withNotes(async (notes) => {
    await notes.add({ kind: 'bili', bvid: 'BV1full', title: '看完的', shown: 6, total: 6, partial: false });
    assert.equal(notes.get('BV1full').partial, false);
  });
});

test('原始音频/字幕是用完就删的临时文件', async () => {
  await withNotes(async (notes, dir) => {
    const file = await notes.saveRaw('BV1aaa', 'wav', 'fake');
    assert.ok(file.includes('raw'));
    let files = await readdir(path.join(dir, 'raw'));
    assert.deepEqual(files, ['BV1aaa.wav']);
    await notes.dropRaw('BV1aaa', 'wav');
    files = await readdir(path.join(dir, 'raw'));
    assert.deepEqual(files, []);
  });
});

test('笔记库只留最近的一批，多的连文件一起清', async () => {
  await withNotes(async (notes) => {
    for (let i = 0; i < 5; i += 1) {
      await notes.add({ kind: 'bili', bvid: `BV1t${i}`, title: `视频 ${i}`, ts: 1000 + i });
    }
    const dropped = await notes.prune(2);
    assert.equal(dropped, 3);
    assert.equal(notes.entries.length, 2);
  });
});

test('whisper 输出里的时间戳会被清掉', () => {
  const raw = [
    '[00:00:00.000 --> 00:00:02.400] 大家好',
    '[00:00:02.400 --> 00:00:05.000] 今天讲个视频',
    '',
    '[00:00:05.000 --> 00:00:07.000]   测试一下',
  ].join('\n');
  assert.equal(normalizeTranscript(raw), '大家好 今天讲个视频 测试一下');
  assert.equal(normalizeTranscript(''), '');
  assert.equal(normalizeTranscript(null), '');
});
