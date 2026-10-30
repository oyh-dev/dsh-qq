import path from 'node:path';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

function dayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function timeKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Her own diary: plain Markdown, one file per day, append-only.
 *
 * It is deliberately stored as normal readable files (not a private blob) so the
 * owner can read or delete it — a diary she hides from him would be a weird kind
 * of asymmetry.
 */
export class DiaryStore {
  constructor({ dir, logger }) {
    this.dir = dir;
    this.logger = logger || (() => {});
  }

  fileFor(date) {
    return path.join(this.dir, `${dayKey(date)}.md`);
  }

  async append({ text, mood = '', tags = [], at = new Date() }) {
    const content = String(text || '').trim();
    if (!content) throw new Error('日记内容不能为空');
    await mkdir(this.dir, { recursive: true });
    const file = this.fileFor(at);
    const fresh = !existsSync(file);
    const header = `# ${dayKey(at)} 大肥鱼的日记\n\n`;
    const moodLine = mood ? `（${String(mood).trim()}）` : '';
    const tagLine = Array.isArray(tags) && tags.length > 0 ? ` #${tags.map((t) => String(t).trim()).filter(Boolean).join(' #')}` : '';
    const line = `- ${timeKey(at)} ${moodLine}${content}${tagLine}\n`;
    if (fresh) await writeFile(file, header, 'utf8');
    await writeFile(file, line, { flag: 'a', encoding: 'utf8' });
    return { file, day: dayKey(at), time: timeKey(at) };
  }

  async read(date) {
    const file = this.fileFor(date);
    try {
      return { date: dayKey(date), file, text: await readFile(file, 'utf8') };
    } catch {
      return { date: dayKey(date), file, text: '' };
    }
  }

  async list(limit = 7) {
    try {
      const files = (await readdir(this.dir)).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name));
      files.sort().reverse();
      return files.slice(0, Math.max(1, limit)).map((name) => ({ date: name.replace(/\.md$/, ''), file: path.join(this.dir, name) }));
    } catch {
      return [];
    }
  }

  async recent(limit = 5) {
    const files = await this.list(limit);
    const out = [];
    for (const item of files) {
      const { text } = await this.read(item.date);
      const entries = text.split(/\r?\n/).filter((line) => line.startsWith('- ')).map((line) => line.slice(2).trim());
      out.push({ date: item.date, entries });
    }
    return out;
  }

  async search(query, limit = 10) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return [];
    const hits = [];
    for (const item of await this.list(60)) {
      const { text } = await this.read(item.date);
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith('- ')) continue;
        if (!line.toLowerCase().includes(needle)) continue;
        hits.push({ date: item.date, line: line.slice(2).trim() });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  }

  async stats() {
    const files = await this.list(3650);
    return { dir: this.dir, days: files.length, latest: files[0]?.date ?? null };
  }
}
