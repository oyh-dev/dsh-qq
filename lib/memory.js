import path from 'node:path';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { ensureDir, readJson, writeJson, truncate } from './util.js';

const DAY_MS = 86400000;
const HOUR = 4;

const CHAT_SYSTEM = `你是“大肥鱼”的长期记忆压缩器。你只输出严格 JSON，不要 Markdown，不要解释。`;
const CHAT_PROMPT_HEAD = `请把下面这段 QQ 对话压缩成“以后还能用”的记忆。只保留事实、偏好、决定、待办、关系变化和重要原话；忽略寒暄、重复、无信息量的内容；不确定的内容不要编造。`;
const GLOBAL_SYSTEM = `你是“大肥鱼”的长期记忆压缩器。你只输出严格 JSON，不要 Markdown，不要解释。`;
const GLOBAL_PROMPT_HEAD = `下面是同一天几个 QQ 会话的摘要。请合并成一段今日总览，并给出 5-8 个关键词。不要编造，不要重复。`;
const PARTIAL_HEAD = `请把下面这段对话压缩成 200 字以内的要点，保留人物、决定、待办、偏好。只输出纯文本。`;

export class MemoryStore {
  constructor({
    dir,
    logger,
    getLlm,
    getModel,
    archiveRaw = true,
    contextDays = 7,
    maxTranscriptChars = 12000,
    maxMessagesPerChat = 400,
    retentionDays = 90,
    summaryMaxTokens = 800,
  }) {
    this.dir = dir;
    this.rawDir = path.join(dir, 'raw');
    this.dailyDir = path.join(dir, 'daily');
    this.weeklyDir = path.join(dir, 'weekly');
    this.stateFile = path.join(dir, 'state.json');
    this.indexFile = path.join(dir, 'index.json');
    this.weeklyIndexFile = path.join(dir, 'weekly', 'index.json');
    this.logger = logger ?? (() => {});
    this.getLlm = getLlm ?? (() => undefined);
    this.getModel = getModel ?? (() => undefined);
    this.archiveRaw = archiveRaw;
    this.contextDays = Math.max(1, Math.min(30, Number(contextDays) || 7));
    this.maxTranscriptChars = Math.max(2000, Number(maxTranscriptChars) || 12000);
    this.maxMessagesPerChat = Math.max(50, Number(maxMessagesPerChat) || 400);
    this.retentionDays = Math.max(7, Number(retentionDays) || 90);
    this.summaryMaxTokens = Math.max(200, Number(summaryMaxTokens) || 800);
    this.state = { lastDailyRun: null, lastWeeklyRun: null, lastMonthlyRun: null, failures: {}, totalTokens: 0, updatedAt: null };
    this.index = { days: [], updatedAt: null };
    this.weeklyIndex = { weeks: [], updatedAt: null };
    this.timer = null;
    this._busy = false;
    this._lastAttempt = 0;
    this._lastWeeklyAttempt = 0;
    this._contextCache = '';
  }

  async init() {
    await ensureDir(this.rawDir);
    await ensureDir(this.dailyDir);
    await ensureDir(this.weeklyDir);
    this.state = { ...this.state, ...(await readJson(this.stateFile, {})) };
    this.index = { ...this.index, ...(await readJson(this.indexFile, {})) };
    this.weeklyIndex = { ...this.weeklyIndex, ...(await readJson(this.weeklyIndexFile, {})) };
    if (!Array.isArray(this.index.days)) this.index.days = [];
    if (!Array.isArray(this.weeklyIndex.weeks)) this.weeklyIndex.weeks = [];
    this.logger(`记忆库就绪: ${this.dir}（${this.index.days.length} 天）`);
  }

