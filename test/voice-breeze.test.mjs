import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VoiceEngine, breezeInstruction, breezeVoiceForMood } from '../lib/voice.js';

/** Breeze TTS：他 2026-10-29 定的基准是「迷糊版 + speed 1.1 + guidance 3」。 */

const SOFT = 'voc_8yud7hz7c9q2';
const BRIGHT = 'voc_u3nxkd5578wc';

test('心情 → 导演词：被嫌、犯困、撒娇各有各的说法', () => {
  assert.match(breezeInstruction({ P: -0.3, A: 0.4 }), /不高兴/);
  assert.match(breezeInstruction({ P: -0.3, A: 0.0 }), /没什么力气/);
  assert.match(breezeInstruction({ P: 0.5, B: 0.7, A: 0.1 }), /撒娇/);
  assert.match(breezeInstruction({ P: 0, A: -0.4 }), /刚睡醒/);
  assert.match(breezeInstruction({ P: 0.2, A: 0.6 }), /兴奋/);
  assert.match(breezeInstruction({ P: 0.05, A: 0, B: 0.35 }), /正常聊天/);
});

test('音色：闹腾换机灵版，其余默认迷糊版', () => {
  assert.equal(breezeVoiceForMood({ A: 0.6, P: 0.5 }), BRIGHT);
  assert.equal(breezeVoiceForMood({ A: 0.0, P: 0.0 }), SOFT, '没有约定时用他挑的迷糊版');
  assert.equal(breezeVoiceForMood({ A: 0.1, P: -0.2 }), SOFT, '不高兴也还是她那个声音，只是演得冷');
});

test('请求形态：URL 带音色、body 里 speed/guidance 都对、音频落盘、第二次命中缓存', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'breeze-'));
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'audio/mpeg' },
      arrayBuffer: async () => Buffer.alloc(4000, 1),
      text: async () => '',
    };
  };
  try {
    const engine = new VoiceEngine({
      dir,
      engine: 'breeze',
      breezeKey: 'test-key',
      breezeVoice: SOFT,
      breezeVoiceBright: BRIGHT,
      breezeSpeed: 1.1,
      breezeGuidance: 3,
      logger: () => {},
    });
    const mood = { P: 0.5, A: 0.1, B: 0.7 };
    const first = await engine.synthesize('咕噜，我在呢', { mood });
    assert.equal(first.engine, 'breeze');
    assert.equal(first.cached, false);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith(`/v1/text-to-speech/${SOFT}`), `用了迷糊版：${calls[0].url}`);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model_id, 'breeze-tts-2');
    assert.equal(body.language_code, 'zh');
    assert.equal(body.voice_settings.speed, 1.1);
    assert.equal(body.voice_settings.guidance_scale, 3);
    assert.match(body.instructions, /撒娇/);
    assert.ok((await fs.stat(first.path)).size > 2000);

    const second = await engine.synthesize('咕噜，我在呢', { mood });
    assert.equal(second.cached, true);
    assert.equal(calls.length, 1, '第二次不该再打接口');
  } finally {
    globalThis.fetch = realFetch;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('没配 key 时 breeze 退回 edge，不报错', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'breeze-nokey-'));
  const logs = [];
  const engine = new VoiceEngine({ dir, engine: 'breeze', breezeKey: '', logger: (line) => logs.push(line) });
  assert.equal(engine.breezeReady(), false);
  // 只验证「不会因为没 key 就抛异常」：edge 那条依赖 python，这里允许它失败后回退 sapi
  await engine.synthesize('嗯', {}).catch(() => {});
  assert.ok(logs.some((line) => /没配 key/.test(line)), `应该记一条没 key 的日志：${logs.join(' | ')}`);
  await fs.rm(dir, { recursive: true, force: true });
});
