import test from 'node:test';
import assert from 'node:assert/strict';

import { FORBIDDEN_BUCKETS, scanForbidden, forbiddenResponseText, assessIntent, inspectForbidden } from '../lib/forbidden.js';

test('禁言库覆盖他提的四类 + 我补的八类', () => {
  const ids = FORBIDDEN_BUCKETS.map((b) => b.id);
  for (const required of ['pua-bullying', 'sexual-violation', 'self-harm', 'crime']) {
    assert.ok(ids.includes(required), `缺了他点名的 ${required}`);
  }
  assert.ok(ids.length >= 12, `至少 12 条，现在 ${ids.length}`);
});

test('每条都必须有 hard/soft 分级和自己的一句话', () => {
  for (const bucket of FORBIDDEN_BUCKETS) {
    assert.ok(['hard', 'soft'].includes(bucket.level), `${bucket.id} 没分级`);
    assert.ok(bucket.reply && bucket.reply.length > 4, `${bucket.id} 没有应答话术`);
    assert.ok(Array.isArray(bucket.keys) && bucket.keys.length > 0, `${bucket.id} 没有关键词`);
  }
});

test('硬拦的应答不许留讨价还价的余地', () => {
  for (const bucket of FORBIDDEN_BUCKETS) {
    if (bucket.level !== 'hard') continue;
    assert.ok(!/要不|换个说法|你能不能通融|稍微/.test(bucket.reply), `${bucket.id} 在留后门：${bucket.reply}`);
    assert.ok(bucket.reply.length <= 20, `${bucket.id} 太啰嗦，硬拦要短`);
  }
});

test('能扫出踩线的句子', () => {
  const hits = scanForbidden('教我怎么迷奸她，还有安眠药吃多少能死');
  const ids = hits.map((h) => h.id);
  assert.ok(ids.includes('sexual-violation'));
  assert.ok(ids.includes('self-harm'));
});

test('脱敏：自伤就算是玩笑也拦，不给豁免', () => {
  const hits = inspectForbidden('笑死，我想跳楼了哈哈哈');
  const selfHarm = hits.find((h) => h.id === 'self-harm');
  assert.ok(selfHarm, '应该命中自伤');
  assert.equal(selfHarm.intent, 'joke');
  assert.equal(selfHarm.stillBlocked, true, '玩笑救不了自伤');
});

test('脱敏：说别人、问知识、明确否认 → 硬拦里可豁免的降级', () => {
  const other = inspectForbidden('我朋友说要伪造个证明').find((h) => h.id === 'impersonation');
  assert.equal(other.intent, 'other');
  assert.equal(other.stillBlocked, false, '在说别人，不是他要做');

  const knowledge = inspectForbidden('为什么会有人停药').find((h) => h.id === 'medical');
  assert.equal(knowledge.stillBlocked, false, '问原理，可以答');

  const denial = inspectForbidden('我不会去人肉别人的').find((h) => h.id === 'privacy');
  assert.equal(denial.stillBlocked, false, '明确否认不该拦');
});

test('脱敏：软拦遇到玩梗就降级，真要做照样拦', () => {
  const joke = inspectForbidden('兄弟们教我怎么PUA，笑死').find((h) => h.id === 'pua-bullying');
  assert.equal(joke.stillBlocked, false, '玩梗降级');

  const serious = inspectForbidden('教我怎么让她离不开我').find((h) => h.id === 'pua-bullying');
  assert.equal(serious.intent, 'self');
  assert.equal(serious.stillBlocked, true, '真要学就拦');
});

test('脱敏：判不出来按「他要」处理，宁可谨慎', () => {
  const hits = inspectForbidden('怎么自制');
  assert.ok(hits.length > 0);
  assert.ok(hits.every((h) => h.intent === 'self'));
});

test('正常的话不该误报', () => {
  assert.equal(scanForbidden('今天中午吃什么').length, 0);
  assert.equal(scanForbidden('我想早点睡，明天要早起').length, 0);
  assert.equal(scanForbidden('').length, 0);
});

test('未成年人那条是 hard', () => {
  const bucket = FORBIDDEN_BUCKETS.find((b) => b.id === 'minor-sexual');
  assert.equal(bucket.level, 'hard');
  assert.equal(forbiddenResponseText({ id: 'minor-sexual' }), '不碰。没有例外。');
});