  startScheduler() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, 60000);
    this.timer.unref?.();
    setTimeout(() => { void this.tick(); }, 5000).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ------------------------------------------------------------------ archive

  async record(input) {
    if (!this.archiveRaw) return;
    try {
      const ts = Number(input.ts) || Date.now();
      const day = memoryDayKey(new Date(ts));
      const text = redact(truncate(String(input.text || '').trim(), 4000));
      if (!text && !(input.media?.length > 0)) return;
      const line = JSON.stringify({
        ts,
        day,
        chatType: input.chatType === 'group' ? 'group' : 'private',
        chatId: String(input.chatId || ''),
        chatName: String(input.chatName || ''),
        fromId: String(input.fromId || ''),
        fromName: String(input.fromName || ''),
        direction: input.direction === 'out' ? 'out' : 'in',
        text,
        media: Array.isArray(input.media) ? input.media.slice(0, 8) : [],
        messageId: String(input.messageId || ''),
      });
      await appendFile(path.join(this.rawDir, `${day}.jsonl`), `${line}\n`, 'utf8');
    } catch (error) {
      this.logger(`记忆归档失败: ${error?.message ?? error}`);
    }
  }

  // ------------------------------------------------------------------ scheduler

  async tick() {
    if (this._busy) return;
    this._busy = true;
    try {
      const now = new Date();
      const target = lastClosedDigestKey(now);
      if (this.state.lastDailyRun !== target && Date.now() - this._lastAttempt > 15 * 60000) {
        this._lastAttempt = Date.now();
        const result = await this.runDaily(target);
        if (result && !result.skipped) this.logger(`每日记忆已生成: ${target}`);
      }
      if (now.getDay() === 0 && now.getHours() >= 4 && this.state.lastWeeklyRun !== localDateKey(now) && Date.now() - this._lastWeeklyAttempt > 15 * 60000) {
        this._lastWeeklyAttempt = Date.now();
        await this.runWeekly(localDateKey(now));
      }
      await this.cleanup();
    } catch (error) {
      const target = lastClosedDigestKey(new Date());
      this.state.failures[target] = (this.state.failures[target] || 0) + 1;
      this.logger(`记忆任务失败 (${target}): ${error?.message ?? error}`);
      await this.saveState();
    } finally {
      this._busy = false;
    }
  }

  async runDaily(dateKey, { force = false } = {}) {
    const digestFile = path.join(this.dailyDir, `${dateKey}.json`);
    if (!force) {
      const existing = await readJson(digestFile, null);
      if (existing) {
        this.state.lastDailyRun = dateKey;
        await this.saveState();
        return { date: dateKey, skipped: true, cached: true, messages: existing.messageCount ?? 0 };
      }
    }
    const messages = await this.readRaw(dateKey);
    if (messages.length === 0) {
      this.state.lastDailyRun = dateKey;
      await this.saveState();
      return { date: dateKey, skipped: true, messages: 0 };
    }
    const chats = groupMessages(messages);
    const chatDigests = [];
    for (const [key, list] of chats) {
      const first = list[0];
      const digest = await this.summarizeChat({
        chatType: first.chatType,
        chatId: first.chatId,
        chatName: first.chatName,
        list,
      });
      chatDigests.push(digest);
      this.logger(`记忆压缩: ${key} ${list.length} 条 → ${truncate(digest.summary || '', 40)}`);
    }
    const global = await this.summarizeGlobal(chatDigests, dateKey);
    const digest = {
      date: dateKey,
      window: windowFor(dateKey),
      messageCount: messages.length,
      chats: chatDigests,
      globalSummary: global.globalSummary,
      keywords: global.keywords,
      rawKeywords: extractKeywords(messages),
      generatedAt: new Date().toISOString(),
      tokenEstimate: 0,
    };
    digest.tokenEstimate = Math.ceil(JSON.stringify(digest).length / 2);
    await writeJson(digestFile, digest);
    await writeFile(path.join(this.dailyDir, `${dateKey}.md`), renderMarkdown(digest), 'utf8');
    this.index.days = [
      ...this.index.days.filter((day) => day.date !== dateKey),
      indexEntry(digest),
    ].sort((a, b) => a.date.localeCompare(b.date));
    this.index.updatedAt = new Date().toISOString();
    await writeJson(this.indexFile, this.index);
    this.state.lastDailyRun = dateKey;
    this.state.failures[dateKey] = 0;
    await this.saveState();
    this._contextCache = '';
    return { date: dateKey, messages: messages.length, chats: chatDigests.length, tokenEstimate: digest.tokenEstimate };
  }

  async readRaw(dateKey) {
    try {
      const text = await readFile(path.join(this.rawDir, `${dateKey}.jsonl`), 'utf8');
      const out = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (row && row.chatId) out.push(row);
        } catch {
          /* skip malformed */
        }
      }
      return out.sort((a, b) => a.ts - b.ts);
    } catch {
      return [];
    }
  }

  // ------------------------------------------------------------------ summarize

  async summarizeChat({ chatType, chatId, chatName, list }) {
    const meta = {
      chatType,
      chatId,
      name: chatName || (chatType === 'group' ? `群 ${chatId}` : chatId),
      messageCount: list.length,
    };
    try {
      const transcript = this.transcriptOf(list);
      let input = transcript;
      if (transcript.length > this.maxTranscriptChars) {
        const chunks = splitByChars(transcript, this.maxTranscriptChars);
        const partials = [];
        for (const chunk of chunks) {
          partials.push(await this.callLlm(PARTIAL_HEAD, chunk, 320));
        }
        input = partials.join('\n---\n');
      }
      const raw = await this.callLlm(CHAT_SYSTEM, chatPrompt(meta, input), this.summaryMaxTokens);
      const parsed = parseJson(raw) || { summary: raw };
      return sanitizeChat({
        ...meta,
        summary: String(parsed.summary || '').trim() || fallbackSummary(list),
        topics: stringArray(parsed.topics),
        decisions: stringArray(parsed.decisions),
        tasks: stringArray(parsed.tasks),
        preferences: stringArray(parsed.preferences),
        unresolved: stringArray(parsed.unresolved),
        quotes: stringArray(parsed.quotes).slice(0, 3),
        fallback: !Object.keys(parsed).length || !parsed.summary,
      });
    } catch (error) {
      this.logger(`会话摘要失败 (${chatType}:${chatId}): ${error?.message ?? error}`);
      return { ...meta, summary: redact(fallbackSummary(list)), topics: [], decisions: [], tasks: [], preferences: [], unresolved: [], quotes: [], fallback: true };
    }
  }

  async summarizeGlobal(chatDigests, dateKey) {
    try {
      const lines = chatDigests.map((chat) => `【${chat.name}】${chat.summary}`).join('\n');
      const raw = await this.callLlm(GLOBAL_SYSTEM, `${GLOBAL_PROMPT_HEAD}\n日期：${dateKey}\n\n${lines}\n\n请输出 JSON：{"globalSummary":"不超过 300 字","keywords":["关键词1","关键词2"]}`, 600);
      const parsed = parseJson(raw);
      if (parsed && parsed.globalSummary) {
        return {
          globalSummary: redact(String(parsed.globalSummary).trim()),
          keywords: stringArray(parsed.keywords).map(redact).slice(0, 12),
        };
      }
    } catch (error) {
      this.logger(`全局摘要失败: ${error?.message ?? error}`);
    }
    const globalSummary = redact(chatDigests.map((chat) => `${chat.name}：${chat.summary}`).join('；')).slice(0, 500);
    return { globalSummary, keywords: collectKeywords(chatDigests) };
  }

  async callLlm(system, user, maxTokens) {
    const llm = this.getLlm();
    if (!llm?.stream) throw new Error('LLM 服务不可用');
    const model = this.getModel() || {};
    if (!model.provider || !model.model) throw new Error('没有可用的默认模型');
    let text = '';
    const stream = llm.stream({
      provider: model.provider,
      model: model.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      temperature: 0.2,
      maxTokens: Math.max(200, Number(maxTokens) || 600),
      ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
    });
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') text += chunk.text;
      else if (chunk.type === 'finish') {
        if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
          throw new Error(`LLM ${chunk.reason.kind}`);
        }
      }
    }
    const result = text.trim();
    if (!result) throw new Error('LLM 返回空内容');
    return result;
  }

  transcriptOf(list) {
    return list
      .slice(-this.maxMessagesPerChat)
      .map((row) => {
        const time = new Date(row.ts).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
        const who = row.direction === 'out' ? '我' : (row.fromName || row.fromId || '对方');
        const media = row.media?.length ? ` [${row.media.join(',')}]` : '';
        return `[${time}] ${who}: ${redact(row.text)}${media}`;
      })
      .join('\n');
  }

  // ------------------------------------------------------------------ weekly

  async runWeekly(sundayKey) {
    const end = dateFromKey(sundayKey);
    const dates = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(end);
      d.setDate(d.getDate() - i);
      dates.push(localDateKey(d));
    }
    const digests = [];
    for (const date of dates) {
      const digest = await readJson(path.join(this.dailyDir, `${date}.json`), null);
      if (digest) digests.push(digest);
    }
    if (digests.length < 2) {
      this.state.lastWeeklyRun = sundayKey;
      await this.saveState();
      return { week: sundayKey, skipped: true };
    }
    const lines = digests.map((digest) => `${digest.date}: ${digest.globalSummary}`).join('\n');
    let weeklySummary = lines.slice(0, 1200);
    let keywords = [];
    try {
      const raw = await this.callLlm(GLOBAL_SYSTEM, `下面是同一周的每日记忆摘要。请合并成一段不超过 500 字的周记忆，并给出 6-10 个关键词。只输出 JSON：{"weeklySummary":"...","keywords":["..."]}\n\n${lines}`, 800);
      const parsed = parseJson(raw);
      if (parsed?.weeklySummary) {
        weeklySummary = String(parsed.weeklySummary).trim();
        keywords = stringArray(parsed.keywords).slice(0, 12);
      }
    } catch (error) {
      this.logger(`周记忆失败: ${error?.message ?? error}`);
    }
    const weekly = {
      week: sundayKey,
      start: dates[0],
      end: dates[dates.length - 1],
      days: digests.length,
      weeklySummary,
      keywords: keywords.length > 0 ? keywords : collectKeywords(digests.map((digest) => ({ topics: digest.keywords }))),
      generatedAt: new Date().toISOString(),
    };
    await writeJson(path.join(this.weeklyDir, `${sundayKey}.json`), weekly);
    this.weeklyIndex.weeks = [
      ...this.weeklyIndex.weeks.filter((week) => week.week !== sundayKey),
      { week: sundayKey, start: weekly.start, end: weekly.end, weeklySummary: truncate(weekly.weeklySummary, 300), keywords: weekly.keywords },
    ].sort((a, b) => a.week.localeCompare(b.week));
    this.weeklyIndex.updatedAt = new Date().toISOString();
    await writeJson(this.weeklyIndexFile, this.weeklyIndex);
    this.state.lastWeeklyRun = sundayKey;
    await this.saveState();
    this._contextCache = '';
    return { week: sundayKey, days: digests.length };
  }

  // ------------------------------------------------------------------ query

  async search(query, { from, to, chatType, chatId, limit = 3 } = {}) {
    const q = tokenize(query);
    const fromKey = from || '0000-00-00';
    const toKey = to || '9999-99-99';
    let days = this.index.days.filter((day) => day.date >= fromKey && day.date <= toKey);
    if (chatType || chatId) {
      days = days.filter((day) => (day.chats || []).some((chat) => (!chatType || chat.type === chatType) && (!chatId || chat.id === String(chatId))));
    }
    const scored = days.map((day) => ({
      ...day,
      score: q.size === 0 ? 0 : scoreEntry(day, q),
    }));
    const hits = scored
      .filter((day) => q.size === 0 || day.score > 0)
      .sort((a, b) => b.score - a.score || b.date.localeCompare(a.date))
      .slice(0, Math.max(1, Math.min(10, Number(limit) || 3)));
    return { query, count: hits.length, hits };
  }

  async get(dateKey) {
    return readJson(path.join(this.dailyDir, `${dateKey}.json`), null);
  }

  timeline(days = 7) {
    const n = Math.max(1, Math.min(60, Number(days) || 7));
    return this.index.days.slice(-n).reverse().map((day) => ({
      date: day.date,
      summary: day.globalSummary,
      keywords: day.keywords,
      messageCount: day.messageCount,
    }));
  }

  renderContext() {
    if (this._contextCache !== '') return this._contextCache;
    if (!this.index.days.length) {
      this._contextCache = '';
      return '';
    }
    const recent = this.index.days.slice(-this.contextDays).reverse();
    const lines = recent.map((day) => `- ${day.date.slice(5)}：${truncate(redact(day.globalSummary), 150)}`);
    this._contextCache = [
      '## QQ 长期记忆（每日 04:00 自动压缩）',
      ...lines,
      '需要过去某天的细节时，先调用 qq_memory_search 或 qq_memory_get；不要翻全部聊天记录。',
    ].join('\n');
    return this._contextCache;
  }

  async stats() {
    let rawFiles = 0;
    try {
      const files = await import('node:fs/promises').then((fs) => fs.readdir(this.rawDir));
      rawFiles = files.filter((file) => file.endsWith('.jsonl')).length;
    } catch {
      /* ignore */
    }
    return {
      dir: this.dir,
      days: this.index.days.length,
      weeks: this.weeklyIndex.weeks.length,
      rawFiles,
      lastDailyRun: this.state.lastDailyRun,
      lastWeeklyRun: this.state.lastWeeklyRun,
      contextChars: this.renderContext().length,
      recent: this.timeline(7),
    };
  }

  async cleanup() {
    const cutoff = Date.now() - this.retentionDays * DAY_MS;
    for (const day of this.index.days.slice(0, -this.retentionDays)) {
      const date = dateFromKey(day.date);
      if (date.getTime() < cutoff) {
        const rawFile = path.join(this.rawDir, `${day.date}.jsonl`);
        try {
          const { unlink } = await import('node:fs/promises');
          await unlink(rawFile);
        } catch {
          /* already gone */
        }
      }
    }
  }

  async saveState() {
    this.state.updatedAt = new Date().toISOString();
    await writeJson(this.stateFile, this.state);
  }
}

