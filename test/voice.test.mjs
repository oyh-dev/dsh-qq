import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanForSpeech } from '../lib/voice.js';

test('voice text is cleaned before being read out', () => {
  assert.equal(cleanForSpeech('  你好  '), '你好');
  assert.equal(cleanForSpeech('看这个 https://example.com/x 挺好'), '看这个 挺好');
  assert.equal(cleanForSpeech('**加粗**和`代码`'), '加粗和代码');
  assert.equal(cleanForSpeech('高兴 😀 哈哈'), '高兴 哈哈');
  assert.equal(cleanForSpeech('[链接](https://a.b) 点这里'), '链接 点这里');
  assert.equal(cleanForSpeech('(笑) 好吧'), '好吧');
  assert.equal(cleanForSpeech(''), '');
  assert.equal(cleanForSpeech(null), '');
});

test('voice text keeps normal punctuation and Chinese', () => {
  const text = '喂，今天有点想你了，别赖床太久——听见没？';
  assert.equal(cleanForSpeech(text), text);
});
