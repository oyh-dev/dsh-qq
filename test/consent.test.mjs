import test from 'node:test';
import assert from 'node:assert/strict';
import { ConsentBook, extractTopic, LOCK_DAYS } from '../lib/consent.js';

/** 拒绝锁定 + 一次申请权（2026-10-30）。 */

const DAY = 24 * 3600000;
const T0 = new Date(2026, 9, 30, 11, 0, 0).getTime();

test('从拒绝的话里抽出主题词', () => {
  assert.deepEqual(extractTopic('别又是脱衣服那套'), ['脱衣服']);
  const topics = extractTopic('（把骰子放下）别又是脱衣服那套，说了那条我不接');
  assert.ok(topics.includes('脱衣服'), `抽出来的是 ${topics.join('/')}`);
});

test('拒绝之后锁 7 天：期间再提算「被磨」', () => {
  const book = new ConsentBook();
  book.refuse('别又是脱衣服那套', T0);
  const hit = book.check('来，脱衣服', T0 + DAY);
  assert.equal(hit.pressed.length, 1);
  assert.equal(hit.askable.length, 0);
  assert.match(book.facts(T0 + DAY)[0], /还有 6 天/);
});

test('锁期过了就变成「可以正式问一次」', () => {
  const book = new ConsentBook();
  book.refuse('别又是脱衣服那套', T0);
  const later = T0 + (LOCK_DAYS + 1) * DAY;
  const hit = book.check('脱衣服吧', later);
  assert.equal(hit.pressed.length, 0);
  assert.equal(hit.askable.length, 1);
  assert.match(book.facts(later)[0], /可以正式问/);
});

test('答"不"再锁一轮，答"行"就从名单里去掉', () => {
  const book = new ConsentBook();
  const item = book.refuse('别又是脱衣服那套', T0);
  const unlocked = T0 + (LOCK_DAYS + 1) * DAY;
  const no = book.answer(item.topic, false, unlocked);
  assert.equal(no.ok, false);
  assert.ok(no.lockedUntil > unlocked + 6 * DAY, '又锁 7 天');
  const yes = book.answer(item.topic, true, unlocked);
  assert.equal(yes.ok, true);
  assert.equal(book.items.length, 0, '答行之后这件事不再被锁');
});

test('不相关的话不会误触', () => {
  const book = new ConsentBook();
  book.refuse('别又是脱衣服那套', T0);
  const hit = book.check('今天吃什么', T0 + DAY);
  assert.equal(hit.pressed.length + hit.askable.length, 0);
});

test('多条拒绝都记得，最多留 12 条', () => {
  const book = new ConsentBook();
  for (let i = 0; i < 20; i += 1) book.refuse(`这个玩法${i}号我不接`, T0);
  assert.ok(book.items.length <= 12);
});
