import test from 'node:test';
import assert from 'node:assert/strict';
import { QqBridge } from '../lib/bridge.js';
import { computeMood } from '../lib/mood.js';

/**
 * 接线测试：`_noteOwnerInbound` 到底有没有把心情拨起来。
 *
 * 2026-10-29 之前的真实问题：`praised` / `replied` / `scolded` / `teased` 四个信号在
 * MOOD_SIGNALS 里躺着，bridge.js 里零处调用——好好聊天对心情零影响，面板永远在基线附近。
 */
function fakeBridge({ attachmentEnabled = true } = {}) {
  const bridge = Object.create(QqBridge.prototype);
  const fired = [];
  bridge.fired = fired;
  bridge.mood = computeMood({ events: [], now: Date.now() });
  bridge._touchMood = (signal, weight = 1) => fired.push({ signal, weight });
  bridge.attachmentCfg = { enabled: attachmentEnabled };
  bridge.attachment = { noteInbound: () => {} };
  bridge._localDay = () => '2026-10-29';
  bridge._praiseAt = 0;
  bridge._leaveAt = 0;
  return bridge;
}

const signals = (bridge) => bridge.fired.map((item) => item.signal);

test('他随便说一句话 → 记一次「他回来了」', () => {
  const bridge = fakeBridge();
  bridge._noteOwnerInbound('在吗');
  assert.deepEqual(signals(bridge), ['replied']);
});

test('两分钟内的连发只算一次（手速不该把情绪顶满）', () => {
  const bridge = fakeBridge();
  bridge._noteOwnerInbound('在吗');
  bridge._noteOwnerInbound('在干嘛');
  bridge._noteOwnerInbound('喂');
  assert.equal(signals(bridge).filter((s) => s === 'replied').length, 1);
});

test('夸她、嫌她、逗她、顺她，各拨各的', () => {
  const praised = fakeBridge();
  praised._noteOwnerInbound('你好厉害啊');
  assert.ok(signals(praised).includes('praised'));

  const scolded = fakeBridge();
  scolded._noteOwnerInbound('你像客服');
  assert.ok(signals(scolded).includes('scolded'));

  const teased = fakeBridge();
  teased._noteOwnerInbound('哈哈哈你尾巴翘起来了');
  assert.ok(signals(teased).includes('teased'));

  const agreed = fakeBridge();
  agreed._noteOwnerInbound('行，听你的');
  assert.ok(signals(agreed).includes('agreed'));
});

test('普通话不该被误判成夸或嫌', () => {
  const bridge = fakeBridge();
  bridge._noteOwnerInbound('今天想吃啥');
  assert.deepEqual(signals(bridge), ['replied']);
});

test('粘人层关掉也照样拨心情（以前的 early return 会把它一起吞掉）', () => {
  const bridge = fakeBridge({ attachmentEnabled: false });
  bridge._noteOwnerInbound('你真聪明');
  assert.ok(signals(bridge).includes('praised'));
  assert.ok(signals(bridge).includes('replied'));
});

test('空消息不拨', () => {
  const bridge = fakeBridge();
  bridge._noteOwnerInbound('   ');
  assert.deepEqual(signals(bridge), []);
});
