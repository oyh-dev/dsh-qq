/**
 * 认知层：我对「他是什么人」的判断。
 *
 * 和记忆的区别不在内容，在于**能不能被一句话推翻**：
 *   记忆 = 发生过什么（有日期、有原话，错了只能叫「记错了」）
 *   认知 = 我从那些事里得出的结论（有出处，可能不准，他说不是就得改）
 *
 * 所以分文件、分注入段。认知不会随时间淡掉，只会被 superseded——
 * 因为「我昨天觉得他讨厌被嘱咐」这件事本身，是发生过的事实。
 *
 * 文件格式：append-only jsonl，一行一个动作，读的时候折叠成当前状态。
 *   { op: 'add', id, key, text, day, quote, at }
 *   { op: 'confirm', id, at }        —— 同一个判断被再次印证
 *   { op: 'revoke', id, reason, at } —— 被推翻
 * 这样「改过什么」永远查得到，跟 persona-growth.md 一个口径。
 */

import path from 'node:path';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { truncate } from './util.js';

const DAY = 86400000;

/** 判断的归一化：去掉标点空白，用来判重和定位。 */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s，。！？、；：""''（）()《》【】.!?,;:'"()[\]]+/g, '');
}

/** 二元组：拿它判断「这条判断跟眼下这句话有没有关系」。跟加权记忆同一把尺子。 */
function bigrams(input) {
  const clean = String(input || '').replace(/[\s，。！？、…~～,.!?"'「」『』【】()（）:：;；]/g, '');
  const out = new Set();
  for (let index = 0; index + 1 < clean.length; index += 1) out.add(clean.slice(index, index + 2));
  return [...out].slice(0, 60);
}

/**
 * 相关性判断用的两把尺子：
 * ① 二元组——同一个说法被原样再提起（「嘱咐」「生图」「跑通」）
 * ② 实词单字——换了说法但还在讲同一件事（「别催我」vs「怎么又在催」）
 * 停用字先剔掉，不然「我/你/不/是」会把所有句子都判成相关。
 */
const STOP_CHARS = new Set('的了吧啊呀哦嘛嗯呢吗么我你他她它是不在有就都也还很最会能要别让把给对和与这那个一上下来去说做想看知可以没再又要过们啥'.split(''));

function contentChars(input) {
  const clean = String(input || '').replace(/[\s，。！？、…~～,.!?"'「」『』【】()（）:：;；0-9a-zA-Z]/g, '');
  const out = new Set();
  for (const char of clean) if (!STOP_CHARS.has(char)) out.add(char);
  return out;
}

/**
 * 这条判断跟眼下这句话有没有关系。两把尺子：
 * ① 二元组撞上 ≥2 个：同一个说法被原样再提起（「嘱咐」「跑通」「生图」）
 * ② 实词撞上 ≥2 个：换了说法但还在讲同一件事
 * 门槛必须 ≥2：只撞一个「图」或「用」，什么句子都成相关了——
 * 那是假相关，比不注入更坏。
 */
function relates(record, grams, chars) {
  const hay = new Set(bigrams(`${record.text}${record.quote}`));
  let hits = 0;
  for (const gram of grams) if (hay.has(gram)) hits += 1;
  if (hits >= 2) return true;
  const hayChars = contentChars(`${record.text}${record.quote}`);
  let shared = 0;
  for (const char of chars) if (hayChars.has(char)) shared += 1;
  return shared >= 2;
}

function shortId(key) {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) % 0x7fffffff;
  }
  return hash.toString(36).padStart(5, '0').slice(-5);
}

export class JudgmentsStore {
  /**
   * @param dir   存到哪个目录（跟记忆同一个 memoryDir）
   * @param logger 可选日志
   */
  constructor({ dir, logger = () => {} } = {}) {
    this.file = path.join(dir || '.', 'judgments.jsonl');
    this.logger = logger;
    this.records = new Map(); // key -> record
    this.used = new Map(); // key -> 最近一次被注入的时间（只在内存里，重启清零）
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return this;
    this.loaded = true;
    let raw = '';
    try {
      raw = await readFile(this.file, 'utf8');
    } catch {
      return this;
    }
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let row = null;
      try { row = JSON.parse(trimmed); } catch { continue; }
      this._apply(row);
    }
    return this;
  }

  /** 折叠一行动作到内存状态里。 */
  _apply(row) {
    const op = String(row?.op || '');
    const id = String(row?.id || '');
    const key = String(row?.key || id);
    if (!id) return;
    if (op === 'add') {
      const existing = this.records.get(key);
      if (existing && existing.status === 'active') {
        // 已经信过一遍的判断又来一次：不算新条目，算「被印证」
        existing.confirmed += 1;
        existing.lastConfirmedAt = Number(row.at) || existing.lastConfirmedAt;
        return;
      }
      this.records.set(key, {
        id,
        key,
        text: String(row.text || ''),
        day: String(row.day || ''),
        quote: String(row.quote || ''),
        status: 'active',
        confirmed: 1,
        at: Number(row.at) || Date.now(),
        lastConfirmedAt: Number(row.at) || Date.now(),
        rejected: existing?.rejected || 0,
        supersededBy: '',
      });
      return;
    }
    if (op === 'confirm') {
      const record = this.records.get(key);
      if (!record || record.status !== 'active') return;
      record.confirmed += 1;
      record.lastConfirmedAt = Number(row.at) || record.lastConfirmedAt;
      return;
    }
    if (op === 'revoke') {
      const record = this.records.get(key);
      if (!record) return;
      record.status = 'superseded';
      record.revokedAt = Number(row.at) || Date.now();
      record.revokedReason = String(row.reason || '');
      record.rejected += 1;
    }
  }

  async _append(row) {
    await mkdir(path.dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(row)}\n`, 'utf8');
    this._apply(row);
  }

  /**
   * 记一条判断。同一个意思再记一次 → 变成「已确认 N 次」，不产生重复条目。
   * @param text  判断本身，一句话
   * @param day   出处日期（YYYY-MM-DD）
   * @param quote 他的原话（出处，不许空——没出处的判断只是猜）
   */
  async add({ text, day = '', quote = '', at = Date.now() }) {
    await this.load();
    const clean = truncate(String(text || '').trim(), 60);
    if (!clean) throw new Error('判断不能为空');
    const source = truncate(String(quote || '').trim(), 40);
    if (!source) throw new Error('没有出处就不记——判断必须挂在他的一句话上');
    const key = normalize(clean);
    const existing = this.records.get(key);
    const merged = Boolean(existing && existing.status === 'active');
    if (merged) {
      await this._append({ op: 'confirm', id: existing.id, key, at: Number(at) || Date.now() });
      return { merged: true, record: this.records.get(key) };
    }
    const base = shortId(key);
    let id = base;
    for (let suffix = 1; [...this.records.values()].some((record) => record.id === id); suffix += 1) {
      id = `${base}-${suffix}`;
    }
    await this._append({
      op: 'add',
      id,
      key,
      text: clean,
      day: String(day || ''),
      quote: source,
      at: Number(at) || Date.now(),
    });
    return { merged: false, record: this.records.get(key) };
  }

  /** 推翻一条（按 id、原文片段或归一化 key 都能找）。保留旧记录，不删。 */
  async revoke({ key = '', reason = '', at = Date.now() } = {}) {
    await this.load();
    const record = this.find(key);
    if (!record) throw new Error(`没有找到这条判断：${key}`);
    if (record.status !== 'active') return { record, already: true };
    await this._append({ op: 'revoke', id: record.id, key: record.key, reason: String(reason || ''), at: Number(at) || Date.now() });
    return { record: this.records.get(record.key) };
  }

  /** 按 id / 归一化文本 / 原文片段定位一条。 */
  find(query = '') {
    const raw = String(query || '').trim();
    if (!raw) return null;
    for (const record of this.records.values()) {
      if (record.id === raw) return record;
    }
    const normalized = normalize(raw);
    if (this.records.has(normalized)) return this.records.get(normalized);
    for (const record of this.records.values()) {
      if (record.text.includes(raw)) return record;
    }
    return null;
  }

  list({ status = 'active' } = {}) {
    const rows = [...this.records.values()];
    return status === 'all' ? rows : rows.filter((record) => record.status === status);
  }

  /** 排序：确认过的靠前，久没被印证的往后掉（三天一层，最多掉三层）。 */
  rank({ now = Date.now() } = {}) {
    const rows = this.list({ status: 'active' });
    const scored = rows.map((record) => {
      const ageDays = Math.max(0, (now - Number(record.lastConfirmedAt || record.at)) / DAY);
      const decay = Math.min(3, ageDays / 3);
      return { record, score: record.confirmed * 2 - decay };
    });
    return scored
      .sort((a, b) => b.score - a.score || b.record.lastConfirmedAt - a.record.lastConfirmedAt)
      .map((item) => item.record);
  }

  /**
   * 挑这一轮要注入哪几条。
   *
   * 先按**相关性**筛：跟眼下这句话得真撞上（≥2 个二元组），撞不上就闭嘴——
   * 顶多留一条「底线判断」（确认过 3 次以上的），免得我对他一无所知还硬聊。
   * 再按**最近用过**降权：6 小时内刚拿这把锤子敲过，就换个锤子。
   *
   * 宁可少说，也不要把不相干的判断往他脸上套——凑数是明显的错，
   * 不相干是安静的错，后者更难抓。
   */
  pick({ text = '', limit = 4, now = Date.now(), usedWindowMs = 6 * 3600000, baselineConfirmed = 3 } = {}) {
    const active = this.list({ status: 'active' });
    if (!active.length) return [];
    const grams = new Set(bigrams(text));
    const chars = contentChars(text);
    const relevanceOn = grams.size > 0 || chars.size > 0;

    const scored = active.map((record) => {
      const hay = new Set(bigrams(`${record.text}${record.quote}`));
      let hits = 0;
      for (const gram of grams) if (hay.has(gram)) hits += 1;
      const ageDays = Math.max(0, (now - Number(record.lastConfirmedAt || record.at)) / DAY);
      let score = record.confirmed * 2 - Math.min(3, ageDays / 3) + hits * 1.5;
      // 刚用过的判断降权：不然每轮都在念同一句
      if (now - (this.used.get(record.key) || 0) < usedWindowMs) score -= 2;
      return { record, hits, related: relates(record, grams, chars), score };
    });
    const byScore = (a, b) => b.score - a.score || b.record.lastConfirmedAt - a.record.lastConfirmedAt;

    // 「这次用的是哪几条」当场记下来——降权靠它，所以 pick 自己标记，别指望调用方
    const mark = (records) => {
      for (const record of records) this.used.set(record.key, now);
      return records;
    };
    const cap = Math.max(0, Number(limit) || 0);

    if (!relevanceOn) {
      // 没给消息（面板、自检）就不筛，按老规矩取前几条；也不标记，免得把自检当成真用过
      return scored.sort(byScore).slice(0, cap).map((item) => item.record);
    }

    const related = scored.filter((item) => item.related).sort(byScore);
    if (related.length > 0) {
      return mark(related.slice(0, cap).map((item) => item.record));
    }
    // 一条都没撞上：只留一条够硬的底线判断，其余全部闭嘴
    const baseline = scored
      .filter((item) => item.record.confirmed >= baselineConfirmed)
      .sort(byScore)[0];
    return baseline ? mark([baseline.record]) : [];
  }

  /** 给这一轮用的注入段。跟记忆段分开写，措辞不同：
   * 记忆那段说「当背景、别当台词念」；这段说「可以预判，但能被一句话推翻」。 */
  render({ text = '', limit = 4, now = Date.now(), chars = 360 } = {}) {
    const top = this.pick({ text, limit, now });
    if (!top.length) return '';
    const lines = [];
    let used = 0;
    for (const record of top) {
      const day = record.day ? record.day.slice(5) : '';
      const source = [day, record.quote ? `「${truncate(record.quote, 18)}」` : ''].filter(Boolean).join(' ');
      const times = record.confirmed > 1 ? `，确认过 ${record.confirmed} 次` : '';
      const line = `· ${record.text}（出处 ${source || '未记'}${times}）`;
      if (used + line.length > chars) break;
      lines.push(line);
      used += line.length;
    }
    if (!lines.length) return '';
    return [
      '【我对他的判断——可能不准，一句话就能推翻】',
      ...lines,
      '→ 可以用来预判，但他说「不是这样」就当场改，别拿它当事实到处套；改动用 qq_judgment action=revoke。',
    ].join('\n');
  }

  async stats() {
    await this.load();
    return this.snapshot();
  }

  /** 同步拿一份计数（面板用，不触发加载）。 */
  snapshot() {
    const active = this.list({ status: 'active' }).length;
    const superseded = this.list({ status: 'superseded' }).length;
    return { total: active + superseded, active, superseded, loaded: this.loaded, file: this.file };
  }
}
