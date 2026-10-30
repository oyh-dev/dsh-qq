import test from 'node:test';
import assert from 'node:assert/strict';

import { QqBridge } from '../lib/bridge.js';

/**
 * 出站归档的回归测试。
 *
 * 背景：2026-10-26 发现主动消息（_proactiveTick → sendPrivate → _sendSegments）
 * 从来不写 memory/raw，因为归档只在 sendMessage 里做。结果记忆里缺我自己那一半，
 * 10-25 21:07「咕噜 突然有点想你了」就是这么丢的。
 *
 * 现在归档挪到 _sendSegments 这个唯一出口，这里守住两件事：
 *   1. 任何走 _sendSegments 的发送都会进记忆
 *   2. 系统提示类（熔断告警、授权请求）显式 archive:false 时不进记忆
 */

function makeBridge() {
  const captured = [];
  const bridge = Object.create(QqBridge.prototype);
  bridge.client = { call: async () => ({ message_id: 'mid-1' }) };
  bridge.cfg = { sendGuard: { allowOwnerLinks: false } };
  bridge.guard = {
    assertContent() {},
    assertNotDuplicate() {},
    async waitTurn() {},
    recordSuccess() {},
  };
  bridge.attachment = { noteOutbound() {} };
  bridge.memory = {
    record: async (row) => { captured.push(row); },
  };
  bridge.selfId = '1000000002';
  bridge.nickname = 'TestBot';
  bridge._logChat = () => {};
  return { bridge, captured };
}

test('sendPrivate 的出站消息会写进记忆归档', async () => {
  const { bridge, captured } = makeBridge();
  await bridge.sendPrivate('1000000001', [{ type: 'text', data: { text: '咕噜 突然有点想你了' } }]);

  assert.equal(captured.length, 1, '主动消息也必须归档');
  assert.equal(captured[0].direction, 'out');
  assert.equal(captured[0].chatType, 'private');
  assert.equal(captured[0].chatId, '1000000001');
  assert.equal(captured[0].fromId, '1000000002');
  assert.match(captured[0].text, /突然有点想你了/);
  assert.equal(captured[0].messageId, 'mid-1');
});

test('归档的是真正发出去的文本（去掉了句尾句号）', async () => {
  const { bridge, captured } = makeBridge();
  await bridge.sendPrivate('1000000001', [{ type: 'text', data: { text: '那就一起发呆。' } }]);

  assert.equal(captured.length, 1);
  assert.equal(captured[0].text, '那就一起发呆');
});

test('archive:false 的发送（熔断告警/授权请求）不进记忆', async () => {
  const { bridge, captured } = makeBridge();
  await bridge.sendPrivate('1000000001', [{ type: 'text', data: { text: '发送守卫熔断' } }], { archive: false, bypass: true });

  assert.equal(captured.length, 0);
});

test('sendGroup 的出站消息也会写进记忆归档', async () => {
  const { bridge, captured } = makeBridge();
  await bridge.sendGroup('1005419617', [{ type: 'text', data: { text: '这版本太牢了' } }]);

  assert.equal(captured.length, 1);
  assert.equal(captured[0].chatType, 'group');
  assert.equal(captured[0].chatId, '1005419617');
});

test('没有 memory 时不会炸', async () => {
  const { bridge } = makeBridge();
  bridge.memory = undefined;
  const result = await bridge.sendPrivate('1000000001', [{ type: 'text', data: { text: '测试' } }]);
  assert.equal(result.ok, true);
});
