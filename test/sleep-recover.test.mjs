import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { QqBridge } from '../lib/bridge.js';

/**
 * 睡着+断网：那段时间的消息可能根本没进纸条，醒来要从聊天档案里补回来
 * —— 但**不当掉线处理**，只当是他睡前的留言。
 */

const OWNER = '1000000001';

function bridgeWithLog(dir) {
  const bridge = Object.create(QqBridge.prototype);
  bridge.cfg = { chatLogDir: dir };
  bridge.owners = new Set([OWNER]);
  bridge.log = () => {};
  bridge._proactiveTarget = () => OWNER;
  return bridge;
}

async function writeLog(dir, day, rows) {
  const folder = path.join(dir, `private-${OWNER}`);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, `${day}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n'), 'utf8');
}

test('补纸条：只捞窗口内的来消息，发出去的不算', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sleep-recover-'));
  const day = '2026-10-29';
  const t0 = new Date(2026, 9, 29, 2, 0, 0).getTime();
  await writeLog(dir, day, [
    { direction: 'in', chat_id: OWNER, ts: new Date(t0 + 60000).toISOString(), text: '我先睡了，晚安' },
    { direction: 'out', chat_id: OWNER, ts: new Date(t0 + 120000).toISOString(), text: '这条是我发的' },
    { direction: 'in', chat_id: OWNER, ts: new Date(t0 - 3600000).toISOString(), text: '睡着之前那句' },
  ]);
  const bridge = bridgeWithLog(dir);
  const notes = await bridge._missedNotesDuring(t0, t0 + 600000, []);
  assert.equal(notes.length, 1, '只补睡眠窗口内、且是他发的');
  assert.match(notes[0].text, /我先睡了/);
  assert.equal(notes[0].recovered, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test('补纸条：纸条里已经有的不重复补', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sleep-recover2-'));
  const day = '2026-10-29';
  const t0 = new Date(2026, 9, 29, 2, 0, 0).getTime();
  await writeLog(dir, day, [
    { direction: 'in', chat_id: OWNER, ts: new Date(t0 + 60000).toISOString(), text: '重复的那条' },
  ]);
  const bridge = bridgeWithLog(dir);
  const notes = await bridge._missedNotesDuring(t0, t0 + 600000, [{ text: '重复的那条' }]);
  assert.equal(notes.length, 0);
  await fs.rm(dir, { recursive: true, force: true });
});

test('窗口不合法（起点为空或晚于终点）就什么都不做', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sleep-recover3-'));
  const bridge = bridgeWithLog(dir);
  assert.deepEqual(await bridge._missedNotesDuring(0, Date.now(), []), []);
  assert.deepEqual(await bridge._missedNotesDuring(Date.now(), Date.now() - 1000, []), []);
  await fs.rm(dir, { recursive: true, force: true });
});
