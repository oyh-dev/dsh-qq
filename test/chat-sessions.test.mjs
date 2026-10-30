import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { readFile, unlink } from 'node:fs/promises';
import { QqBridge } from '../lib/bridge.js';

/** 只造「独立会话」相关的字段，别为几行逻辑起整个插件。 */
function fakeBridge({ allowed = ['1000000001'], owners = ['2000000002'], loop, model = { provider: 'p', model: 'm' } } = {}) {
  const bridge = Object.create(QqBridge.prototype);
  bridge.state = { bindings: [], chatSessions: {} };
  bridge.owners = new Set(owners);
  bridge.strangers = { allowed: allowed.map((uin) => ({ uin, nickname: '示例昵称' })), pending: [] };
  bridge.chatSessionCfg = { enabled: true, workspace: 'D:/dsh-qq-chat', forGroups: false };
  bridge.chatSessions = new Map();
  bridge._chatSessionBusy = new Map();
  bridge._chatSessionFailed = new Map();
  bridge.bindings = new Map();
  bridge.queues = new Map();
  bridge.holds = new Map();
  bridge.groupBuffer = new Map();
  bridge.logs = [];
  bridge.saves = 0;
  bridge.log = (line) => bridge.logs.push(line);
  bridge._saveState = async () => { bridge.saves += 1; };
  bridge._getModel = () => model;
  bridge.ctx = {
    get: (name) => (name === 'agentLoop' ? loop : undefined),
  };
  return bridge;
}

function fakeLoop({ contexts = null } = {}) {
  const created = [];
  return {
    created,
    create: async (id, options, meta) => {
      created.push({ id, options, meta });
      return {
        id,
        ctx: contexts ? { systemPrompt: { context: (spec) => contexts.push(spec) } } : {},
      };
    },
  };
}

const strangerMsg = { messageType: 'private', userId: '1000000001', nickname: '示例昵称', segments: [], rawMessage: '在吗' };
const ownerMsg = { messageType: 'private', userId: '2000000002', nickname: '主人', segments: [], rawMessage: '在吗' };
const groupMsg = { messageType: 'group', groupId: '3000000003', userId: '1000000001', nickname: '示例昵称', segments: [], rawMessage: '在吗' };

test('聊天键：私聊按 QQ 号，群按群号', () => {
  const bridge = fakeBridge();
  assert.equal(bridge._chatKey(strangerMsg), 'private-1000000001');
  assert.equal(bridge._chatKey(groupMsg), 'group-3000000003');
});

test('主人自己的私聊不拆，放行过的陌生人才拆', () => {
  const bridge = fakeBridge();
  assert.equal(bridge._usesOwnSession(ownerMsg), false, '他的话还是回他那条');
  assert.equal(bridge._usesOwnSession(strangerMsg), true);
  assert.equal(bridge._usesOwnSession({ ...strangerMsg, userId: '4000000004' }), false, '没放行的不单开');
});

test('群默认不拆，开关打开才拆', () => {
  const bridge = fakeBridge();
  assert.equal(bridge._usesOwnSession(groupMsg), false);
  bridge.chatSessionCfg.forGroups = true;
  assert.equal(bridge._usesOwnSession(groupMsg), true);
});

test('总开关关掉就全走原来的公共绑定', () => {
  const bridge = fakeBridge();
  bridge.chatSessionCfg.enabled = false;
  assert.equal(bridge._usesOwnSession(strangerMsg), false);
});

test('建会话：把工作目录和模型一起传下去，并记进 state', async () => {
  const loop = fakeLoop();
  const bridge = fakeBridge({ loop });
  const sessionId = await bridge.ensureChatSession(strangerMsg);

  assert.ok(sessionId?.startsWith('session-'), '会话 id 要像 session- 开头');
  assert.equal(loop.created.length, 1);
  assert.equal(loop.created[0].id, sessionId);
  assert.equal(loop.created[0].meta.cwd.replace(/\\/g, '/'), 'D:/dsh-qq-chat', 'cwd 决定它出现在哪个工作区');
  assert.equal(loop.created[0].options.provider, 'p');
  assert.equal(loop.created[0].options.model, 'm');
  assert.equal(bridge.chatSessions.get('private-1000000001').sessionId, sessionId);
  assert.equal(bridge.saves, 1, '建完要落盘，重启后还能接上');
});

