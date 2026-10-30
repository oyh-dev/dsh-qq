import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ENERGY_MAX,
  ENERGY_LOW,
  ENERGY_MILD,
  recoverEnergy,
  spendEnergy,
  energyEffects,
  energyFacts,
} from '../lib/energy.js';

test('恢复不越界，消耗不穿底', () => {
  assert.equal(recoverEnergy(0.5, 10), ENERGY_MAX, '再久也回不满 1 以上');
  assert.equal(spendEnergy(0.02, 0.5), 0, '不会扣成负数');
});

test('静默半天大概能回一大半', () => {
  assert.ok(recoverEnergy(0.2, 3) > 0.5, '3 小时该回一半以上');
  assert.ok(recoverEnergy(0.2, 1) < recoverEnergy(0.2, 3));
});

test('高能量不加成——不累只是正常，不是精神好', () => {
  for (const level of [1, 0.85, ENERGY_MILD]) {
    const e = energyEffects(level);
    assert.equal(e.proactiveMul, 1, `level=${level} 不该有增益`);
    assert.equal(e.nagMul, 1);
    assert.equal(e.low, false);
  }
});

test('低电量：主动压到 0.3、粘连归零，但绝不为 0 主动', () => {
  const e = energyEffects(0.12);
  assert.equal(e.low, true);
  assert.equal(e.nagMul, 0, '累的时候不该闹人');
  assert.ok(e.proactiveMul > 0, '再累也不能完全不找他——冷落是底线');
  assert.equal(e.proactiveMul, 0.3);
  assert.ok(e.moodBias.A < 0 && e.moodBias.P < 0 && e.moodBias.D > 0);
});

test('中间档：有点影响但不进低功耗', () => {
  const e = energyEffects(0.45);
  assert.equal(e.low, false);
  assert.equal(e.mild, true);
  assert.ok(e.nagMul > 0 && e.nagMul < 1);
});

test('状态事实只给计数，不给分数', () => {
  const line = energyFacts({ turnsToday: 312, baselineTurns: 130, hoursSinceRest: 3 });
  assert.match(line, /312 条/);
  assert.match(line, /日均 130 条/);
  assert.ok(!/\d\.\d{2}/.test(line), `不许出现小数分数：${line}`);
  assert.ok(!/能量|疲劳|低功耗/.test(line), `不许出现机制名：${line}`);
});

test('刚睡醒、或者今天没怎么聊，就不说', () => {
  assert.equal(energyFacts({ turnsToday: 300, hoursSinceRest: 8 }), '');
  assert.equal(energyFacts({ turnsToday: 5, hoursSinceRest: 2 }), '');
});
