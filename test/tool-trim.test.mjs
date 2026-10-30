import test from 'node:test';
import assert from 'node:assert/strict';
import { QqBridge } from '../lib/bridge.js';

/**
 * 工具收窄（省钱）：把她用不上的工具从**她那个会话**的工具表里摘掉。
 * 关键两条：只 deny 她真能看到的（未知名字会让 restrict 报错）、同一个会话只收一次。
 */
function fakeBridge(trim, visible) {
  const bridge = Object.create(QqBridge.prototype);
  bridge.cfg = { tools: { trim } };
  bridge.log = () => {};
  bridge.ctx = {
    get: (key) => (key === 'tools'
      ? { schemas: () => visible.map((name) => ({ name })) }
      : undefined),
  };
  return bridge;
}

function fakeAgent(record) {
  return {
    id: 'session-trim-test',
    ctx: {
      tools: {
        restrict: (filter) => {
          record.push(filter);
          return () => {};
        },
      },
    },
  };
}

test('只拦她真能看到的工具，未知名字不传下去', () => {
  const bridge = fakeBridge(['sd_txt2img', '不存在的工具'], ['sd_txt2img', 'qq_send_message']);
  const record = [];
  bridge._installToolTrim(fakeAgent(record));
  assert.equal(record.length, 1);
  assert.deepEqual(record[0].deny, ['sd_txt2img']);
});

test('同一个会话只收一次（重复调用不叠加）', () => {
  const bridge = fakeBridge(['sd_txt2img'], ['sd_txt2img']);
  const record = [];
  const agent = fakeAgent(record);
  bridge._installToolTrim(agent);
  bridge._installToolTrim(agent);
  assert.equal(record.length, 1);
});

test('全都不在可见范围时不动手，也不报错', () => {
  const bridge = fakeBridge(['sd_txt2img'], ['qq_send_message']);
  const record = [];
  bridge._installToolTrim(fakeAgent(record));
  assert.equal(record.length, 0);
});

test('trim 配置为空就完全跳过', () => {
  const bridge = fakeBridge([], ['sd_txt2img']);
  const record = [];
  bridge._installToolTrim(fakeAgent(record));
  assert.equal(record.length, 0);
});

test('restrict 抛错也不影响聊天（只记日志）', () => {
  const bridge = fakeBridge(['sd_txt2img'], ['sd_txt2img']);
  const logs = [];
  bridge.log = (line) => logs.push(line);
  const agent = { id: 'session-boom', ctx: { tools: { restrict: () => { throw new Error('boom'); } } } };
  assert.doesNotThrow(() => bridge._installToolTrim(agent));
  assert.ok(logs.some((line) => /收窄工具失败/.test(line)));
});
