import test from 'node:test';
import assert from 'node:assert/strict';
import { moodVetoesNag } from '../lib/attachment.js';

/**
 * 五维优先（2026-10-29 他定的）：心情好、有安全感的时候，
 * attachment（闲太久/被忽略/被夸别人）再急也不闹——那种时候闹像系统催，不像她。
 */

test('心情好 + 有安全感：否决', () => {
  assert.equal(moodVetoesNag({ P: 0.45, B: 0.6 }, { nag: 1 }), 'mood-good');
});

test('心情差：不否决（该闹就闹）', () => {
  assert.equal(moodVetoesNag({ P: -0.4, B: 0.3 }, { nag: 1 }), '');
});

test('依恋低：也不否决（不拿「心情还行」掩盖没安全感）', () => {
  assert.equal(moodVetoesNag({ P: 0.5, B: 0.2 }, { nag: 1 }), '');
});

test('心气高、不低落的踏实状态：也否决', () => {
  assert.equal(moodVetoesNag({ P: 0.2, D: 0.6, B: 0.3 }, { nag: 1 }), 'mood-steady');
});

test('能量见底（nag=0）：一律否决，理由是 energy', () => {
  assert.equal(moodVetoesNag({ P: -0.4, B: 0.2 }, { nag: 0 }), 'energy');
});

test('没有心情数据时不否决（保留原行为）', () => {
  assert.equal(moodVetoesNag(null, { nag: 1 }), '');
});
