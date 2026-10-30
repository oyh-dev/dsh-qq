import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { DiaryStore } from '../lib/diary.js';

async function withDiary(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-diary-'));
  try {
    await run(new DiaryStore({ dir }), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('diary appends per day and reads back', async () => {
  await withDiary(async (diary) => {
    const at = new Date('2026-10-20T18:18:00');
    const first = await diary.append({ text: '今天找到一点喜欢的声音。', mood: '期待', tags: ['声音'], at });
    assert.equal(first.day, '2026-10-20');
    assert.ok(first.file.endsWith('2026-10-20.md'));
    await diary.append({ text: '他把锅扣我头上了。', mood: '好笑', at });
    const day = await diary.read('2026-10-20');
    assert.ok(day.text.includes('找到一点喜欢的声音'));
    assert.ok(day.text.includes('#声音'));
    assert.ok(day.text.includes('锅'));
    const recent = await diary.recent(3);
    assert.equal(recent[0].entries.length, 2);
  });
});

test('diary search finds lines across days and empty days read clean', async () => {
  await withDiary(async (diary) => {
    await diary.append({ text: '今天的事情还没做完', at: new Date('2026-10-19T10:00:00') });
    await diary.append({ text: '那件事终于有结果了', at: new Date('2026-10-20T10:00:00') });
    const hits = await diary.search('事情');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].date, '2026-10-19');
    const empty = await diary.read('2026-01-01');
    assert.equal(empty.text, '');
    assert.deepEqual(await diary.search(''), []);
    const stats = await diary.stats();
    assert.equal(stats.days, 2);
  });
});

test('empty diary entry is rejected', async () => {
  await withDiary(async (diary) => {
    await assert.rejects(() => diary.append({ text: '   ' }));
  });
});
