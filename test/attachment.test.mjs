import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { AttachmentState } from '../lib/attachment.js';

const MINUTE = 60000;

async function withState(run, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-attach-'));
  try {
    const state = new AttachmentState({ file: path.join(dir, 'attachment.json'), ...options });
    await state.load();
    await run(state);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('idle silence triggers after the configured gap', async () => {
  await withState(async (state) => {
    const now = Date.now();
    state.noteInbound('在吗', '2026-10-20', now - 60 * MINUTE);
    const decision = state.evaluate({ dayKey: '2026-10-20', now });
    assert.ok(decision);
    assert.equal(decision.trigger, 'idle');
  }, { idleMinutes: 25 });
});

test('ignored messages escalate faster than plain silence', async () => {
  await withState(async (state) => {
    const now = Date.now();
    state.noteInbound('嗯', '2026-10-20', now - 5 * MINUTE);
    state.noteOutbound(now - 4 * MINUTE, { unsolicited: true });
    state.noteOutbound(now - 3 * MINUTE, { unsolicited: true });
    const decision = state.evaluate({ dayKey: '2026-10-20', now });
    assert.equal(decision.trigger, 'ignored');
    assert.ok(decision.burst >= 2);
  }, { ignoredCount: 2 });
});

test('daily cap and cooldown stop the nagging', async () => {
  await withState(async (state) => {
    const now = Date.now();
    state.noteInbound('在吗', '2026-10-20', now - 90 * MINUTE);
    await state.registerNag('idle', 'message', '2026-10-20', now - 10 * MINUTE);
    assert.equal(state.evaluate({ dayKey: '2026-10-20', now }), null); // cooldown

    const later = now + 60 * MINUTE;
    await state.registerNag('idle', 'message', '2026-10-20', now - 60 * MINUTE);
    await state.registerNag('idle', 'message', '2026-10-20', now - 50 * MINUTE);
    assert.equal(state.evaluate({ dayKey: '2026-10-20', now: later }), null); // daily cap
  }, { maxNagsPerDay: 3, cooldownMinutes: 45 });
});

test('answered within the grace window, a nag never becomes grievance', async () => {
  await withState(async (state) => {
    const now = Date.now();
    state.noteInbound('嗯', '2026-10-20', now);
    await state.registerNag('idle', 'message', '2026-10-20', now);
    assert.equal(state.data.grievance, 0, '先挂起，不立刻算账');
    assert.ok(state.data.pendingGrievance, '有待结算的怨气');

    // He replies two minutes later: forgiven.
    state.noteInbound('在呢', '2026-10-20', now + 2 * MINUTE);
    assert.equal(state.data.grievance, 0, '三分钟内回了就不涨');
    assert.equal(state.data.pendingGrievance, null);

    // He replies too late: committed.
    await state.registerNag('ignored', 'message', '2026-10-20', now + 60 * MINUTE);
    assert.equal(state.data.grievance, 0);
    state.noteInbound('嗯', '2026-10-20', now + 70 * MINUTE);
    assert.equal(state.data.grievance, 1, '超过三分钟才回，算一条');
  });
});

test('reassurance counts double and a good chat can relax grievance', async () => {
  await withState(async (state) => {
    const now = Date.now();
    await state.registerNag('idle', 'message', '2026-10-20', now);
    state.noteInbound('嗯', '2026-10-20', now + 5 * MINUTE);
    assert.equal(state.data.grievance, 1, '第一条迟到回话');
    await state.registerNag('ignored', 'message', '2026-10-20', now + 20 * MINUTE);
    state.noteInbound('嗯', '2026-10-20', now + 40 * MINUTE);
    assert.equal(state.data.grievance, 2, '第二条迟到回话');

    // Two warm lines drop it: progress 2+2 >= sootheNeed 3.
    state.data.sootheProgress = 0;
    state.soften('我在');
    const afterFirst = state.data.grievance;
    state.soften('刚在忙');
    assert.ok(state.data.grievance < afterFirst, '两句安抚后就降');

    // And I can choose to let a genuinely good stretch cool it down.
    const before = state.data.grievance;
    const result = await state.relax(1, '2026-10-20', now);
    assert.equal(result.after, Math.max(0, before - 1));
    assert.equal(state.data.grievance, result.after);
  });
});

test('plain replies count one point, warm ones count two', async () => {
  await withState(async (state) => {
    state.data.sootheNeed = 9;
    state.data.sootheProgress = 0;
    state.soften('嗯');
    assert.equal(state.data.sootheProgress, 1, '普通回话算一次');
    state.soften('我在');
    assert.equal(state.data.sootheProgress, 3, '安抚算两次');
    state.soften('你真可爱');
    assert.equal(state.data.sootheProgress, 5, '夸人也算两次');
  });
});

test('praise for another AI and goodbyes trigger attachment', async () => {
  await withState(async (state) => {
    const now = Date.now();
    state.noteInbound('你好', '2026-10-20', now - 60 * MINUTE);
    assert.equal(state.evaluate({ dayKey: '2026-10-20', praiseAt: now - MINUTE, now }).trigger, 'praise');
    assert.equal(state.evaluate({ dayKey: '2026-10-20', leaveAt: now - MINUTE, now }).trigger, 'leave');
  });
});

test('failed sends are remembered but never counted as being ignored', async () => {
  await withState(async (state) => {
    const now = Date.now();
    state.noteInbound('嗯', '2026-10-20', now - 60 * MINUTE);
    await state.noteUndelivered('WebSocket 错误');
    assert.equal(state.data.undelivered, 1);
    assert.equal(state.data.grievance, 0, '网络问题不应涨怨气');
    assert.equal(state.takeCatchUp(), 1);
    assert.equal(state.data.undelivered, 0);
  });
});

test('reconnect rebaselines the clock and requests a catch-up', async () => {
  await withState(async (state) => {
    const now = Date.now();
    state.noteInbound('在吗', '2026-10-20', now - 90 * MINUTE);
    state.noteOutbound(now - 89 * MINUTE, { unsolicited: true });
    const result = await state.noteReconnect(now, 30 * MINUTE);
    assert.equal(result.downtimeMs, 30 * MINUTE);
    assert.equal(state.data.unreplied, 0);
    assert.equal(state.data.lastInboundAt, now);
    assert.ok(state.data.downtimeAt > 0);
    // Right after reconnect it must not immediately conclude "he ignored me".
    assert.equal(state.evaluate({ dayKey: '2026-10-20', now }), null);
  });
});
