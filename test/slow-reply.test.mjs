import test from 'node:test';
import assert from 'node:assert/strict';
import { QqBridge } from '../lib/bridge.js';

/** 只造消息分流需要的那几个字段，别为了测顺序把整个插件起起来。 */
function fakeBridge({ slow = false } = {}) {
  const bridge = Object.create(QqBridge.prototype);
  bridge.holds = new Map();
  bridge.logs = [];
  bridge.order = [];
  bridge.log = (line) => bridge.logs.push(line);
  bridge.slow = slow;
  bridge._shouldSlowReply = () => bridge.slow;
  bridge._holdBlocks = (sessionId, blocks) => {
    bridge.order.push('hold');
    bridge.holds.set(sessionId, { groups: [{ blocks, at: Date.now() }], timer: null });
  };
  bridge._enqueueBlocks = () => { bridge.order.push('now'); };
  return bridge;
}

test('慢速没命中、也没在排队 → 立刻推', () => {
  const bridge = fakeBridge();
  assert.equal(bridge._dispatchBlocks('s', [{ type: 'text', text: 'a' }]), 'now');
  assert.deepEqual(bridge.order, ['now']);
});

test('只要有一条在排队，后面所有消息都跟着排——不许插队', () => {
  const bridge = fakeBridge({ slow: true });
  bridge._dispatchBlocks('s', [{ type: 'text', text: 'A' }]);
  // 第二句话即使这次骰子没命中（slow=false），也必须排在 A 后面
  bridge.slow = false;
  const route = bridge._dispatchBlocks('s', [{ type: 'text', text: 'B' }]);
  assert.equal(route, 'hold', 'B 不许抢在 A 前面');
  assert.deepEqual(bridge.order, ['hold', 'hold']);
});

test('队列放开之后恢复正常判定', () => {
  const bridge = fakeBridge({ slow: true });
  bridge._dispatchBlocks('s', [{ type: 'text', text: 'A' }]);
  bridge.holds.delete('s'); // 模拟已经 _flushHold 释放
  bridge.slow = false;
  assert.equal(bridge._dispatchBlocks('s', [{ type: 'text', text: 'B' }]), 'now');
});

test('不同会话互不影响', () => {
  const bridge = fakeBridge({ slow: true });
  bridge._dispatchBlocks('s1', [{ type: 'text', text: 'A' }]);
  bridge.slow = false;
  assert.equal(bridge._dispatchBlocks('s2', [{ type: 'text', text: 'B' }]), 'now');
});
