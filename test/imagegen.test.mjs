import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPromptAllowed, buildImageUrl, ImageGen } from '../lib/imagegen.js';

test('allowed prompts pass, blocked ones are rejected', () => {
  assert.equal(assertPromptAllowed('  蓝发鲸鱼娘，女仆装  '), '蓝发鲸鱼娘，女仆装');
  for (const bad of ['色情内容', 'nude girl', '儿童色情', '卖假证', ''] ) {
    assert.throws(() => assertPromptAllowed(bad));
  }
});

test('url carries size, safe flag and encoded prompt', () => {
  const url = buildImageUrl('蓝发少女, 天台, 黄昏', { width: 512, height: 768, seed: 42 });
  assert.ok(url.includes('width=512'));
  assert.ok(url.includes('height=768'));
  assert.ok(url.includes('seed=42'));
  assert.ok(url.includes('safe=true'));
  assert.ok(url.includes(encodeURIComponent('蓝发少女, 天台, 黄昏')));
  // out of range sizes are clamped
  const clamped = buildImageUrl('x', { width: 10, height: 99999 });
  assert.ok(clamped.includes('width=256'));
  assert.ok(clamped.includes('height=1536'));
});

test('generate returns bytes from the injected fetch', async () => {
  const fakeFetch = async () => ({
    ok: true,
    headers: { get: () => 'image/png' },
    arrayBuffer: async () => new Uint8Array(4096),
  });
  const gen = new ImageGen({ fetchImpl: fakeFetch });
  const result = await gen.generate({ prompt: '一只鲸鱼', width: 512, height: 512 });
  assert.equal(result.buffer.byteLength, 4096);
  assert.equal(result.contentType, 'image/png');
  assert.ok(result.url.includes(encodeURIComponent('一只鲸鱼')));
});

test('http errors and tiny bodies surface as readable messages', async () => {
  const failing = new ImageGen({ fetchImpl: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(() => failing.generate({ prompt: '鲸鱼' }), /503/);

  const tiny = new ImageGen({ fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new Uint8Array(10) }) });
  await assert.rejects(() => tiny.generate({ prompt: '鲸鱼' }), /太小/);
});
