import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';

import { AttachmentState } from '../lib/attachment.js';

const MIN = 60000;

async function makeStore(overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nag-'));
  const state = new AttachmentState({
    file: path.join(dir, 'attachment.json'),
    idleMinutes: 25,
    ignoredCount: 2,
    maxNagsPerDay: 20,
    cooldownMinutes: 30,
    maxBurst: 15,
    topicCooldownMinutes: 90,
    topicDailyCap: 3,
    ...overrides,
  });
  await state.load();
  return state;
}

test('同话题：冷却窗口内不许重复', async () => {
  const state = await makeStore();
  const now = Date.now();
  assert.equal(state.canTopic('idle', now), true, '第一次可以');
  await state.registerNag('idle', 'message', '2026-10-27', now);
  assert.equal(state.canTopic('idle', now + 30 * MIN), false, '30 分钟内同一个由头不许再来');
  assert.equal(state.canTopic('idle', now + 91 * MIN), true, '过了 90 分钟冷却可以');
});

test('同话题：一天内不许超过 3 次，哪怕冷却都过了', async () => {
  const state = await makeStore();
  const base = Date.now();
  for (let i = 0; i < 3; i += 1) {
    await state.registerNag('ignored', 'message', '2026-10-27', base + i * 120 * MIN);
  }
  assert.equal(state.canTopic('ignored', base + 6 * 60 * MIN), false, '3 次用完了就得闭嘴');
});

test('不同由头互不影响——不能因为 idle 用完了就连 ignored 也禁掉', async () => {
  const state = await makeStore();
  const now = Date.now();
  for (let i = 0; i < 3; i += 1) {
    await state.registerNag('idle', 'message', '2026-10-27', now + i * 120 * MIN);
  }
  assert.equal(state.canTopic('idle', now + 400 * MIN), false);
  assert.equal(state.canTopic('ignored', now + 400 * MIN), true, '换了个由头还允许');
});

test('evaluate 不会再反复用同一个现成理由', async () => {
  const state = await makeStore({ idleMinutes: 25, cooldownMinutes: 1, topicDailyCap: 1 });
  const now = Date.now();
  state.data.lastInboundAt = now - 60 * MIN;
  state.data.lastOutboundAt = now - 60 * MIN;
  const first = state.evaluate({ dayKey: '2026-10-27', now });
  assert.equal(first?.trigger, 'idle');
  await state.registerNag(first.trigger, 'message', '2026-10-27', now);

  // 一小时后依然"晾着"，但同话题已满额 -> 不该再触发
  const later = state.evaluate({ dayKey: '2026-10-27', now: now + 60 * MIN });
  assert.equal(later, null, '同一由头用完，就该安静下来');
});

test('旧的 state 文件没有 topicLog 也能跑', async () => {
  const state = await makeStore();
  state.data.topicLog = undefined;
  assert.equal(state.canTopic('idle', Date.now()), true);
  await state.registerNag('idle', 'message', '2026-10-27', Date.now());
  assert.equal(state.canTopic('idle', Date.now()), false);
});
