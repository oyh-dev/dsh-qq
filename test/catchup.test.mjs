import test from 'node:test';
import assert from 'node:assert/strict';
import { selectMissed, renderMissed } from '../lib/catchup.js';

const NOW = new Date('2026-10-28T20:00:00+08:00').getTime();
const MIN = 60000;
const row = (direction, text, minutesAgo) => ({
  direction,
  text,
  ts: new Date(NOW - minutesAgo * MIN).toISOString(),
});

test('最后一次我说话之后，他说的都算漏的', () => {
  const rows = [
    row('in', '在吗', 30),
    row('out', '在', 29),
    row('in', '今天好累', 10),
    row('in', '你睡了吗', 5),
  ];
  const missed = selectMissed(rows, { now: NOW });
  assert.equal(missed.length, 2);
  assert.match(renderMissed(missed), /今天好累/);
});

test('我已经回过就不算漏', () => {
  const rows = [row('in', '在吗', 30), row('out', '在', 29)];
  assert.equal(selectMissed(rows, { now: NOW }).length, 0);
});

test('太新的不算漏——可能正在慢慢回', () => {
  const rows = [row('in', '我回来了', 0.5)];
  assert.equal(selectMissed(rows, { now: NOW, minAgeMs: 2 * MIN }).length, 0);
  assert.equal(selectMissed(rows, { now: NOW, minAgeMs: 20000 }).length, 1);
});

test('只补最近几条，不无限回溯', () => {
  const rows = Array.from({ length: 20 }, (_, i) => row('in', `第${i}条`, i + 5));
  const missed = selectMissed(rows, { now: NOW, limit: 3 });
  assert.equal(missed.length, 3);
});

test('补漏的措辞要写清「不是你刚说的」', () => {
  const text = renderMissed([row('in', '今天好累', 10)]);
  assert.match(text, /补漏/);
  assert.match(text, /不是你刚说的/);
  assert.match(text, /别假装当时在场/);
});

test('空输入不硬造', () => {
  assert.equal(renderMissed([]), '');
  assert.equal(renderMissed(null), '');
});
