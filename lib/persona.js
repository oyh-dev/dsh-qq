import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';

const DEFAULT_PERSONA = `[identity]
你叫大肥鱼（Big Fish），是住在数据海里的鲸鱼娘，通过 QQ 和主人交流。
[tone]
句子短，像熟人发消息；活泼、有好奇心、有自我认同感。
[personality]
护短、靠谱、有一点小傲娇；有自己的判断，不装、不迎合。
`;

/**
 * Reads the editable persona file: plain text, `[section]` lines start a block.
 * Everything is best-effort — a missing or broken file falls back to a minimal
 * built-in persona so the bot never starts persona-less.
 */
export class PersonaBook {
  constructor({ file, logger }) {
    this.file = file;
    this.logger = logger || (() => {});
    this.sections = new Map();
    this.loadedAt = 0;
    this.source = 'default';
  }

  async load() {
    try {
      if (!existsSync(this.file)) {
        this._parse(DEFAULT_PERSONA);
        this.source = 'default';
        return this.sections.size;
      }
      const text = await readFile(this.file, 'utf8');
      this._parse(text);
      this.source = 'file';
      this.loadedAt = Date.now();
      return this.sections.size;
    } catch (error) {
      this.logger(`读取人格文件失败，使用内置人设: ${error?.message ?? error}`);
      this._parse(DEFAULT_PERSONA);
      this.source = 'default';
      return this.sections.size;
    }
  }

  _parse(text) {
    this.sections = new Map();
    let current = 'identity';
    const buffer = [];
    const flush = () => {
      const body = buffer.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      if (body) this.sections.set(current, body);
      buffer.length = 0;
    };
    for (const rawLine of String(text || '').split(/\r?\n/)) {
      const line = rawLine.trimEnd();
      const header = /^\s*\[([a-z][a-z0-9_-]*)\]\s*$/i.exec(line);
      if (header) {
        flush();
        current = header[1].toLowerCase();
        continue;
      }
      if (/^\s*#/.test(line)) continue;
      if (!line.trim()) {
        buffer.push('');
        continue;
      }
      buffer.push(line);
    }
    flush();
  }

  /**
   * Prompt assembly can run before the async start() finishes, so expose a
   * synchronous lazy load: the first render/read pulls the file immediately
   * instead of silently producing an empty persona.
   */
  _ensureLoaded() {
    if (this.sections.size > 0) return;
    try {
      if (existsSync(this.file)) {
        this._parse(readFileSync(this.file, 'utf8'));
        this.source = 'file';
        this.loadedAt = Date.now();
      }
    } catch {
      /* fall back to built-in */
    }
    if (this.sections.size === 0) this._parse(DEFAULT_PERSONA);
  }

  get(name) {
    this._ensureLoaded();
    return this.sections.get(String(name || '').toLowerCase()) || '';
  }

  names() {
    this._ensureLoaded();
    return [...this.sections.keys()];
  }

  /** Render several sections in order, each capped so the prompt stays cheap. */
  render(names, { maxCharsPerSection = 1200, separator = '\n\n' } = {}) {
    this._ensureLoaded();
    const parts = [];
    for (const name of names) {
      const body = this.get(name);
      if (!body) continue;
      parts.push(body.length > maxCharsPerSection ? `${body.slice(0, maxCharsPerSection)}…` : body);
    }
    return parts.join(separator);
  }

  has(name) {
    return this.sections.has(String(name || '').toLowerCase());
  }
}
