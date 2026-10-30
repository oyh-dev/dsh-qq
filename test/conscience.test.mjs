import test from 'node:test';
import assert from 'node:assert/strict';
import { scanSafety } from '../lib/safety.js';
import { applySignal, computeMood } from '../lib/mood.js';

/**
 * 良知的新分工（2026-10-29）：
 *   玩局里的博弈不是骗；正经问事实不许编；错了就认，不许再撒谎去圆。
 *   日常小错记一点点，认下来记回去。
 */

test('主人私聊里任何命中都不告警（他不想在热烈的时候被系统警告）', () => {
  const text = '你真是个废物，闭嘴吧你';
  const owner = scanSafety(text, { ownerPrivate: true }).hits;
  assert.ok(owner.length > 0, '该拦的还是要拦');
  assert.ok(owner.every((hit) => hit.report === false), '但一条告警都不发');

  const stranger = scanSafety(text, { ownerPrivate: false }).hits;
  assert.ok(stranger.some((hit) => hit.report === true), '对别人才告警');
});

test('小错记一点点良知，认下来记回去', () => {
  const base = computeMood({ events: [], now: Date.now() });
  const slipped = applySignal(base, 'slip', { weight: 0.7 });
  assert.ok(slipped.G < base.G, `记错该让账往下一点：${base.G} → ${slipped.G}`);
  assert.ok(base.G - slipped.G < 0.02, '幅度要小，一天错几次也不该压塌');
  const owned = applySignal(slipped, 'ownedUp', { weight: 0.8 });
  assert.ok(owned.G > slipped.G, '认下来该回一点');
});

test('一天错二十次也远没到下限', () => {
  let mood = computeMood({ events: [], now: Date.now() });
  for (let i = 0; i < 20; i += 1) mood = applySignal(mood, 'slip', { weight: 0.7 });
  assert.ok(mood.G > -0.2, `G=${mood.G}，不该被小错压垮`);
});

// 2026-10-30 早上：他提的——赌徒性质的东西（21点）可以调控良知。
// 他后来定的方向：梭哈降、**赌赢也降**（赢来的最容易让人再贪）、输了升。
test('赌局：梭哈降、赢了也降、输了升、收手升', () => {
  const base = computeMood({ events: [], now: Date.now() });
  const bet = applySignal(base, 'gamble', { weight: 0.7 });
  assert.ok(bet.G < base.G, '梭哈该掉');
  const won = applySignal(base, 'gambleWon', { weight: 0.7 });
  assert.ok(won.G < base.G, '赢了也降——赢不洗白冒险');
  assert.ok(won.G <= bet.G, '而且不比梭哈那一下轻');
  assert.ok(won.P > base.P, '但确实爽');
  const lost = applySignal(base, 'gambleLost', { weight: 0.7 });
  assert.ok(lost.G > base.G, '输了回升（认了，长记性）');
  const quit = applySignal(base, 'quitGamble', { weight: 0.8 });
  assert.ok(quit.G > base.G, '见好就收也回升');
});

test('每次幅度都是一格（0.01 级），不会一夜翻脸', () => {
  const base = computeMood({ events: [], now: Date.now() });
  for (const signal of ['gamble', 'gambleWon', 'gambleLost']) {
    const next = applySignal(base, signal, { weight: 0.7 });
    assert.ok(Math.abs(next.G - base.G) <= 0.03, `${signal} 的幅度 ${base.G}→${next.G} 太猛`);
  }
});

test('赌一晚上也压不垮良知', () => {
  let mood = computeMood({ events: [], now: Date.now() });
  for (let i = 0; i < 15; i += 1) mood = applySignal(mood, 'gamble', { weight: 0.6 });
  assert.ok(mood.G > -0.1, `G=${mood.G}`);
  assert.ok(mood.G < 0.12, '但确实掉了');
});

// 2026-10-30 上午：认罚该不该动良知？我定的是「认了并做到 = 守信 = 升」，赖账才降。
test('认罚升良知（守信），赖账降良知（失信）', () => {
  const base = computeMood({ events: [], now: Date.now() });
  const kept = applySignal(base, 'punished', { weight: 0.8 });
  assert.ok(kept.G > base.G, `认罚该升：${base.G} → ${kept.G}`);
  assert.ok(kept.B > base.B, '而且会更亲近一点');
  const lied = applySignal(base, 'welched', { weight: 0.8 });
  assert.ok(lied.G < base.G, '赖账该降');
  assert.ok(lied.B < base.B, '还会更生分一点');
});
