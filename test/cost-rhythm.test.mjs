import test from 'node:test';
import assert from 'node:assert/strict';
import { QqBridge } from '../lib/bridge.js';

function fakeBridge({ enabled = true, start = '14:00', end = '18:00' } = {}) {
  const bridge = Object.create(QqBridge.prototype);
  bridge.cfg = { mergeWindowMs: 2600, maxMergeMs: 9000 };
  bridge.costCfg = {
    enabled,
    peakStart: start,
    peakEnd: end,
    peakProactiveMul: 0.3,
    peakMergeMs: 45000,
  };
  return bridge;
}

const at = (hhmm) => {
  const [hour, minute] = hhmm.split(':').map(Number);
  const date = new Date('2026-10-28T00:00:00+08:00');
  date.setHours(hour, minute, 0, 0);
  return date;
};

test('高峰内：主动 ×0.3，合并窗口拉长到 45 秒', () => {
  const bridge = fakeBridge();
  const cost = bridge._costNow(at('15:30'));
  assert.equal(cost.peak, true);
  assert.equal(cost.proactiveMul, 0.3);
  assert.equal(cost.mergeMs, 45000);
  assert.equal(bridge._mergeWindowMs(at('15:30')), 45000);
});

test('高峰外：不做任何事', () => {
  const bridge = fakeBridge();
  const cost = bridge._costNow(at('20:00'));
  assert.equal(cost.peak, false);
  assert.equal(cost.proactiveMul, 1);
  assert.equal(bridge._mergeWindowMs(at('20:00')), 2600, '非高峰就是原来的 2.6 秒');
});

test('关掉开关就完全不起作用', () => {
  const bridge = fakeBridge({ enabled: false });
  assert.deepEqual(bridge._costNow(at('15:30')), { peak: false, proactiveMul: 1, mergeMs: 0 });
  assert.equal(bridge._mergeWindowMs(at('15:30')), 2600);
});

test('跨零点的窗口也算对', () => {
  const bridge = fakeBridge({ start: '23:00', end: '01:00' });
  assert.equal(bridge._costNow(at('23:30')).peak, true);
  assert.equal(bridge._costNow(at('00:30')).peak, true);
  assert.equal(bridge._costNow(at('02:00')).peak, false);
});

test('合并窗口取大不取小：别的配置调大了不能被削回去', () => {
  const bridge = fakeBridge();
  bridge.cfg.mergeWindowMs = 60000;
  assert.equal(bridge._mergeWindowMs(at('15:30')), 60000);
});
