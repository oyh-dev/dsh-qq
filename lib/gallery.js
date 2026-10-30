import path from 'node:path';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const MAX_ENTRIES = 2000;

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

function extFor(mediaType, name = '') {
  const byName = String(name).toLowerCase().match(/\.(png|jpe?g|gif|webp)$/);
  if (byName) return byName[0].replace('jpeg', 'jpg');
  const map = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
  return map[mediaType] || '.jpg';
}

/**
 * Visual memory: every image she actually saw, kept with enough metadata to be
 * found later ("the Rolex screenshot you sent that time").
 *
 * Captions are written on demand by the agent (it already saw the picture), so
 * ingesting an image costs no tokens.
 */
export class GalleryStore {
  constructor({ dir, logger, maxBytes = 4 * 1024 * 1024, getSize }) {
    this.dir = dir;
    this.imagesDir = path.join(dir, 'images');
    this.indexFile = path.join(dir, 'index.json');
    this.logger = logger || (() => {});
    this.maxBytes = Math.max(64 * 1024, Number(maxBytes) || 4 * 1024 * 1024);
    this.getSize = getSize;
    this.entries = [];
  }

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.indexFile, 'utf8'));
      this.entries = Array.isArray(raw?.entries) ? raw.entries : [];
    } catch {
      this.entries = [];
    }
    return this.entries.length;
  }

  async save() {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.indexFile, JSON.stringify({ entries: this.entries }, null, 2), 'utf8');
  }

  /** Store an image; returns { created, entry } (dedupe by content hash). */
  async add({ bytes, mediaType, name, meta = {} }) {
    if (!bytes || bytes.byteLength === 0) throw new Error('图片为空');
    if (bytes.byteLength > this.maxBytes) throw new Error(`图片太大（${Math.round(bytes.byteLength / 1024)}KB）`);
    const hash = sha(bytes);
    const existing = this.entries.find((entry) => entry.hash === hash);
    if (existing) {
      // Same picture again: only enrich the metadata, never duplicate the file.
      if (meta.context && !existing.context) existing.context = String(meta.context).slice(0, 120);
      if (meta.chatId && !existing.chatId) existing.chatId = String(meta.chatId);
      await this.save();
      return { created: false, entry: existing };
    }
    await mkdir(this.imagesDir, { recursive: true });
    const ext = extFor(mediaType, name);
    const file = path.join(this.imagesDir, `${hash}${ext}`);
    await writeFile(file, bytes);
    const size = await this.getSize?.(file).catch(() => null) ?? null;
    const now = Date.now();
    const entry = {
      hash,
      file,
      ext,
      mediaType: mediaType || 'image/jpeg',
      width: size?.width ?? null,
      height: size?.height ?? null,
      bytes: bytes.byteLength,
      addedAt: now,
      day: String(meta.day || ''),
      chatType: String(meta.chatType || 'private'),
      chatId: String(meta.chatId || ''),
      fromId: String(meta.fromId || ''),
      fromName: String(meta.fromName || ''),
      messageId: String(meta.messageId || ''),
      context: String(meta.context || '').slice(0, 120),
      caption: String(meta.caption || '').slice(0, 160),
      tags: normalizeTags(meta.tags),
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    await this.save();
    return { created: true, entry };
  }

  get(key) {
    const text = String(key || '').trim().toLowerCase();
    if (!text) return null;
    return this.entries.find((entry) => entry.hash === text)
      || this.entries.find((entry) => lowerIncludes(entry.caption, text))
      || this.entries.find((entry) => lowerIncludes(entry.context, text))
      || this.entries.find((entry) => entry.tags.some((tag) => lowerIncludes(tag, text)))
      || null;
  }

  search({ query = '', from = '', to = '', chatId = '', limit = 8 } = {}) {
    const needle = String(query || '').trim().toLowerCase();
    const startDay = String(from || '');
    const endDay = String(to || '');
    const chat = String(chatId || '');
    return this.entries
      .filter((entry) => {
        if (chat && entry.chatId !== chat) return false;
        if (startDay && entry.day < startDay) return false;
        if (endDay && entry.day > endDay) return false;
        if (!needle) return true;
        const haystack = `${entry.caption} ${entry.context} ${entry.tags.join(' ')} ${entry.fromName} ${entry.day}`.toLowerCase();
        return haystack.includes(needle);
      })
      .sort((a, b) => b.addedAt - a.addedAt)
      .slice(0, Math.max(1, Math.min(50, Number(limit) || 8)));
  }

  recent(limit = 8) {
    return this.entries.slice(-Math.max(1, Number(limit) || 8)).reverse();
  }

  async note(key, { caption, tags, context } = {}) {
    const entry = this.get(key);
    if (!entry) throw new Error(`图库里找不到「${key}」`);
    if (caption) entry.caption = String(caption).slice(0, 160);
    if (context) entry.context = String(context).slice(0, 120);
    if (Array.isArray(tags) && tags.length > 0) entry.tags = normalizeTags(tags);
    await this.save();
    return entry;
  }

  async stats() {
    let bytes = 0;
    for (const entry of this.entries) {
      try {
        bytes += (await stat(entry.file)).size;
      } catch {
        /* file missing, ignore */
      }
    }
    return {
      dir: this.dir,
      total: this.entries.length,
      bytes,
      latest: this.entries.at(-1)?.day ?? null,
      captioned: this.entries.filter((entry) => entry.caption).length,
    };
  }
}

function lowerIncludes(value, needle) {
  return String(value || '').toLowerCase().includes(needle);
}

function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : tags ? String(tags).split(/[,，\s]+/) : [];
  return [...new Set(list.map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 8);
}
