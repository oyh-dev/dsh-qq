import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScoreJson } from '../lib/bridge.js';

test('正常输出照常解析', () => {
  const raw = '[{"at":"10:50","intensity":0.5}]';
  assert.equal(parseScoreJson(raw).length, 1);
});

test('带围栏、带前后废话也能解析', () => {
  const raw = '好的，结果如下：\n```json\n[{"at":"10:50","intensity":0.5}]\n```\n以上。';
  assert.equal(parseScoreJson(raw).length, 1);
});

test('被 token 上限截断时，前面完整的几条要捞回来（不许整窗丢）', () => {
  const raw = '[{"at":"10:50","intensity":0.5,"trigger":"a"},{"at":"11:20","intensity":0.6,"trigger":"b"},{"at":"12:0';
  const items = parseScoreJson(raw);
  assert.equal(items.length, 2, `应该保住两条，实际 ${items.length}`);
  assert.equal(items[1].trigger, 'b');
});

test('结尾是半条也不影响前面，字符串里的括号不会算错', () => {
  const raw = '[{"at":"09:10","trigger":"他说「{这不是括号}」"},{"at":"09:20","intensity":0.';
  const items = parseScoreJson(raw);
  assert.equal(items.length, 1);
  assert.equal(items[0].trigger, '他说「{这不是括号}」');
});

test('彻底没有数组就返回空，不硬造', () => {
  assert.deepEqual(parseScoreJson('模型什么都没说'), []);
  assert.deepEqual(parseScoreJson(''), []);
});
