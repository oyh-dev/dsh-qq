import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { readJson } from '../lib/util.js';

test('带 BOM 的 JSON 也要读得出来', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'util-bom-'));
  try {
    const file = path.join(dir, 'a.json');
    // PowerShell 的 Set-Content -Encoding UTF8 就是这个形状
    await writeFile(file, `\uFEFF{"enabled": false}`, 'utf8');
    const value = await readJson(file, null);
    assert.equal(value?.enabled, false, 'BOM 不该让整份配置变成「没有」');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('真坏掉的 JSON 还是回退，不硬造', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'util-bad-'));
  try {
    const file = path.join(dir, 'b.json');
    await writeFile(file, '{ broken', 'utf8');
    assert.equal(await readJson(file, 'fallback'), 'fallback');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
