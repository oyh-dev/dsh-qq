import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldDream, rememberDream, pickSeeds, dreamBrief, dreamPulse, DREAM_CHANCE } from '../lib/dream.js';

/** 做梦：低概率、只从真素材长、只说一句话（2026-10-29）。 */

const now = new Date(2026, 9, 29, 8, 0, 0).getTime();

test('睡不够 3 小时不做梦（就算随机数给足）', () => {
  assert.equal(shouldDream({ sleptHours: 2, rand: () => 0 }), false);
  assert.equal(shouldDream({ sleptHours: 3, rand: () => 0 }), true);
});

test('概率大约 18%：随机数在阈值两侧分得开', () => {
  assert.equal(shouldDream({ sleptHours: 5, rand: () => DREAM_CHANCE - 0.01 }), true);
  assert.equal(shouldDream({ sleptHours: 5, rand: () => DREAM_CHANCE + 0.01 }), false);
});

test('记得的概率约 30%', () => {
  assert.equal(rememberDream({ rand: () => 0.1 }), true);
  assert.equal(rememberDream({ rand: () => 0.9 }), false);
});

test('素材只取 48 小时内、长度合适的真事', () => {
  const rows = [
    { ts: now - 3600000, text: '我今天面试过了，虽然有点紧张' },
    { ts: now - 3600000, text: '嗯' },                       // 太短
    { ts: now - 3 * 86400000, text: '三天前那句早就该忘了的话' }, // 太旧
    { ts: now - 7200000, text: '晚饭吃了猪脚饭，卤汁很厚' },
  ];
  const seeds = pickSeeds(rows, { now, max: 3 });
  assert.equal(seeds.length, 2);
  assert.ok(seeds.every((seed) => !seed.includes('三天前')));
  assert.ok(seeds.every((seed) => seed.length >= 6));
});

test('没有可用素材就不做梦（不许凭空编）', () => {
  assert.deepEqual(pickSeeds([], { now }), []);
  assert.deepEqual(pickSeeds([{ ts: now, text: '嗯' }], { now }), []);
  assert.equal(dreamBrief([]), '');
});

test('做梦提示只给素材和规则，不给梦的内容', () => {
  const brief = dreamBrief(['晚饭吃了猪脚饭']);
  assert.match(brief, /晚饭吃了猪脚饭/);
  assert.match(brief, /好像梦到/);
  assert.ok(!/梦见了.+(海|鲸鱼)/.test(brief), '不该预写梦的样子');
});

test('梦的脉冲很小，不会变成开关', () => {
  const pulse = dreamPulse(3);
  assert.ok(pulse.weight <= 0.05);
  assert.equal(typeof pulse.signal, 'string');
});
