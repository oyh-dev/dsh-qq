import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const MAX_ENTRIES = 400;
const MAX_FIELD = 200;
/** 被否掉之后多久不许主动再用（小时）。 */
export const MEME_BLOCK_HOURS = 24;
/** 改动幅度低于这个相似度就算「说法打架」，不再静默覆盖。 */
const CONFLICT_SIMILARITY = 0.35;

function clean(value, max = MAX_FIELD) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeKey(name) {
  return clean(name, 60).toLowerCase().replace(/[\s"'“”「」『』·.,，。!！?？]/g, '');
}

/** 两条解释的字符二元组重合度：同一件事换个说法 ≈0.5 以上，换了意思 ≈0.2 以下。 */
function similarity(a, b) {
  const grams = (text) => {
    const s = String(text || '').replace(/\s+/g, '');
    const out = new Set();
    for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let hit = 0;
  for (const gram of ga) if (gb.has(gram)) hit += 1;
  return hit / Math.min(ga.size, gb.size);
}

/**
 * A tiny personal "梗百科" notebook: the assistant watches meme-explainer videos
 * and records what it learned, so later chatting can sound fluent instead of
 * reciting a definition.
 */
export class MemeBook {
  constructor({ file, logger }) {
    this.file = file;
    this.logger = logger || (() => {});
    this.entries = [];
    this.loaded = false;
  }

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      const list = Array.isArray(raw) ? raw : Array.isArray(raw?.entries) ? raw.entries : [];
      this.entries = list
        .filter((item) => item && item.name)
        .map((item) => ({
          name: clean(item.name, 60),
          meaning: clean(item.meaning),
          usage: clean(item.usage),
          origin: clean(item.origin, 120),
          bvid: clean(item.bvid, 24),
          addedAt: Number(item.addedAt) || Date.now(),
          hits: Number(item.hits) || 0,
          // 认知状态：ok=他说过没问题 / doubt=自己没底或被他否过 / conflict=两种说法打架
          status: ['ok', 'doubt', 'conflict'].includes(item.status) ? item.status : 'ok',
          wrongCount: Number(item.wrongCount) || 0,
          okCount: Number(item.okCount) || 0,
          lastCorrection: clean(item.lastCorrection, 120),
          lastWrongAt: Number(item.lastWrongAt) || 0,
          lastOkAt: Number(item.lastOkAt) || 0,
          blockedUntil: Number(item.blockedUntil) || 0,
          history: Array.isArray(item.history) ? item.history.slice(-3) : [],
        }))
        .slice(-MAX_ENTRIES);
    } catch {
      this.entries = [];
    }
    this.loaded = true;
    return this.entries.length;
  }

  async save() {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify({ entries: this.entries }, null, 2), 'utf8');
  }

  /**
   * Insert or merge by name; returns the stored entry plus whether it was new.
   * 2026-10-28：同名但意思对不上时不再静默覆盖——旧说法进 history、状态降到 doubt，
   * 让她知道「这里有两条打架的说法」，而不是把前一次学的东西悄悄擦掉。
   */
  async add(input) {
    const name = clean(input?.name, 60);
    if (!name) throw new Error('梗名不能为空');
    const key = normalizeKey(name);
    const existing = this.entries.find((item) => normalizeKey(item.name) === key);
    const patch = {
      meaning: clean(input?.meaning),
      usage: clean(input?.usage),
      origin: clean(input?.origin, 120),
      bvid: clean(input?.bvid, 24),
    };
    const wantedStatus = ['ok', 'doubt', 'conflict'].includes(input?.status) ? input.status : '';
    if (existing) {
      const before = existing.meaning;
      if (patch.meaning && before && similarity(patch.meaning, before) < CONFLICT_SIMILARITY) {
        existing.history = [...(existing.history || []), { meaning: before, at: existing.addedAt || Date.now() }].slice(-3);
        existing.status = 'conflict';
      }
      for (const field of ['meaning', 'usage', 'origin', 'bvid']) {
        if (patch[field]) existing[field] = patch[field];
      }
      if (wantedStatus) existing.status = wantedStatus;
      // 状态回到 ok → 解禁，允许重新主动用
      if (existing.status === 'ok') existing.blockedUntil = 0;
      existing.addedAt = existing.addedAt || Date.now();
      await this.save();
      return { entry: existing, created: false, conflicted: existing.status === 'conflict' };
    }
    const entry = {
      name,
      ...patch,
      addedAt: Date.now(),
      hits: 0,
      status: wantedStatus || 'ok',
      wrongCount: 0,
      okCount: 0,
      lastCorrection: '',
      lastWrongAt: 0,
      lastOkAt: 0,
      blockedUntil: 0,
      history: [],
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    await this.save();
    return { entry, created: true };
  }

  /** 这段话里出现了笔记本里的哪几个梗（名字长度 ≥2 才算，避免单字误伤）。 */
  matchIn(text, limit = 3) {
    const source = String(text || '');
    if (!source) return [];
    const hits = [];
    for (const entry of this.entries) {
      const name = entry.name;
      if (name.length < 2) continue;
      if (source.includes(name)) hits.push(entry);
      if (hits.length >= limit) break;
    }
    return hits;
  }

  /** 他把我刚用的梗顶回来了：记一笔，状态降级，24 小时禁主动使用。 */
  async markWrong(name, { quote = '', blockHours = MEME_BLOCK_HOURS, now = Date.now() } = {}) {
    const entry = this.entries.find((item) => normalizeKey(item.name) === normalizeKey(name));
    if (!entry) return null;
    entry.wrongCount = (entry.wrongCount || 0) + 1;
    entry.lastWrongAt = now;
    entry.lastCorrection = clean(quote, 120);
    entry.status = 'doubt';
    entry.blockedUntil = now + Math.max(1, blockHours) * 3600000;
    await this.save();
    return entry;
  }

  /** 改完再用、或者用了没被顶：算一次「用对了」。 */
  async markOk(name, { now = Date.now() } = {}) {
    const entry = this.entries.find((item) => normalizeKey(item.name) === normalizeKey(name));
    if (!entry) return null;
    entry.okCount = (entry.okCount || 0) + 1;
    entry.lastOkAt = now;
    // 用对两次就把「存疑」撤了：一次可能是运气，两次才算我懂了
    if (entry.status !== 'ok' && entry.okCount >= 2) {
      entry.status = 'ok';
      entry.blockedUntil = 0;
    }
    await this.save();
    return entry;
  }

  /** 面板/事实层要的概览。 */
  stats(now = Date.now()) {
    const doubt = this.entries.filter((item) => item.status === 'doubt' || item.status === 'conflict').length;
    const blocked = this.entries.filter((item) => Number(item.blockedUntil) > now).length;
    return { total: this.entries.length, doubt, blocked };
  }

  search(query, limit = 5) {
    const text = clean(query, 60).toLowerCase();
    if (!text) return this.recent(limit);
    const tokens = text.split(/\s+/).filter(Boolean);
    const scored = [];
    for (const entry of this.entries) {
      const haystack = `${entry.name} ${entry.meaning} ${entry.usage} ${entry.origin}`.toLowerCase();
      let score = 0;
      if (normalizeKey(entry.name) === normalizeKey(text)) score += 100;
      if (entry.name.toLowerCase().includes(text)) score += 40;
      for (const token of tokens) if (haystack.includes(token)) score += 10;
      if (score > 0) scored.push({ entry, score: score + entry.hits });
    }
    scored.sort((a, b) => b.score - a.score || b.entry.addedAt - a.entry.addedAt);
    return scored.slice(0, limit).map((item) => item.entry);
  }

  recent(limit = 10) {
    return this.entries.slice(-limit).reverse();
  }

  count() {
    return this.entries.length;
  }

  touch(name) {
    const key = normalizeKey(name);
    const entry = this.entries.find((item) => normalizeKey(item.name) === key);
    if (entry) entry.hits += 1;
  }

  /** Compact one-line-per-meme sheet for the system prompt; kept deliberately short. */
  cheatSheet(limit = 14, maxChars = 900) {
    if (this.entries.length === 0) return '';
    const lines = [];
    let used = 0;
    for (const entry of this.recent(limit)) {
      const gloss = entry.meaning || entry.usage || '';
      const line = `- ${entry.name}${gloss ? `：${gloss.slice(0, 46)}` : ''}`;
      if (used + line.length > maxChars) break;
      used += line.length;
      lines.push(line);
    }
    if (lines.length === 0) return '';
    return lines.reverse().join('\n');
  }
}
