import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { StickerStore } from '../lib/stickers.js';

/** Tiny valid PNG so byte-level gates behave like the real thing. */
function fakeImage(size = 6000) {
  const bytes = Buffer.alloc(size, 1);
  // PNG signature + IHDR width/height 300x300
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(300, 16);
  bytes.writeUInt32BE(300, 20);
  return bytes;
}

async function withStore(run, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-stickers-'));
  try {
    const store = new StickerStore({
      dir,
      getSize: async () => ({ width: 300, height: 300 }),
      dailyLimit: options.dailyLimit ?? 3,
      totalLimit: options.totalLimit ?? 200,
    });
    await store.load();
    await run(store, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('sticker store only keeps real stickers that pass the value score', async () => {
  await withStore(async (store) => {
    const plain = await store.consider({ bytes: fakeImage(), mediaType: 'image/png', dayKey: '2026-10-20' });
    assert.equal(plain.saved, false);
    assert.equal(plain.reason, 'not-sticker');

    const animated = await store.consider({
      bytes: fakeImage(7000), mediaType: 'image/gif', animated: true, dayKey: '2026-10-20',
    });
    assert.equal(animated.saved, true);
    assert.equal(animated.score, 2);

    const again = await store.consider({
      bytes: fakeImage(7000), mediaType: 'image/gif', animated: true, dayKey: '2026-10-20',
    });
    assert.equal(again.saved, false);
    assert.equal(again.reason, 'duplicate');
  });
});

test('sticker store enforces the daily quota and survives a reload', async () => {
  await withStore(async (store, dir) => {
    const first = await store.consider({ bytes: fakeImage(8000), mediaType: 'image/gif', animated: true, dayKey: '2026-10-20' });
    assert.equal(first.saved, true);
    const second = await store.consider({ bytes: fakeImage(9000), mediaType: 'image/gif', animated: true, dayKey: '2026-10-20' });
    assert.equal(second.saved, false);
    assert.equal(second.reason, 'daily-quota');

    // Next day the quota rolls over.
    const nextDay = await store.consider({ bytes: fakeImage(10000), mediaType: 'image/gif', animated: true, dayKey: '2026-10-21' });
    assert.equal(nextDay.saved, true);

    const reloaded = new StickerStore({ dir, getSize: async () => ({ width: 300, height: 300 }) });
    await reloaded.load();
    assert.equal(reloaded.count(), 2);
  }, { dailyLimit: 1 });
});

test('manual stickers are searchable by name and hash prefix', async () => {
  await withStore(async (store) => {
    const { created, entry } = await store.add({
      bytes: fakeImage(12000), mediaType: 'image/png', name: '竖大拇指', tags: ['嘲讽', '可爱'],
    });
    assert.equal(created, true);
    assert.equal(store.find('竖大拇指')?.hash, entry.hash);
    assert.equal(store.find('嘲讽')?.hash, entry.hash);
    assert.equal(store.find(entry.hash.slice(0, 8))?.hash, entry.hash);
    assert.equal(store.find('不存在'), null);
    assert.equal(store.search('嘲讽').length, 1);
    const duplicate = await store.add({ bytes: fakeImage(12000), mediaType: 'image/png', name: '重复' });
    assert.equal(duplicate.created, false);
  });
});
