import test from 'node:test';
import assert from 'node:assert/strict';
import { detectGamble, gambleSignal } from '../lib/gamble.js';

/** 赌局识别：不绑具体游戏，只认赌的动作（2026-10-30）。 */

test('各种赌性质的游戏都能认出来，不只是 21 点', () => {
  const cases = [
    ['我梭哈了', 'bet'],
    ['加注，跟一把', 'bet'],
    ['押大！', 'bet'],
    ['all in', 'bet'],
    ['买定离手', 'bet'],
    ['这把我赢了', 'win'],
    ['通杀，血赚', 'win'],
    ['爆牌了，我输了', 'lose'],
    ['不玩了，收手', 'quit'],
    ['够了够了', 'quit'],
  ];
  for (const [text, expect] of cases) {
    assert.equal(detectGamble(text), expect, `${text} 应该是 ${expect}`);
  }
});

test('非赌局的话不误伤', () => {
  for (const text of ['今天吃什么', '我想睡觉', '这个游戏挺好玩的', '押韵的诗']) {
    assert.equal(detectGamble(text), '', `${text} 不该命中`);
  }
});

test('收手优先于输（「输了就算了不玩了」按收手算）', () => {
  assert.equal(detectGamble('输了，不玩了'), 'quit');
});

test('他想到的新说法可以靠 extraWords 补，不用改代码', () => {
  assert.equal(detectGamble('来，压我的尾巴', { extraWords: ['压我的尾巴'] }), 'bet');
  assert.equal(detectGamble('来，压我的尾巴'), '', '没配置时不命中');
});

test('信号映射：四种动作各对一个 mood 信号', () => {
  assert.equal(gambleSignal('bet'), 'gamble');
  assert.equal(gambleSignal('win'), 'gambleWon');
  assert.equal(gambleSignal('lose'), 'gambleLost');
  assert.equal(gambleSignal('quit'), 'quitGamble');
  assert.equal(gambleSignal(''), '');
});
