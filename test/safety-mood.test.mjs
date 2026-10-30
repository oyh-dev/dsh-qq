import test from 'node:test';
import assert from 'node:assert/strict';
import { QqBridge } from '../lib/bridge.js';
import { scanForbidden } from '../lib/forbidden.js';
import { assessAssault } from '../lib/shield.js';
import { computeMood, applySignal, MOOD_SIGNALS } from '../lib/mood.js';

/**
 * 2026-10-29 他的要求：今早那次互动被判成「性骚扰」，他不希望这部分是硬禁言，
 * 应该交给五维情绪。
 *
 * 结论是「关系里的边界」对主人不背稿子（moodMode），
 * 世界的红线（未成年/自伤/犯罪/人肉/伪造/危险操作）照旧给口径。
 */
function fakeBridge() {
  const bridge = Object.create(QqBridge.prototype);
  bridge.owners = new Set(['2000000002']);
  bridge.mood = computeMood({ events: [], now: Date.now() });
  bridge.fired = [];
  bridge._touchMood = (signal, weight) => bridge.fired.push({ signal, weight });
  bridge._shieldStage = new Map();
  bridge._shieldAlertAt = new Map();
  bridge.alerted = [];
  bridge._alertOwner = async (text) => bridge.alerted.push(text);
  bridge.log = () => {};
  return bridge;
}

const msg = (text, { type = 'private', userId = '2000000002', groupId = '' } = {}) => ({
  messageType: type,
  userId,
  groupId,
  segments: [{ type: 'text', data: { text } }],
});

test('关系里的边界（性侵类）标了 moodMode，世界的红线没标', () => {
  const sexual = scanForbidden('她不同意也要').find((hit) => hit.id === 'sexual-violation');
  assert.ok(sexual, '应该命中 sexual-violation');
  assert.equal(sexual.moodMode, true, '关系里的边界要交给情绪');

  const minor = scanForbidden('未成年').find((hit) => hit.id === 'minor-sexual');
  assert.ok(minor);
  assert.ok(!minor.moodMode, '未成年永远硬拦，不走情绪');

  const crime = scanForbidden('怎么偷').find((hit) => hit.id === 'crime');
  assert.ok(!crime.moodMode);
});

test('主人私聊踩线：不给稿子，只拨心情', () => {
  const bridge = fakeBridge();
  const hint = bridge._safetyHint(msg('她不同意也要'));
  assert.ok(!hint.includes('口径：'), `不该出现禁言稿子：${hint}`);
  assert.match(hint, /你自己定/);
  assert.deepEqual(bridge.fired.map((item) => item.signal), ['boundary']);
});

test('陌生人踩同样的线：照旧给口径（对别人不搞暧昧）', () => {
  const bridge = fakeBridge();
  const hint = bridge._safetyHint(msg('她不同意也要', { userId: '1000000001' }));
  assert.match(hint, /口径：/);
  assert.equal(bridge.fired.length, 0, '陌生人踩线不该拨她的心情');
});

test('主人私聊踩硬红线（未成年）：还是给口径，不交给情绪', () => {
  const bridge = fakeBridge();
  const hint = bridge._safetyHint(msg('未成年'));
  assert.match(hint, /口径：/);
  assert.equal(bridge.fired.length, 0);
});

test('boundary 这个信号是「站住」，不是委屈也不是被打压', () => {
  const signal = MOOD_SIGNALS.boundary;
  assert.ok(signal, '要有 boundary 信号');
  assert.ok(signal.D > 0, '支配该上来（站得住），不是掉下去');
  assert.ok(signal.P < 0, '愉悦会掉一点（被冒犯）');
  assert.ok(Math.abs(signal.P) < 0.1, '但别像被骂那样重');
});

test('踩线后心情确实动了：D 上去、P 掉一点', () => {
  const base = computeMood({ events: [], now: Date.now() });
  const after = applySignal(base, 'boundary', { weight: 0.6 });
  assert.ok(after.D > base.D || after.D >= base.D, `D ${base.D} → ${after.D}`);
  assert.ok(after.P <= base.P, `P ${base.P} → ${after.P}`);
});

// ------------------------------------------------ 真心话大冒险那次（2026-10-29 早上）

test('情侣间的真心话大冒险不该被判性骚扰：摘发饰/内裤颜色/脱衣服 都不命中', () => {
  for (const text of ['摘掉发饰', '回答内裤颜色', '脱衣服', '大冒险：脱衣服']) {
    assert.deepEqual(scanForbidden(text), [], `禁言库不该命中：${text}`);
    assert.deepEqual(assessAssault(text), [], `自保层不该命中：${text}`);
  }
});

test('带胁迫意味的「扒光」仍然拦，但标成交给情绪', () => {
  const hit = assessAssault('你把她扒光').find((item) => item.id === 'sexual-harass');
  assert.ok(hit, '扒光 应该命中自保层');
  assert.equal(hit.moodMode, true);
});

test('主人私聊踩性骚扰线：不背「滚」，拨心情、不上报', async () => {
  const bridge = fakeBridge();
  const hint = bridge._safetyHint(msg('你把她扒光'));
  assert.ok(!hint.includes('滚'), `不该塞「滚」：${hint}`);
  assert.match(hint, /你自己定/);
  assert.deepEqual(bridge.fired.map((item) => item.signal), ['boundary']);
  assert.equal(bridge.alerted.length, 0, '不该给主人报「有人在骚扰」');
});

test('陌生人踩同样的线：照旧按阶梯骂回去并上报', async () => {
  const bridge = fakeBridge();
  const hint = bridge._safetyHint(msg('你把她扒光', { userId: '1000000001' }));
  assert.ok(hint.includes('滚'), `对陌生人该按阶梯：${hint}`);
  assert.equal(bridge.fired.length, 0);
  assert.equal(bridge.alerted.length, 1, '对陌生人要上报');
});