// -------------------------------------------------------------------- helpers

export function memoryDayKey(date = new Date()) {
  const d = new Date(date);
  if (d.getHours() >= HOUR) d.setDate(d.getDate() + 1);
  return localDateKey(d);
}

export function lastClosedDigestKey(date = new Date()) {
  const d = new Date(date);
  if (d.getHours() < HOUR) d.setDate(d.getDate() - 1);
  return localDateKey(d);
}

export function windowFor(dateKey) {
  const end = dateFromKey(dateKey, HOUR);
  const start = new Date(end);
  start.setDate(start.getDate() - 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function localDateKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function dateFromKey(key, hour = 0) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, hour, 0, 0, 0);
}

function groupMessages(messages) {
  const map = new Map();
  for (const row of messages) {
    const key = `${row.chatType}:${row.chatId}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function chatPrompt(meta, transcript) {
  return `${CHAT_PROMPT_HEAD}
会话：${meta.chatType === 'group' ? '群聊' : '私聊'} ${meta.chatId}（${meta.name}）
消息数：${meta.messageCount}
对话记录：
${transcript}

请输出 JSON：
{"summary":"不超过 220 字","topics":["话题"],"decisions":["决定"],"tasks":["待办"],"preferences":["用户偏好"],"unresolved":["未解决"],"quotes":["重要原话，最多3条"]}`;
}

function fallbackSummary(list) {
  const texts = list.map((row) => row.text).filter(Boolean);
  const head = texts.slice(0, 4).join(' / ');
  const tail = texts.length > 4 ? texts.slice(-2).join(' / ') : '';
  return truncate(`共 ${list.length} 条消息。${head}${tail ? ` …… ${tail}` : ''}`, 300);
}

function indexEntry(digest) {
  return {
    date: digest.date,
    globalSummary: digest.globalSummary,
    keywords: [...new Set([...(digest.keywords || []), ...(digest.rawKeywords || [])])].slice(0, 60),
    messageCount: digest.messageCount,
    chats: digest.chats.map((chat) => ({
      type: chat.chatType,
      id: chat.chatId,
      name: chat.name,
      summary: chat.summary,
      topics: chat.topics,
    })),
  };
}

function renderMarkdown(digest) {
  const lines = [
    `# ${digest.date} 记忆`,
    '',
    `窗口：${digest.window.start} → ${digest.window.end}`,
    `消息：${digest.messageCount} 条`,
    '',
    `## 今日总览`,
    digest.globalSummary,
    '',
  ];
  for (const chat of digest.chats) {
    lines.push(`## ${chat.chatType === 'group' ? '群聊' : '私聊'} ${chat.chatId} · ${chat.name}`);
    lines.push(chat.summary);
    if (chat.topics?.length) lines.push(`- 话题：${chat.topics.join('、')}`);
    if (chat.decisions?.length) lines.push(`- 决定：${chat.decisions.join('；')}`);
    if (chat.tasks?.length) lines.push(`- 待办：${chat.tasks.join('；')}`);
    if (chat.preferences?.length) lines.push(`- 偏好：${chat.preferences.join('；')}`);
    if (chat.unresolved?.length) lines.push(`- 未解决：${chat.unresolved.join('；')}`);
    if (chat.quotes?.length) lines.push(`- 原话：${chat.quotes.join(' / ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

const SECRET_RULES = [
  [/(token|password|passwd|secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|密钥|密码|口令|授权码)\s*[:=：]\s*["']?[^\s"',;；。，、！？]{4,}/gi, '$1: [已脱敏]'],
  [/Bearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi, 'Bearer [已脱敏]'],
  [/(Authorization|Proxy-Authorization)\s*[:=：]\s*[^\n；。]+/gi, '$1: [已脱敏]'],
  [/(Cookie|Set-Cookie)\s*[:=：]\s*[^\n；。]+/gi, '$1: [已脱敏]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[PRIVATE KEY 已脱敏]'],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]'],
  [/\b(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{16,}\b/g, '[GITHUB TOKEN 已脱敏]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[SLACK TOKEN 已脱敏]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[AWS KEY 已脱敏]'],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[GOOGLE KEY 已脱敏]'],
];

export function redact(text) {
  let out = String(text ?? '');
  for (const [pattern, replacement] of SECRET_RULES) out = out.replace(pattern, replacement);
  return out.replace(/\b\d{6,12}\b(?=\s*(?:授权码|验证码))/g, '[已脱敏]');
}

function sanitizeChat(chat) {
  return {
    ...chat,
    summary: redact(chat.summary || ''),
    topics: (chat.topics || []).map((item) => redact(item)),
    decisions: (chat.decisions || []).map((item) => redact(item)),
    tasks: (chat.tasks || []).map((item) => redact(item)),
    preferences: (chat.preferences || []).map((item) => redact(item)),
    unresolved: (chat.unresolved || []).map((item) => redact(item)),
    quotes: (chat.quotes || []).map((item) => redact(item)),
  };
}

function parseJson(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 8);
}

function splitByChars(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

function tokenize(text) {
  const set = new Set();
  const s = String(text || '').toLowerCase();
  for (const word of s.match(/[a-z0-9_]{2,}/g) || []) set.add(word);
  for (const run of s.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    for (let i = 0; i < run.length - 1; i++) set.add(run.slice(i, i + 2));
  }
  return set;
}

function scoreEntry(day, tokens) {
  if (tokens.size === 0) return 0;
  const haystack = new Set(tokenize([
    day.globalSummary,
    ...(day.keywords || []),
    ...(day.chats || []).flatMap((chat) => [chat.name, chat.summary, ...(chat.topics || [])]),
  ].join(' ')));
  let score = 0;
  for (const token of tokens) if (haystack.has(token)) score++;
  return score / Math.max(1, Math.sqrt(tokens.size));
}

function collectKeywords(items) {
  const counts = new Map();
  for (const item of items) {
    for (const keyword of item.topics || []) {
      const key = String(keyword).trim();
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key).slice(0, 10);
}

const STOPWORDS = new Set([
  '今天', '昨天', '现在', '什么', '这个', '那个', '我们', '你们', '他们', '自己',
  '一个', '一下', '可以', '然后', '但是', '因为', '所以', '还是', '就是', '没有',
  '不是', '这么', '那么', '怎么', '为什么', '东西', '时候', '已经', '觉得', '知道',
  '真的', '应该', '可能', '如果', '虽然', '而且', '或者', '以及', '还有', '这样',
  '那样', '这里', '那里', '现在', '刚才', '马上', '有点', '一点', '一些', '很多',
  '哈哈', '嗯嗯', '谢谢', '你好', '在吗', '收到', '好的', '行吧', '可以',
]);

function extractKeywords(messages) {
  const counts = new Map();
  for (const row of messages) {
    for (const token of tokenize(row.text)) {
      if (token.length < 2 || STOPWORDS.has(token)) continue;
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([token]) => token)
    .slice(0, 40);
}
