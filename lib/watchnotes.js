import path from 'node:path';
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';

const MAX_ENTRIES = 500;
const MAX_POINTS = 6;

function clean(value, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeName(value) {
  return String(value || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'unknown';
}

/**
 * 「看过的视频」笔记库——**故意跟记忆库分开放**。
 *
 * 记忆库记的是「我和他之间发生过什么」，会进每轮上下文、会被压缩、会衰减；
 * 这里记的是「我看过什么、它讲了什么」，平时不进上下文，她想翻才翻。
 * 两边生命周期、敏感度、出错半径都不一样，混在一起出问题时不好切。
 *
 * 原始字幕/音频只在目录里活到「总结完成」那一刻，之后删掉；留下的是几十到
 * 一两百字的要点。所以磁盘不会越滚越大，上下文也不会被口播原文灌满。
 */
export class WatchNotes {
  constructor({ dir, logger }) {
    this.dir = dir;
    this.notesDir = path.join(dir, 'notes');
    this.rawDir = path.join(dir, 'raw');
    this.logger = logger || (() => {});
    this.entries = [];
    this.loaded = false;
  }

  async load() {
    this.entries = [];
    try {
      await mkdir(this.notesDir, { recursive: true });
      const names = (await readdir(this.notesDir)).filter((name) => name.endsWith('.json'));
      for (const name of names) {
        try {
          const raw = JSON.parse(await readFile(path.join(this.notesDir, name), 'utf8'));
          if (raw && raw.bvid) this.entries.push(this._shape(raw));
        } catch { /* 坏一条不影响别的 */ }
      }
      this.entries.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(0, MAX_ENTRIES);
    } catch {
      this.entries = [];
    }
    this.loaded = true;
    return this.entries.length;
  }

  _shape(raw) {
    return {
      bvid: clean(raw.bvid, 24),
      kind: raw.kind === 'meme' ? 'meme' : 'bili',
      title: clean(raw.title, 120),
      author: clean(raw.author, 60),
      day: clean(raw.day, 12),
      ts: Number(raw.ts) || 0,
      duration: Number(raw.duration) || 0,
      source: raw.source === 'asr' ? 'asr' : 'none',
      chars: Number(raw.chars) || 0,
      points: Array.isArray(raw.points) ? raw.points.map((p) => clean(p, 80)).filter(Boolean).slice(0, MAX_POINTS) : [],
      memes: Array.isArray(raw.memes) ? raw.memes.map((m) => clean(m, 30)).filter(Boolean).slice(0, 8) : [],
      // 看到第几张 / 一共几张 / 是不是没看完就走了
      shown: Number(raw.shown) || 0,
      total: Number(raw.total) || 0,
      partial: raw.partial === true,
    };
  }

  _file(bvid) {
    return path.join(this.notesDir, `${safeName(bvid)}.json`);
  }

  /** 原始字幕/音频的落盘位置；总结完立刻删。 */
  rawPath(bvid, ext = 'txt') {
    return path.join(this.rawDir, `${safeName(bvid)}.${ext}`);
  }

  async saveRaw(bvid, ext, content) {
    await mkdir(this.rawDir, { recursive: true });
    const file = this.rawPath(bvid, ext);
    await writeFile(file, content, 'utf8');
    return file;
  }

  async dropRaw(bvid, ext = 'txt') {
    try {
      await unlink(this.rawPath(bvid, ext));
    } catch { /* 已经没了就算了 */ }
  }

  /** 存一条笔记。同名（同 bvid）会覆盖——一条视频只留一份最新的理解。 */
  async add(input) {
    const entry = this._shape({
      bvid: input?.bvid,
      kind: input?.kind,
      title: input?.title,
      author: input?.author,
      day: input?.day,
      ts: input?.ts || Date.now(),
      duration: input?.duration,
      source: input?.source,
      chars: input?.chars,
      points: input?.points,
      memes: input?.memes,
      shown: input?.shown,
      total: input?.total,
      partial: input?.partial,
    });
    if (!entry.bvid) throw new Error('笔记缺少 bvid');
    await mkdir(this.notesDir, { recursive: true });
    await writeFile(this._file(entry.bvid), JSON.stringify(entry, null, 2), 'utf8');
    this.entries = [entry, ...this.entries.filter((item) => item.bvid !== entry.bvid)]
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
      .slice(0, MAX_ENTRIES);
    return entry;
  }

  get(bvid) {
    return this.entries.find((item) => item.bvid === String(bvid || '')) || null;
  }

  list(limit = 10) {
    return this.entries.slice(0, Math.max(1, Math.min(50, limit)));
  }

  search(query, limit = 5) {
    const text = clean(query, 60).toLowerCase();
    if (!text) return this.list(limit);
    const scored = [];
    for (const entry of this.entries) {
      const haystack = `${entry.title} ${entry.author} ${entry.points.join(' ')} ${entry.memes.join(' ')}`.toLowerCase();
      let score = 0;
      if (entry.title.toLowerCase().includes(text)) score += 40;
      if (entry.memes.some((meme) => meme.toLowerCase().includes(text))) score += 25;
      if (haystack.includes(text)) score += 15;
      for (const token of text.split(/\s+/).filter(Boolean)) {
        if (haystack.includes(token)) score += 5;
      }
      if (score > 0) scored.push({ entry, score });
    }
    scored.sort((a, b) => b.score - a.score || b.entry.ts - a.entry.ts);
    return scored.slice(0, Math.max(1, Math.min(20, limit))).map((item) => item.entry);
  }

  stats(now = Date.now()) {
    const dayStart = new Date(new Date(now).toDateString()).getTime();
    return {
      total: this.entries.length,
      today: this.entries.filter((item) => (item.ts || 0) >= dayStart).length,
      withAudio: this.entries.filter((item) => item.source === 'asr').length,
    };
  }

  /** 只留最近的几百条，其余连同原始文件一起清掉。 */
  async prune(max = MAX_ENTRIES) {
    const keep = this.entries.slice(0, max);
    const drop = this.entries.slice(max);
    for (const entry of drop) {
      try {
        await unlink(this._file(entry.bvid));
      } catch { /* 已经没了 */ }
    }
    this.entries = keep;
    return drop.length;
  }
}
