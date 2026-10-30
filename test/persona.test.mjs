import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { PersonaBook } from '../lib/persona.js';

async function withDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-persona-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('persona file parses sections and ignores comments', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'persona.txt');
    await writeFile(file, [
      '# 这是注释',
      '',
      '[identity]',
      '你叫示例角色。',
      '',
      '[tone]',
      '- 句子短',
      '- 活泼',
      '',
      '[attachment]',
      '只粘主人。',
    ].join('\n'), 'utf8');
    const book = new PersonaBook({ file });
    const count = await book.load();
    assert.equal(book.source, 'file');
    assert.equal(count, 3);
    assert.equal(book.get('identity'), '你叫示例角色。');
    assert.ok(book.get('tone').includes('活泼'));
    assert.equal(book.has('likes'), false);
    const rendered = book.render(['identity', 'attachment']);
    assert.ok(rendered.includes('只粘主人'));
    assert.ok(!rendered.includes('句子短'));
  });
});

test('missing persona file falls back to built-in persona', async () => {
  await withDir(async (dir) => {
    const book = new PersonaBook({ file: path.join(dir, 'nope.txt') });
    await book.load();
    assert.equal(book.source, 'default');
    assert.ok(book.get('identity').includes('大肥鱼'));
  });
});
