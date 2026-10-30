import test from 'node:test';
import assert from 'node:assert/strict';
import { QqBridge } from '../lib/bridge.js';

/**
 * 他 2026-10-29 的要求：重启/掉线之后，别让 bot 说「我掉线了 / 那条卡住了」。
 * 这两条路都归 `noticeReconnect` 管：补漏推送（_pushMissedInbound）和重连补偿（_sendCatchUp）。
 */
function fakeBridge({ noticeReconnect = false, catchupEnabled = true } = {}) {
  const bridge = Object.create(QqBridge.prototype);
  bridge.cfg = { catchup: { enabled: catchupEnabled } };
  bridge.noticeReconnect = noticeReconnect;
  bridge.attachmentCfg = { enabled: true };
  bridge.logs = [];
  bridge.log = (line) => bridge.logs.push(line);
  const calls = [];
  bridge.calls = calls;
  bridge.attachment = {
    noteReconnect: async (now, downtime) => {
      calls.push(['noteReconnect', downtime]);
      return { undelivered: 3 };
    },
    takeCatchUp: () => {
      calls.push(['takeCatchUp']);
      return ['一条欠着的'];
    },
    noteOutbound: () => calls.push(['noteOutbound']),
  };
  bridge.sendPrivate = async () => calls.push(['sendPrivate']);
  bridge.memory = null;
  return bridge;
}

test('默认不说掉线：重连不挂「待补」，欠账当场清掉', async () => {
  const bridge = fakeBridge();
  bridge._catchUpPending = false;
  bridge._disconnectedAt = Date.now() - 5 * 60000;

  await bridge._handleReconnect();

  assert.equal(bridge._catchUpPending, false, '不该排重连补偿');
  assert.ok(bridge.calls.some(([name]) => name === 'takeCatchUp'), '欠账要清，别攒着');
  assert.ok(bridge.logs.some((line) => line.includes('重连补偿: 断线')));
});

test('打开开关才会排重连补偿', async () => {
  const bridge = fakeBridge({ noticeReconnect: true });
  bridge._catchUpPending = false;
  bridge._disconnectedAt = Date.now() - 5 * 60000;

  await bridge._handleReconnect();

  assert.equal(bridge._catchUpPending, true);
  assert.ok(!bridge.calls.some(([name]) => name === 'takeCatchUp'), '开着开关时不能把欠账提前清掉');
});

test('默认不推补漏', async () => {
  const bridge = fakeBridge();
  const pushed = await bridge._pushMissedInbound({ force: true });
  assert.equal(pushed, 0);
});

test('总开关关掉时也不推补漏', async () => {
  const bridge = fakeBridge({ noticeReconnect: true, catchupEnabled: false });
  const pushed = await bridge._pushMissedInbound({ force: true });
  assert.equal(pushed, 0);
});

test('默认不发重连补偿那两句', async () => {
  const bridge = fakeBridge();
  bridge._catchUpPending = true;

  await bridge._sendCatchUp('1000000001');

  assert.ok(!bridge.calls.some(([name]) => name === 'sendPrivate'), '一句都不该发');
  assert.equal(bridge._catchUpPending, false);
  assert.ok(bridge.calls.some(([name]) => name === 'takeCatchUp'));
  assert.ok(bridge.logs.some((line) => line.includes('跳过')));
});

test('开着开关但写不出文案时安静收场，不抛错', async () => {
  const bridge = fakeBridge({ noticeReconnect: true });
  bridge._catchUpPending = true;
  await bridge._sendCatchUp('1000000001');
  assert.equal(bridge._catchUpPending, false);
  assert.ok(!bridge.calls.some(([name]) => name === 'sendPrivate'));
});
