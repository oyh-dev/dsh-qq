import test from 'node:test';
import assert from 'node:assert/strict';
import { splitForChat, stripTrailingPeriods } from '../lib/splitter.js';

test('trailing full stops are removed, question marks survive', () => {
  assert.equal(stripTrailingPeriods('那我先试试拆条啊。'), '那我先试试拆条啊');
  assert.equal(stripTrailingPeriods('真的吗？'), '真的吗？');
  assert.equal(stripTrailingPeriods('好吧。'), '好吧');
  assert.equal(stripTrailingPeriods('我……'), '我……');
  assert.equal(stripTrailingPeriods('没有句号'), '没有句号');
  assert.equal(stripTrailingPeriods(''), '');
});

test('short replies stay in one bubble', () => {
  assert.deepEqual(splitForChat('在。'), ['在。']);
  assert.deepEqual(splitForChat(''), []);
  assert.deepEqual(splitForChat('   '), []);
});

test('paragraph replies become separate bubbles', () => {
  const text = '我在的。\n\n刚把那套拆条逻辑写完了，测试也过了。\n\n你要不要试试？';
  const parts = splitForChat(text, { maxParts: 3 });
  assert.equal(parts.length, 3);
  assert.ok(parts[0].includes('我在'));
  assert.ok(parts[2].includes('试试'));
});

test('short two-paragraph replies still split', () => {
  const parts = splitForChat('验证一下。\n\n结尾没句号了吧', { maxParts: 3, minChars: 10 });
  assert.equal(parts.length, 2);
});

test('many lines are merged down to the part budget', () => {
  const text = ['一', '二二', '三三三', '四四四四', '五五五五五'].join('\n');
  const parts = splitForChat(text, { maxParts: 2, minChars: 1 });
  assert.equal(parts.length, 2);
  assert.ok(parts[0].includes('一'));
});

test('a long single sentence is cut on sentence punctuation', () => {
  const sentence = '这句话很长'.repeat(12);
  const text = `${sentence}。${sentence}。`;
  const parts = splitForChat(text, { maxParts: 3, maxCharsPerPart: 40 });
  assert.ok(parts.length >= 2);
  for (const part of parts) assert.ok(part.length <= 120);
});

test('never returns empty bubbles', () => {
  const parts = splitForChat('a\n\n\n\nb', { maxParts: 3, minChars: 1 });
  assert.ok(parts.every((part) => part.trim().length > 0));
});