test('落盘时独立会话真的写进 state.json', async () => {
  const bridge = fakeBridge();
  bridge.stateFile = path.join(os.tmpdir(), `qq-chat-sessions-${Date.now()}.json`);
  bridge.state = { owners: [], approvalPeer: '', grants: {}, pairs: [], bili: null, bindings: [], chatSessions: {} };
  bridge.pairCodes = new Map();
  bridge.chatSessions.set('private-1000000001', { sessionId: 'session-x', label: '示例昵称（1000000001）' });

  await QqBridge.prototype._saveState.call(bridge);
  const saved = JSON.parse(await readFile(bridge.stateFile, 'utf8'));

  assert.equal(saved.chatSessions['private-1000000001'].sessionId, 'session-x');
  await unlink(bridge.stateFile).catch(() => {});
});

test('同一个聊天再来消息不会重复建会话', async () => {
  const loop = fakeLoop();
  const bridge = fakeBridge({ loop });
  const first = await bridge.ensureChatSession(strangerMsg);
  const second = await bridge.ensureChatSession(strangerMsg);
  assert.equal(first, second);
  assert.equal(loop.created.length, 1);
});

test('并发进来只建一条（不会一人两条会话）', async () => {
  const loop = fakeLoop();
  const bridge = fakeBridge({ loop });
  const [a, b, c] = await Promise.all([
    bridge.ensureChatSession(strangerMsg),
    bridge.ensureChatSession(strangerMsg),
    bridge.ensureChatSession(strangerMsg),
  ]);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(loop.created.length, 1);
});

test('拿不到模型就不建，并且十分钟内不再重试', async () => {
  const loop = fakeLoop();
  const bridge = fakeBridge({ loop, model: {} });
  const first = await bridge.ensureChatSession(strangerMsg);
  const second = await bridge.ensureChatSession(strangerMsg);
  assert.equal(first, null);
  assert.equal(second, null);
  assert.equal(loop.created.length, 0, '退避期间不该再撞一次');
  assert.ok(bridge.logs.some((line) => line.includes('单开会话失败')));
});

test('没有 agentLoop.create 时也不炸，返回 null', async () => {
  const bridge = fakeBridge({ loop: undefined });
  assert.equal(await bridge.ensureChatSession(strangerMsg), null);
});

test('陌生人消息进他自己的会话，不进主人那条', async () => {
  const loop = fakeLoop();
  const bridge = fakeBridge({ loop });
  bridge.bindings.set('session-owner', { types: new Set(['private']) });
  const dispatched = [];
  bridge._buildIncomingBlocks = async () => [{ type: 'text', text: '在吗' }];
  bridge._dispatchBlocks = (sessionId, blocks) => { dispatched.push(sessionId); return 'now'; };

  bridge._forward(strangerMsg);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(dispatched.length, 1);
  assert.notEqual(dispatched[0], 'session-owner', '别混进他的会话');
  assert.equal(dispatched[0], bridge.chatSessions.get('private-1000000001').sessionId);
});

test('主人的消息还是走绑定会话', async () => {
  const bridge = fakeBridge();
  bridge.bindings.set('session-owner', { types: new Set(['private']) });
  const dispatched = [];
  bridge._buildIncomingBlocks = async () => [{ type: 'text', text: '在吗' }];
  bridge._dispatchBlocks = (sessionId) => { dispatched.push(sessionId); return 'now'; };

  bridge._forward(ownerMsg);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(dispatched, ['session-owner']);
});

test('会话建不出来时退回公共绑定，消息不能丢', async () => {
  const bridge = fakeBridge({ model: {} });
  bridge.bindings.set('session-owner', { types: new Set(['private']) });
  const dispatched = [];
  bridge._buildIncomingBlocks = async () => [{ type: 'text', text: '在吗' }];
  bridge._dispatchBlocks = (sessionId) => { dispatched.push(sessionId); return 'now'; };

  bridge._forward(strangerMsg);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(dispatched, ['session-owner']);
});

