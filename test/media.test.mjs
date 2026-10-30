import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { MediaStore, detectImageType, guessTypeByName } from '../lib/media.js';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);

test('image type detection and name fallback', () => {
  assert.equal(detectImageType(PNG)?.mediaType, 'image/png');
  assert.equal(detectImageType(Buffer.from('nope')), null);
  assert.equal(guessTypeByName('a.JPG'), 'image/jpeg');
  assert.equal(guessTypeByName('a.avif'), '');
  assert.equal(guessTypeByName(''), '');
});

test('saveAttachment uses sniffed type, then name, then ffmpeg fallback', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-media-'));
  try {
    const store = new MediaStore({ dir, ffmpeg: 'definitely-not-ffmpeg' });
    const saved = [];
    const attachments = { saveImage: async (payload) => { saved.push(payload); return { id: 'x' }; } };

    await store.saveAttachment(attachments, PNG, { name: 'a.png' });
    assert.equal(saved[0].mediaType, 'image/png');

    await store.saveAttachment(attachments, Buffer.from('garbage'), { name: 'b.jpg' });
    assert.equal(saved[1].mediaType, 'image/jpeg');

    await assert.rejects(
      () => store.saveAttachment(attachments, Buffer.from('garbage'), { name: 'c.avif' }),
      /无法识别的图片格式/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
