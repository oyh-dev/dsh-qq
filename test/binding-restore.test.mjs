import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { readFile, unlink } from 'node:fs/promises';
import { QqBridge } from '../lib/bridge.js';

/** 造一个只有绑定相关字段的假桥，避免为了测两行逻辑去起整个插件。 */
function fakeBridge({ bindings = [], agents = new Map() } = {}) {
  const bridge = Object.create(QqBridge.prototype);
  bridge.state = { bindings };
  bridge.bindings = new Map();
  bridge.ctx = { agents: { get: (id) => agents.get(id) } };
  bridge.logs = [];
  bridge.log = (line) => bridge.logs.push(line);
  bridge._saveState = async () => {};
  bridge._installMemoryContext = (agent, binding) => {
    binding.memoryDisposer = () => {};
  };
  return bridge;
}

test('恢复的绑定 types 是 Set，_forward 的 .has 不会炸', () => {
  const bridge = fakeBridge({ bindings: [{ sessionId: 'session-a', types: ['private'] }] });
  bridge._restoreBindings();
  const binding = bridge.bindings.get('session-a');
  assert.ok(binding, '绑定应该被记住');
  assert.equal(typeof binding.types.has, 'function', '必须是 Set，数组会让 .has 抛错');
  assert.equal(binding.types.has('private'), true);
  assert.equal(binding.types.has('group'), false);
  assert.equal(binding.pending, true);
});

test('快照恢复出来的绑定同样是 Set', () => {
  const bridge = fakeBridge();
  bridge.state = {
    bindings: [],
    bindingSnapshot: { at: Date.now(), list: [{ sessionId: 'session-b', types: ['private', 'group'] }] },
  };
  bridge._restoreBindings();
  const binding = bridge.bindings.get('session-b');
  assert.equal(typeof binding.types.has, 'function');
  assert.equal(binding.types.has('group'), true);
});

test('会话醒来时 pending 被摘掉，记忆上下文补上', () => {
  const bridge = fakeBridge({ bindings: [{ sessionId: 'session-c', types: ['private'] }] });
  bridge._restoreBindings();
  const agent = { id: 'session-c', ctx: {} };
  const binding = bridge._adoptPendingBinding('session-c', agent);
  assert.equal(binding.pending, false);
  assert.equal(typeof binding.memoryDisposer, 'function');
  assert.ok(bridge.logs.some((line) => line.includes('正式接上')));
});

test('重复调用 adopt 不会重复挂上下文', () => {
  const bridge = fakeBridge({ bindings: [{ sessionId: 'session-d', types: ['private'] }] });
  bridge._restoreBindings();
  const agent = { id: 'session-d', ctx: {} };
  bridge._adoptPendingBinding('session-d', agent);
  const first = bridge.bindings.get('session-d').memoryDisposer;
  bridge._adoptPendingBinding('session-d', agent);
  assert.equal(bridge.bindings.get('session-d').memoryDisposer, first);
});

test('坏绑定（sessionId 是对象）不会被真的绑上', () => {
  const bridge = fakeBridge({ bindings: [{ sessionId: { some: 'object' }, types: ['private'] }] });
  bridge._restoreBindings();
  assert.equal(bridge.bindings.size, 0, '对象 id 不许进 bindings');
  assert.ok(bridge.logs.some((line) => line.includes('跳过坏绑定')), '要留一句日志，别静默');
});

test('坏绑定（字符串 "[object Object]"）同样跳过', () => {
  const bridge = fakeBridge({ bindings: [{ sessionId: '[object Object]', types: ['private'] }] });
  bridge._restoreBindings();
  assert.equal(bridge.bindings.size, 0);
  assert.ok(bridge.logs.some((line) => line.includes('跳过坏绑定')));
});

test('落盘时非字符串的 key 被挡住，好绑定照常写', async () => {
  const file = path.join(os.tmpdir(), `qq-bad-binding-${Date.now()}.json`);
  const bridge = fakeBridge();
  bridge.stateFile = file;
  bridge.state = { owners: [], approvalPeer: '', grants: {}, pairs: [], bindings: [] };
  bridge.owners = new Set();
  bridge.approvalPeer = '';
  bridge.pairCodes = new Map();
  bridge.bindings.set({ some: 'object' }, { types: new Set(['private']) });
  bridge.bindings.set('session-good', { types: new Set(['private']) });

  await QqBridge.prototype._saveState.call(bridge);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.bindings.length, 1);
  assert.equal(saved.bindings[0].sessionId, 'session-good');
  await unlink(file).catch(() => {});
});

test('bindAgent 收到对象参数直接拒绝', async () => {
  const bridge = fakeBridge();
  bridge.blockedSessions = new Set();
  await assert.rejects(() => bridge.bindAgent({}), /不合法/);
  assert.equal(bridge.bindings.size, 0);
});