test('陌生人会话里顶掉「你和他」和粘人状态那两段', async () => {
  const contexts = [];
  const bridge = fakeBridge({ loop: fakeLoop({ contexts }) });
  const sessionId = await bridge.ensureChatSession(strangerMsg);

  const names = contexts.map((item) => item.name);
  assert.ok(names.includes('qq-relationship'), '要遮住全局那条关系描述');
  assert.ok(names.includes('qq-attachment'), '粘人状态对陌生人没意义，直接清空');
  const relationship = contexts.find((item) => item.name === 'qq-relationship');
  assert.equal(relationship.order, 44, '同名 + 同 order，才能顶掉全局那条');
  const text = relationship.text();
  assert.ok(text.includes('陌生人'));
  assert.ok(!text.includes('情侣'), '不能把「你和他」那套带进陌生人会话');
  assert.ok(bridge.logs.some((line) => line.includes(sessionId) && line.includes('陌生人')));
});

test('短信建出来时没有 systemPrompt 也不炸', async () => {
  const bridge = fakeBridge({ loop: fakeLoop() });
  assert.ok((await bridge.ensureChatSession(strangerMsg))?.startsWith('session-'));
});

test('启动补挂：只挂已有的会话，不再给「放行但没说过话」的预建空会话', async () => {
  const loop = fakeLoop();
  const bridge = fakeBridge({ allowed: ['1000000001', '5000000005'], loop });
  bridge.chatSessions.set('private-1000000001', { sessionId: 'session-old' });
  const calls = [];
  bridge.ctx.get = (name) => {
    if (name === 'agentLoop') return loop;
    if (name === 'workspaceRegistry') return { resolveByPath: async () => ({ workspaceId: 'ws-1', title: 'dsh-qqchat' }) };
    if (name === 'workspaceController') return { insertSessionBefore: async (req) => { calls.push(req); return {}; } };
    return undefined;
  };

  const accounted = await bridge._backfillChatSessions();

  assert.equal(loop.created.length, 0, '不许预建空会话（侧栏不列，也挂不进去）');
  assert.equal(accounted, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, 'session-old');
  assert.equal(bridge.chatSessions.size, 1, '没说过话的放行者不该凭空多出一条会话');
});

test('建完会试着挂进对应工作区，挂上了就记一句', async () => {
  const loop = fakeLoop();
  const bridge = fakeBridge({ loop });
  const calls = [];
  bridge.ctx.get = (name) => {
    if (name === 'agentLoop') return loop;
    if (name === 'workspaceRegistry') return { resolveByPath: async (p) => ({ workspaceId: 'ws-1', title: 'dsh-qqchat', path: p }) };
    if (name === 'workspaceController') return { insertSessionBefore: async (req) => { calls.push(req); return {}; } };
    return undefined;
  };

  const sessionId = await bridge.ensureChatSession(strangerMsg);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].workspaceId, 'ws-1');
  assert.equal(calls[0].sessionId, sessionId);
  assert.ok(bridge.logs.some((line) => line.includes('已挂进工作区')));
});

test('挂不进工作区只记日志，会话照样建好能用', async () => {
  const loop = fakeLoop();
  const bridge = fakeBridge({ loop });
  bridge.ctx.get = (name) => {
    if (name === 'agentLoop') return loop;
    if (name === 'workspaceRegistry') return { resolveByPath: async () => ({ workspaceId: 'ws-1', title: 'dsh-qqchat' }) };
    if (name === 'workspaceController') return { insertSessionBefore: async () => { throw new Error('not accounted'); } };
    return undefined;
  };

  const sessionId = await bridge.ensureChatSession(strangerMsg);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.ok(sessionId?.startsWith('session-'));
  assert.equal(bridge.chatSessions.get('private-1000000001').sessionId, sessionId);
  assert.ok(bridge.logs.some((line) => line.includes('挂进工作区没成')));
});

test('没有 workspace 服务时安静跳过', async () => {
  const bridge = fakeBridge({ loop: fakeLoop() });
  assert.equal(await bridge._accountIntoWorkspace('session-x', 'D:/dsh-qqchat'), false);
});
