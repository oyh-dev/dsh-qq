import path from 'node:path';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const DEFAULT_DAILY = 3;
const DEFAULT_TOTAL = 200;
const MIN_BYTES = 3 * 1024;
const MAX_BYTES = 10 * 1024 * 1024;
const MIN_SHORT_SIDE = 80;
const MAX_LONG_SIDE = 1600;

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

function extFor(mediaType, name = '') {
  const byName = String(name).toLowerCase().match(/\.(png|jpe?g|gif|webp)$/);
  if (byName) return byName[0].replace('jpeg', 'jpg');
  const map = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
  return map[mediaType] || '.png';
}

/**
 * Sticker shelf: collects only real stickers (animated / 表情包 marks), with
 * quality gates, dedupe, a per-day quota and a hard total cap. Nothing here is
 * ever sent automatically — the agent has to pick one on purpose.
 */
export class StickerStore {
  constructor({ dir, logger, getSize, dailyLimit = DEFAULT_DAILY, totalLimit = DEFAULT_TOTAL }) {
    this.dir = dir;
    this.logger = logger || (() => {});
    this.getSize = getSize; // async (filePath) => { width, height } | null
    this.dailyLimit = Math.max(1, Number(dailyLimit) || DEFAULT_DAILY);
    this.totalLimit = Math.max(this.dailyLimit, Number(totalLimit) || DEFAULT_TOTAL);
    this.entries = [];
    this.seen = {};      // hash -> times seen from the owner
    this.day = '';
    this.todayCount = 0;
    this.indexFile = path.join(dir, 'index.json');
  }

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.indexFile, 'utf8'));
      this.entries = Array.isArray(raw?.entries) ? raw.entries : [];
      this.seen = raw?.seen && typeof raw.seen === 'object' ? raw.seen : {};
      this.day = String(raw?.day || '');
      this.todayCount = Number(raw?.todayCount) || 0;
    } catch {
      this.entries = [];
      this.seen = {};
    }
    return this.entries.length;
  }

  async save() {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.indexFile, JSON.stringify({
      day: this.day,
      todayCount: this.todayCount,
      entries: this.entries,
      seen: this.seen,
    }, null, 2), 'utf8');
  }

  _rollDay(dayKey) {
    if (this.day === dayKey) return;
    this.day = dayKey;
    this.todayCount = 0;
  }

  /**
   * Decide whether an inbound image is worth keeping as a sticker.
   * Returns { saved, reason?, entry? }.
   */
  async consider({ bytes, mediaType, name, animated = false, stickerMarked = false, dayKey, source = 'owner' }) {
    this._rollDay(dayKey);
    if (!bytes || bytes.byteLength === 0) return { saved: false, reason: 'empty' };
    if (!animated && !stickerMarked) return { saved: false, reason: 'not-sticker' };
    if (bytes.byteLength < MIN_BYTES) return { saved: false, reason: 'too-small' };
    if (bytes.byteLength > MAX_BYTES) return { saved: false, reason: 'too-large' };

    const hash = hashBytes(bytes);
    this.seen[hash] = (this.seen[hash] || 0) + 1;
    if (this.entries.some((entry) => entry.hash === hash)) {
      await this.save();
      return { saved: false, reason: 'duplicate' };
    }
    if (this.entries.length >= this.totalLimit) {
      await this.save();
      return { saved: false, reason: 'shelf-full' };
    }
    if (this.todayCount >= this.dailyLimit) {
      await this.save();
      return { saved: false, reason: 'daily-quota' };
    }

    const ext = extFor(mediaType, name);
    const tmp = path.join(this.dir, `.candidate${ext}`);
    await mkdir(this.dir, { recursive: true });
    await writeFile(tmp, bytes);
    const size = await this.getSize?.(tmp) ?? null;
    if (size && (Math.min(size.width, size.height) < MIN_SHORT_SIDE || Math.max(size.width, size.height) > MAX_LONG_SIDE)) {
      await this.save();
      return { saved: false, reason: 'bad-dimensions' };
    }

    // Value score: expressive (animated) + reusable (compact) + familiar (owner repeats it).
    const score = (animated ? 1 : 0)
      + (size && size.width <= 800 && size.height <= 800 ? 1 : 0)
      + (this.seen[hash] >= 2 ? 1 : 0);
    if (score < 2) {
      await this.save();
      return { saved: false, reason: `low-score:${score}` };
    }

    await copyFile(tmp, path.join(this.dir, `${hash}${ext}`));
    const entry = {
      hash,
      name: String(name || '').trim().slice(0, 40),
      file: path.join(this.dir, `${hash}${ext}`),
      ext,
      animated: Boolean(animated),
      width: size?.width ?? null,
      height: size?.height ?? null,
      bytes: bytes.byteLength,
      source,
      tags: animated ? ['动图'] : ['表情包'],
      addedAt: Date.now(),
    };
    this.entries.push(entry);
    this.todayCount += 1;
    await this.save();
    return { saved: true, entry, score };
  }

  /** Manual save (agent judged it worth keeping): quality gates only, no score. */
  async add({ bytes, mediaType, name, tags = [], source = 'manual', animated = false }) {
    if (!bytes || bytes.byteLength === 0) throw new Error('图片为空');
    if (bytes.byteLength > MAX_BYTES) throw new Error('图片太大（>10MB），不适合当表情包');
    const hash = hashBytes(bytes);
    const existing = this.entries.find((entry) => entry.hash === hash);
    if (existing) return { created: false, entry: existing };
    if (this.entries.length >= this.totalLimit) throw new Error(`表情库已满（${this.totalLimit}）`);
    await mkdir(this.dir, { recursive: true });
    const ext = extFor(mediaType, name);
    const file = path.join(this.dir, `${hash}${ext}`);
    await writeFile(file, bytes);
    const size = await this.getSize?.(file) ?? null;
    const entry = {
      hash,
      name: String(name || '').trim().slice(0, 40),
      file,
      ext,
      animated: Boolean(animated),
      width: size?.width ?? null,
      height: size?.height ?? null,
      bytes: bytes.byteLength,
      source,
      tags: normalizeTags(tags),
      addedAt: Date.now(),
    };
    this.entries.push(entry);
    this.seen[hash] = (this.seen[hash] || 0) + 1;
    await this.save();
    return { created: true, entry };
  }

  list(limit = 20) {
    return this.entries.slice(-limit).reverse();
  }

  search(query, limit = 5) {
    const text = String(query || '').trim().toLowerCase();
    if (!text) return this.list(limit);
    return this.entries
      .filter((entry) => `${entry.hash} ${entry.tags.join(' ')} ${entry.ext}`.toLowerCase().includes(text))
      .slice(-limit)
      .reverse();
  }

  find(key) {
    const text = String(key || '').trim();
    if (!text) return null;
    const lower = text.toLowerCase();
    return this.entries.find((entry) => entry.hash === lower)
      || this.entries.find((entry) => (entry.name || '').toLowerCase() === lower)
      || this.entries.find((entry) => entry.tags.some((tag) => tag.toLowerCase() === lower))
      || this.entries.find((entry) => (entry.name || '').toLowerCase().includes(lower))
      || this.entries.find((entry) => lower.length >= 6 && entry.hash.startsWith(lower))
      || null;
  }

  count() {
    return this.entries.length;
  }

  stats() {
    return {
      total: this.entries.length,
      todayCount: this.todayCount,
      dailyLimit: this.dailyLimit,
      totalLimit: this.totalLimit,
      animated: this.entries.filter((entry) => entry.animated).length,
    };
  }
}

function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : tags ? String(tags).split(/[,，\s]+/) : [];
  return [...new Set(list.map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 6);
}
