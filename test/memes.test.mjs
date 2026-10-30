import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { MemeBook } from '../lib/memes.js';

async function withBook(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-memes-'));
  try {
    const book = new MemeBook({ file: path.join(dir, 'memes.json') });
    await book.load();
    await run(book, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('meme book saves, dedupes and reloads', async () => {
  await withBook(async (book, dir) => {
    const first = await book.add({ name: '示例梗甲', meaning: '第一种解释' });
    assert.equal(first.created, true);
    const second = await book.add({ name: ' 示例梗甲 ', usage: '某个场景里用' });
    assert.equal(second.created, false);
    assert.equal(second.entry.usage, '某个场景里用');
    assert.equal(book.count(), 1);

    const reloaded = new MemeBook({ file: path.join(dir, 'memes.json') });
    await reloaded.load();
    assert.equal(reloaded.count(), 1);
    assert.equal(reloaded.entries[0].meaning, '第一种解释');
  });
});

test('meme book search and cheat sheet stay compact', async () => {
  await withBook(async (book) => {
    await book.add({ name: '示例梗甲', meaning: '第一种解释', usage: '某个场景里用' });
    await book.add({ name: '示例梗乙', meaning: '第二种解释', usage: '另一个场景' });
    const hits = book.search('示例梗乙');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].name, '示例梗乙');
    assert.equal(book.search('不存在的东西').length, 0);
    const sheet = book.cheatSheet(5, 200);
    assert.ok(sheet.includes('示例梗甲'));
    assert.ok(sheet.length <= 200);
  });
});
