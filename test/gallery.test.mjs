import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { GalleryStore } from '../lib/gallery.js';

function png(size = 2000) {
  const bytes = Buffer.alloc(size, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(640, 16);
  bytes.writeUInt32BE(480, 20);
  return bytes;
}

async function withGallery(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-gallery-'));
  try {
    const gallery = new GalleryStore({
      dir,
      getSize: async () => ({ width: 640, height: 480 }),
    });
    await gallery.load();
    await run(gallery, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('gallery stores images with metadata and dedupes', async () => {
  await withGallery(async (gallery) => {
    const bytes = png();
    const first = await gallery.add({
      bytes,
      mediaType: 'image/png',
      meta: { day: '2026-10-20', chatId: '1000000001', fromName: '测试用户', context: '第一张测试图' },
    });
    assert.equal(first.created, true);
    assert.equal(first.entry.width, 640);

    const again = await gallery.add({ bytes, mediaType: 'image/png', meta: { day: '2026-10-21' } });
    assert.equal(again.created, false);
    assert.equal(gallery.entries.length, 1);

    const different = await gallery.add({ bytes: png(3000), mediaType: 'image/png', meta: { day: '2026-10-21' } });
    assert.equal(different.created, true);
    assert.equal(gallery.entries.length, 2);
  });
});

test('gallery search matches caption, context, tags and date range', async () => {
  await withGallery(async (gallery) => {
    await gallery.add({ bytes: png(4000), mediaType: 'image/png', meta: { day: '2026-10-18', context: '一张带文字的截图' } });
    await gallery.add({ bytes: png(5000), mediaType: 'image/png', meta: { day: '2026-10-20', context: '一张猫的照片' } });

    assert.equal(gallery.search({ query: '截图' }).length, 1);
    assert.equal(gallery.search({ query: '猫' })[0].day, '2026-10-20');
    assert.equal(gallery.search({ from: '2026-10-19' }).length, 1);
    assert.equal(gallery.search({ to: '2026-10-18' }).length, 1);
    assert.equal(gallery.search({ query: '不存在' }).length, 0);

    const entry = gallery.search({ query: '截图' })[0];
    await gallery.note(entry.hash, { caption: '一张截图', tags: ['截图'] });
    assert.equal(gallery.search({ query: '一张截图' }).length, 1);
    assert.equal(gallery.search({ query: '截图' })[0].hash, entry.hash);
  });
});

test('gallery rejects oversized images and unknown notes', async () => {
  await withGallery(async (gallery) => {
    const small = new GalleryStore({ dir: path.join(path.dirname(gallery.dir), 'tiny'), maxBytes: 64 * 1024 });
    await assert.rejects(() => small.add({ bytes: Buffer.alloc(200 * 1024, 1), mediaType: 'image/png' }), /图片太大/);
    await assert.rejects(() => gallery.note('no-such-image', { caption: 'x' }), /找不到/);
  });
});
