import test from 'node:test';
import assert from 'node:assert/strict';
import { pickDelayMs, pickShortReply } from '../lib/humanize.js';

test('delay stays inside the configured window', () => {
  for (const value of [0, 0.24, 0.5, 0.99]) {
    const ms = pickDelayMs({ min: 800, max: 4200 }, () => value);
    assert.ok(ms >= 800 && ms <= 4200, `got ${ms}`);
  }
  assert.equal(pickDelayMs({ min: 1000, max: 1000 }), 1000);
  assert.equal(pickDelayMs({}, () => 0), 800);
});

test('degenerate ranges never throw or go negative', () => {
  assert.equal(pickDelayMs({ min: -50, max: -10 }), 0);
  assert.equal(pickDelayMs({ min: 50, max: 10 }), 50);
});

test('short reply comes from the configured pool', () => {
  const reply = pickShortReply({ shortReplies: ['嗯', '行'] }, () => 0.9);
  assert.ok(['嗯', '行'].includes(reply));
  assert.ok(typeof pickShortReply({}) === 'string');
});
