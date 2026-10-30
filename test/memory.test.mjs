import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore, memoryDayKey, lastClosedDigestKey, redact } from '../lib/memory.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-memory-test-'));
const logs = [];
const llm = {
  stream(options) {
    const system = String(options.system || '');
    const user = String(options.messages?.[0]?.content?.[0]?.text || '');
    let text;
    if (user.includes('同一天几个')) {
      text = JSON.stringify({ globalSummary: '今天聊了 QQ 插件和每日记忆压缩，决定每天 04:00 自动总结。', keywords: ['QQ', '记忆', '压缩'] });
    } else if (system.includes('200 字')) {
      text = '讨论了 QQ 插件和每日记忆压缩。';
    } else {
      text = JSON.stringify({
        summary: '讨论了 QQ 插件与每日记忆压缩，决定每天 04:00 自动总结前 24 小时。',
        topics: ['QQ 插件', '记忆压缩'],
        decisions: ['每天 04:00 压缩昨日对话'],
        tasks: ['写完 memory 模块'],
        preferences: ['回答要短'],
        unresolved: [],
        quotes: ['先别急，我看一下。'],
      });
    }
    return (async function* () {
      yield { type: 'text-delta', text };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })();
  },
};

const store = new MemoryStore({
  dir,
  logger: (line) => logs.push(line),
  getLlm: () => llm,
  getModel: () => ({ provider: 'test', model: 'test' }),
});
await store.init();

const t = (iso) => new Date(iso).getTime();
await store.record({ chatType: 'private', chatId: '10001', chatName: '测试用户', fromId: '10001', fromName: '测试用户', direction: 'in', text: '今天聊了 QQ 插件和记忆压缩', ts: t('2026-10-19T10:00:00+08:00') });
await store.record({ chatType: 'private', chatId: '10001', chatName: '测试用户', fromId: '1000000002', fromName: '我', direction: 'out', text: '决定每天 04:00 自动总结前 24 小时', ts: t('2026-10-19T10:01:00+08:00') });
await store.record({ chatType: 'group', chatId: '20002', chatName: '群 20002', fromId: '10002', fromName: '群友', direction: 'in', text: '群里讨论了图片和视频抽帧', ts: t('2026-10-20T02:00:00+08:00') });

const result = await store.runDaily('2026-10-20');
assert.equal(result.messages, 3);
const digest = JSON.parse(await readFile(path.join(dir, 'daily', '2026-10-20.json'), 'utf8'));
assert.equal(digest.chats.length, 2);
assert.match(digest.globalSummary, /记忆压缩/);
assert.equal(digest.chats[0].chatType, 'private');
assert.equal(digest.chats[0].messageCount, 2);

const ctxText = store.renderContext();
assert.match(ctxText, /10-20/);
assert.match(ctxText, /qq_memory_search/);

const search = await store.search('图片');
assert.ok(search.count >= 1);
assert.equal(search.hits[0].date, '2026-10-20');

// 切点从 04:00 改成 09:30（2026-10-29）：早上的消息算进当天，不再半夜切一刀
assert.equal(memoryDayKey(new Date('2026-10-19T02:00:00+08:00')), '2026-10-19');
assert.equal(memoryDayKey(new Date('2026-10-19T10:00:00+08:00')), '2026-10-20');
assert.equal(memoryDayKey(new Date('2026-10-20T09:29:00+08:00')), '2026-10-20', '09:29 还没到切点');
assert.equal(memoryDayKey(new Date('2026-10-20T09:30:00+08:00')), '2026-10-21', '09:30 之后算第二天');
assert.equal(lastClosedDigestKey(new Date('2026-10-20T09:00:00+08:00')), '2026-10-19', '切点前：上一份是昨天');
assert.equal(lastClosedDigestKey(new Date('2026-10-20T09:30:00+08:00')), '2026-10-20', '切点后：今天这份关上了');

const redacted = redact('api_key: sk-abcdef1234567890；Authorization: Bearer abc.def.ghi；token: qqbot-example-token-0001；密码：hunter2');
assert.doesNotMatch(redacted, /sk-abcdef/);
assert.doesNotMatch(redacted, /abc\.def/);
assert.doesNotMatch(redacted, /qqbot-example/);
assert.doesNotMatch(redacted, /hunter2/);
assert.match(redacted, /已脱敏|REDACTED/);

console.log(JSON.stringify({ result, digest, ctxText, search, redacted, logs }, null, 2));
await rm(dir, { recursive: true, force: true });
