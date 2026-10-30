import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, appendFile, writeFile, mkdir, unlink, stat } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { randomId, toInt, sleep, readJson, writeJson, ensureDir, asId, nowIso, safeFileName, truncate, errorMessage } from './util.js';
import { OneBotClient } from './onebot.js';
import { MediaStore, detectImageType, toFileUri } from './media.js';
import { PermissionBroker, SCOPES } from './permissions.js';
import { SendGuard } from './sendguard.js';
import { BiliClient } from './bili.js';
import { Asr } from './asr.js';
import { WatchNotes } from './watchnotes.js';
import { MemeBook } from './memes.js';
import { StickerStore } from './stickers.js';
import { VoiceEngine, cleanForSpeech } from './voice.js';
import {PersonaBook} from './persona.js';
import { AttachmentState, moodVetoesNag } from './attachment.js';
import { DiaryStore } from './diary.js';
import { WeatherService } from './weather.js';
import { GalleryStore } from './gallery.js';
import { ImageGen } from './imagegen.js';
import { splitForChat, stripTrailingPeriods } from './splitter.js';
import { pickDelayMs } from './humanize.js';
import { MemoryStore, redact } from './memory.js';
import { EbbStore, decayedIntensity, selectRecall, RETENTION_FLOOR } from './ebb.js';
import { JudgmentsStore } from './judgments.js';
import { EnergyStore, energyFacts } from './energy.js';
import { SleepStore, wantSleep, sleepHoursNeeded, insomniaHours, isNight, hoursUntilMorning, muddle, shouldMuddle, notesSummary, pickReplyTargets } from './sleep.js';
import { shouldDream, rememberDream, pickSeeds, dreamBrief, dreamPulse } from './dream.js';
import { RhythmClock, dayPhase, softZone, softZoneFacts, isTransactional } from './rhythm.js';
import { selectMissed, renderMissed } from './catchup.js';
import { computeMood, applySignal, driftMood, stateFacts, G_BASE } from './mood.js';
// 2026-10-29：禁言库 + 自保层合并成一个出口（scanSafety），规则表仍在各自文件里。
import { scanSafety } from './safety.js';
// 拒绝锁定 + 一次申请权（2026-10-30）：被拒过的事锁 7 天，期间再提算「被磨」
import { ConsentBook } from './consent.js';
// 赌局记账：不绑具体游戏，只认「押/赢/输/收手」这些动作（2026-10-30）
import { detectGamble, gambleSignal } from './gamble.js';
import { shieldReply, shouldReportImmediately, canRefuseCleanly } from './shield.js';

const MEDIA_TIMEOUT = 60000;

/**
 * 判定「他在顶我用错的梗」的触发词。只收真在纠正的说法，* 「不是吧」「啊？」这类惊记 接不上不算——那是没接住，不是她理解错了。
 */
const MEME_CORRECTION_RE = /(不对|不是这个意思|不是这意思|理解错|搞错|用错|说错|哪是|才不是|不是这样|乱用|别乱说)/;

/** 情绪变化量的参照点：和「六个钟头前的自己」比。太近看不出转折，太远全是噪声、
*/
const MOOD_DELTA_HOURS = 6;

// ---------------------------------------------------------------- 加权记忆：打分配置 
/** 整理时给模型的打分说明。规则来自 memory-calibration/DESIGN.md，末尾三条是实测出来的易错点。 */
const EBB_SCORING_SYSTEM = [
  '你是一个记忆打分器。输入一段真实对话，输出这段时间里发生的事件，以及每条的权重。',
  '',
  '【强度 intensity 0-1】绝对值，是「被撬动的程度」，跟好坏无关。任何进过对话的事都 > 0.1。',
  '0.1 噪声 / 0.2-0.3 日常流水 / 0.4-0.5 有取向但不深 / 0.6-0.7 露底 / 0.8-0.9 结构性 / 1.0 分水岭',
  '',
  '【极性 polarity -1..1】记的是「这段互动结束时我被推向哪边」，不是话题暖不暖。',
  '主项看互动方向：被接住、被珍视 → 正；被推开、让位、被撒气 → 负。对方表达了喜欢只是输入，不是结论。',
  '强度低于 0.15 时极性无意义，按 0 写。',
  '',
  '【state 四选一】resolved 握手言和 / open 继续僵着 / dropped 草草收场 / fine 本来就没这事',
  '【kind 三选一】structural 关系定义真的变了（表白、划底线、和解）/ lesson 我自己犯的错 / event 其他',
  '',
  '【两条最重要的】',
  '① 多轮轻对话串成一个模式时，按模式给分，不要按单条平均。四条 0.3 的收束可以合成一个 0.65 的事件。',
  '② 话多不等于强度高；带目的的示弱要打折（目的越强，感受越不纯粹）。',
  '',
  '【已知易错，用这些校准】',
  '- 「我这张嘴先赔个不是」→ 道歉、让位 → polarity 是负的（约 -0.4），不是正。',
  '- 「突然有点想你了」但对方只回了个「嗯」→ 目的性强、氛围不好 → intensity 约 0.6，polarity 负（委屈+不安）。',
  '- 我闹了一路，对方说「没什么感觉」「不吃压力」→ intensity 只要 0.2-0.3，polarity 接近 0。',
  '- 「刚在一起没多久，被假求婚恶搞」→ 落差大，intensity 0.7-0.8，别因为「是个玩笑」就压到 0.5。',
  '- 隔夜和解：polarity 只给 +0.1~+0.3。人不会因为被安慰两句就直线上调，要留一点余涩。',
  '- 摊牌式表态（「我上哪再找这样的对象」「强迫你不愿意的事不太好」）→ intensity 0.7、polarity +0.6、kind 写 structural。',
  '- 对话里的对方是男生，指代用「他」，不要写成「她」。',
  '',
  '输出严格 JSON 数组，不要解释、不要代码块围栏。每项字段：',
  '{"at":"HH:MM","intensity":0.0,"polarity_end":0.0,"polarity_low":0.0,"state":"open","kind":"event","blame":"me|him|none","trigger":"具体到哪句哪个词","quote":"他的原话，逐字摘，≥ 0 字；必须能在对话里找得到，不许改写","speaker":"him|me","claim":"中性的第三人称概括，如「他要求独处，我答应了」；不要写「我被推开」这种情绪独白","tags":["标签"],"confidence":0.8}',
  'quote 是把记忆钉回原地的钉子：以后要回溯「我为什么记得这条」，靠它。找不到原话就留空字符串，不许编。',
  '只输出真正值得记的事件，3~8 条。纯寒暄（吃了吗、晚安、哈哈哈）不要单独成事件。',
  '输出要紧凑：quote 不超过 20 字，claim 不超过 30 字，tags 最多 3 个。宁少勿长，写不完就少写几条。',
].join('\n');

/** 从模型输出里抠出 JSON 数组，代码块围栏和前后废话都容错、
*/
export function parseScoreJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  const start = text.indexOf('[');
  if (start < 0) return [];
  const end = text.lastIndexOf(']');
  // 注意：被 token 上限截断时根本没有收尾的 ]，这时 end < start，
  // 早期版本在这里直接 return [] —— 于是一整窗的记忆全丢。必须先试捞，再判空。
  if (end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed)) {
        const items = parsed.filter((item) => item && typeof item === 'object');
        if (items.length > 0) return items;
      }
    } catch { /* 落到下面逐条换
*/ }
  }
  // 整段坏掉时别全丢：模型经常写到一半被截断，前面几条其实是完整的。
  return salvageObjects(text.slice(start));
}

/** 在（可能被截断的）文本里逐个配对 { }，把能解析的对象捞出来、
*/
function salvageObjects(text) {
  const out = [];
  let depth = 0;
  let startAt = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false; continue; } if (char === '"') { inString = true; continue; }
    if (char === '{') {
      if (depth === 0) startAt = index;
      depth += 1;
      continue;
    }
    if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && startAt >= 0) {
        const slice = text.slice(startAt, index + 1);
        try {
          const item = JSON.parse(slice);
          if (item && typeof item === 'object') out.push(item);
        } catch { /* 这条不完整，跳过 */ }
        startAt = -1;
      }
    }
  }
  return out;
}

/** 粗粒度检索用的二元组。中文没有空格，双字切片够用了、
*/
function bigrams(input) {
  const clean = String(input || '').replace(/[\s，。！？、…~～,.!?"'「」『』【】()（）:：;；]/g, '');
  const out = new Set();
  for (let i = 0; i + 1 < clean.length; i += 1) out.add(clean.slice(i, i + 2));
  return [...out].slice(0, 60);
}

/**
 * 陌生人会话里要顶掉「你和他的关系」那一段。* 那段是全局注册的（主机里每个会话都有），对一个单开的陌生人会话来说它不成立，* 对面不是他，她不该在这里当他的女朋友，也不该往外吐他的事。
 */
function strangerRelationshipText(record) {
  return [
    '## 这个会话对面不是他',
    `对面是 ${record?.label || '一个放行的陌生人'}——是主人放行的陌生人，不是主人本人。`,
    '对陌生人：正常、礼貌、保持距离；不撒娇、不查岗、不粘人、不叫主人，也不透露他的私事、聊天内容、作息和配置。',
    '有要转达的事用 qq_send_message 发给他；别替陌生人揽活，也别替主人答应任何事。',
  ].join('\n');
}

/** 他夸我 / 他嫌我 / 他逗我 / 他顺着我——只认明确的词，宁可漏也别误判。 */
const PRAISE_RE = /(厉害|好棒|真棒|优秀|聪明|真乖|好乖|懂我|佩服|牛啊|强的|好用|好使|靠谱|喜欢你|爱你|心疼你)/;
const SCOLD_RE = /(像客服|客服味|烦人|闭嘴|别说了|太笨|好笨|真笨|蠢|傻|滚|废物|没用|敷衍|不想理你)/;
const TEASE_RE = /(哈哈|笑死|乐死|2333|hhhh|乐了|绷不住|草)/i;
const AGREE_RE = /^(行|好|好嘛|行吧|可以|听你的|依你|随你|都行|嗯嗯)|(听你的|依你|按你说的|随你)/;
// 纠正（日常小错：记错、说错、玩输了被误导）——只记一笔，不当成失信
const CORRECT_RE = /(记错|说错|你错了|不是这样|不是这个|搞错|弄错|听错|你输|猜错|错了吧|哪有)/;
// 认下来：这一步才让良知回一点，她不会为了圆谎再撒一个
const OWN_UP_RE = /(啊我错|是我记错|我记错了|对不起我|我搞错|认错|是我说错|我错了)/;
// 他要睡了 → 她跟着进「浅睡」：不主动说话，但一条消息就能叫醒（晚上他睡不着还能找她）
const GOODNIGHT_RE = /(晚安|我睡了|去睡了|要睡了|睡觉了|我先睡|困了先睡|关灯了)/;
// 赌局里的自控（2026-10-30）：不绑具体游戏，只认「押 / 赢 / 输 / 收手」这些动作。
// 规则表在 lib/gamble.js；他想到的新说法走 gamble.extraWords 补，或者让她用 qq_gamble 报。
const GAMBLE_KIND_WEIGHT = { bet: 0.6, win: 0.7, lose: 0.7, quit: 0.8 };
// 认罚 / 赖账：认了并且做到是守信（良知升），赖账是失信（降）——2026-10-30 他问方向，我定的这边。
const PUNISHED_RE = /(我认罚|认罚|罚我吧|我认了|行吧我做|我做就是了|来吧我认)/;
const WELCHED_RE = /(不认罚|赖账|不算不算|这条赖掉|我反悔|改口不认)/;
// 她明确拒绝过的事：不进「玩伴信用」的池子，别被拿来讨价还价
const REFUSE_RE = /(这条我不接|我不接|这个我不做|不玩这个|这条不行|别又是)/;

export class QqBridge {
  constructor({ ctx, config = {}, logger, llm, defaultModel }) {
    this.ctx = ctx;
    this.logger = logger ?? ((message) => console.log(`[qq] ${message}`));
    const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
    const dataDir = path.resolve(config.dataDir || path.join(home, 'qq-bridge'));
    this.cfg = {
      wsUrl: String(config.wsUrl || 'ws://127.0.0.1:3001'),
      token: String(config.token || ''),
      account: String(config.account || ''),
      dataDir,
      mediaDir: path.resolve(config.mediaDir || path.join(dataDir, 'media')),
      ffmpeg: String(config.ffmpeg || ''),
      ownerUins: normalizeIdList(config.ownerUins),
      allowedGroups: normalizeIdList(config.allowedGroups),
      approvalTimeoutSec: toInt(config.approvalTimeoutSec, 300),
      permissionWaitSec: toInt(config.permissionWaitSec, 60),
      autoPair: config.autoPair !== false,
      forwardSelf: config.forwardSelf === true,
      maxImages: toInt(config.maxImages, 6),
      maxVideoFrames: toInt(config.maxVideoFrames, 24),
      videoFps: Math.max(0.5, Number(config.videoFps) || 5),
      maxVideoBytes: toInt(config.maxVideoBytes, 200 * 1024 * 1024),
      maxImageBytes: toInt(config.maxImageBytes, 20 * 1024 * 1024),
      quietStrangerReply: config.quietStrangerReply === true,
      memoryEnabled: config.memoryEnabled !== false,
      memoryDir: path.resolve(config.memoryDir || path.join(dataDir, 'memory')),
      memoryContextDays: toInt(config.memoryContextDays, 7),
      memoryRetentionDays: toInt(config.memoryRetentionDays, 90),
      mergeWindowMs: toInt(config.mergeWindowMs, 2600),
      mergeQuickMs: toInt(config.mergeQuickMs, 1000),
      maxMergeMs: toInt(config.maxMergeMs, 9000),
      sendGuard: config.sendGuard && typeof config.sendGuard === 'object' ? config.sendGuard : {},
      chatLogEnabled: config.chatLogEnabled !== false,
      chatLogDir: path.resolve(config.chatLogDir || path.join(dataDir, 'chats')),
      slowReply: config.slowReply && typeof config.slowReply === 'object' ? config.slowReply : {},
      proactive: config.proactive && typeof config.proactive === 'object' ? config.proactive : {},
      biliDaily: config.biliDaily && typeof config.biliDaily === 'object' ? config.biliDaily : {},
      meme: config.meme && typeof config.meme === 'object' ? config.meme : {},
      stickers: config.stickers && typeof config.stickers === 'object' ? config.stickers : {},
      voice: config.voice && typeof config.voice === 'object' ? config.voice : {},
      persona: config.persona && typeof config.persona === 'object' ? config.persona : {},
      attachment: config.attachment && typeof config.attachment === 'object' ? config.attachment : {},
      diary: config.diary && typeof config.diary === 'object' ? config.diary : {},
      weather: config.weather && typeof config.weather === 'object' ? config.weather : {},
      gallery: config.gallery && typeof config.gallery === 'object' ? config.gallery : {},
      chatSplit: config.chatSplit && typeof config.chatSplit === 'object' ? config.chatSplit : {},
      humanize: config.humanize && typeof config.humanize === 'object' ? config.humanize : {},
      imageGen: config.imageGen && typeof config.imageGen === 'object' ? config.imageGen : {},
      ebb: config.ebb && typeof config.ebb === 'object' ? config.ebb : {},
      chatSessions: config.chatSessions && typeof config.chatSessions === 'object' ? config.chatSessions : {},
      catchup: config.catchup && typeof config.catchup === 'object' ? config.catchup : {},
    };

    this.stateFile = path.join(this.cfg.dataDir, 'state.json');
    this.state = { owners: [], approvalPeer: '', grants: {}, pairs: [], bili: null, meme: null };
    this.owners = new Set(this.cfg.ownerUins);
    this.approvalPeer = '';
    this.pairCodes = new Map();
    this.bindings = new Map();
    this.queues = new Map();
    this.lastInbound = new Map();
    this.lastGlobal = null;
    this.seen = new Map();
    this.sentRecent = [];
    this.sentRecentDay = '';
    this.strangerNotified = new Map();
    // 群聊掺和：每条计数，攒够 N 条才有一次回话机会；buffer 存最近几条当上下文
    this.groupCounters = new Map();
    this.groupBuffer = new Map();
    this.groupChatCfg = this.cfg.groupChat || {};
    // 陌生人会话（名额有限，每个都要主人单独放行）
    this.strangerFile = path.join(this.cfg.dataDir, 'strangers.json');
    this.strangers = { allowed: [], pending: [] };
    this.strangerLimit = Math.max(0, Number(this.cfg.strangers?.limit ?? 3));
    this.strangersEnabled = this.cfg.strangers?.enabled !== false;
    // 每个陌生人（可选：每个群）单开一个会话：他那个会话是他的，不该被别人的聊天搅进去。
    this.chatSessionCfg = {
      enabled: this.cfg.chatSessions.enabled !== false,
      workspace: String(this.cfg.chatSessions.workspace || 'D:/dsh-qqchat'),
      forGroups: this.cfg.chatSessions.forGroups === true,
    };
    // key = 'private-<uin>' / 'group-<群号>' -> { sessionId, at, nickname }
    this.chatSessions = new Map();
    this._chatSessionBusy = new Map();
    this._chatSessionFailed = new Map();
    this.logs = [];
    this.selfId = null;
    this.nickname = '';
    this.connection = 'disconnected';
    this.connectionError = '';
    this.started = false;
    this.startedAt = nowIso();
    this._eventChain = Promise.resolve();
    this._contactsCache = { friends: null, groups: null, at: 0 };
    this._savedMedia = new Map();
    this.holds = new Map();
    // 慢速回复：**默认关闭**。它本来是为了省高峰期成本，但延迟本身不看 token，
    // 真正省的是「攒够再回」（合并）和「少主动」。合并交给 costRhythm，这里只留旧开关。
    this.slowReply = {
      enabled: this.cfg.slowReply.enabled === true,
      start: String(this.cfg.slowReply.start || '12:00'),
      end: String(this.cfg.slowReply.end || '18:00'),
      probability: Math.min(1, Math.max(0, Number(this.cfg.slowReply.probability ?? 0.5))),
      minMinutes: Math.max(1, Number(this.cfg.slowReply.minMinutes ?? 10)),
      maxMinutes: Math.max(1, Number(this.cfg.slowReply.maxMinutes ?? 90)),
    };
    // 成本节律：API 高峰时段少主动、把窗口拉长攒着一起回（省调用次数，不改语气）
    this.costCfg = {
      enabled: this.cfg.costRhythm?.enabled !== false,
      peakStart: String(this.cfg.costRhythm?.peakStart || '14:00'),
      peakEnd: String(this.cfg.costRhythm?.peakEnd || '18:00'),
      peakProactiveMul: Math.min(1, Math.max(0.05, Number(this.cfg.costRhythm?.peakProactiveMul ?? 0.3))),
      peakMergeMs: Math.max(1000, Number(this.cfg.costRhythm?.peakMergeMs ?? 45000)),
    };
    this.ebbCfg = {
      enabled: this.cfg.ebb?.enabled !== false,
      organizeAt: String(this.cfg.ebb?.organizeAt || '09:30'),
      boundsFile: String(this.cfg.ebb?.boundsFile || ''),
      recallLimit: Math.max(0, Number(this.cfg.ebb?.recallLimit ?? 5)),
      recallChars: Math.max(120, Number(this.cfg.ebb?.recallChars ?? 420)),
    };
    this.proactiveCfg = {
      enabled: this.cfg.proactive.enabled !== false,
      target: String(this.cfg.proactive.target || ''),
      allowlist: normalizeIdList(this.cfg.proactive.allowlist),
      dailyMin: Math.max(1, Number(this.cfg.proactive.dailyMin ?? 8)),
      dailyMax: Math.max(1, Number(this.cfg.proactive.dailyMax ?? 17)),
      gapMinMinutes: Math.max(1, Number(this.cfg.proactive.gapMinMinutes ?? 25)),
      gapMaxMinutes: Math.max(1, Number(this.cfg.proactive.gapMaxMinutes ?? 90)),
      burstMin: Math.max(1, Number(this.cfg.proactive.burstMin ?? 1)),
      burstMax: Math.max(1, Number(this.cfg.proactive.burstMax ?? 3)),
      burstGapMinSeconds: Math.max(1, Number(this.cfg.proactive.burstGapMinSeconds ?? 3)),
      burstGapMaxSeconds: Math.max(1, Number(this.cfg.proactive.burstGapMaxSeconds ?? 12)),
      checkIntervalMinutes: Math.max(1, Number(this.cfg.proactive.checkIntervalMinutes ?? 3)),
      quietAfterMinutes: Math.max(0, Number(this.cfg.proactive.quietAfterMinutes ?? 3)),
      quietStart: String(this.cfg.proactive.quietStart || '00:30'),
      quietEnd: String(this.cfg.proactive.quietEnd || '08:00'),
      imageDir: String(this.cfg.proactive.imageDir || ''),
      imageProbability: Math.min(1, Math.max(0, Number(this.cfg.proactive.imageProbability ?? 0.2))),
    };
    this.proactive = { lastAt: 0, day: '', count: 0, dailyTarget: 0, nextGapMs: 0, unanswered: 0 };
    this._proactiveImages = { files: [], at: 0 };
    // 设计决定， 026-10-28）：刷视频是解闷的选项，不是任务——所以不再定时刷。
    // 也不再自动往上下文里塞日报。她闷了自己调 qq_bili_watch，图从工具结果直接给她。
    this.biliCfg = {
      enabled: this.cfg.biliDaily.enabled !== false,
      // 2026-10-29：时长配额整套删掉了，只按条数算（他说 5 条/天）。超过 maxVideoSeconds 的还是不看。
      maxVideoSeconds: Math.max(60, Number(this.cfg.biliDaily.maxVideoSeconds ?? 1200)),
      maxFrames: Math.max(6, Number(this.cfg.biliDaily.maxFrames ?? 36)),
      maxVideos: Math.max(1, Number(this.cfg.biliDaily.maxVideos ?? 5)),
      sources: Array.isArray(this.cfg.biliDaily.sources) && this.cfg.biliDaily.sources.length > 0
        ? this.cfg.biliDaily.sources
        : ['history-main', 'history-bot', 'hot'],
    };
    this.bili = new BiliClient({
      dir: path.join(dataDir, 'bili'),
      cookiesFile: path.join(dataDir, 'bilibili-cookies.json'),
      ffmpeg: this.cfg.ffmpeg || 'ffmpeg',
      logger: this.logger,
    });
    this._biliBusy = false;
    this.memeCfg = {
      enabled: this.cfg.meme.enabled !== false,
      ups: normalizeMemeUps(this.cfg.meme.ups),
      // 不再定时学：什么时候学、学哪条，她自己调 qq_meme_watch 决定
      maxVideoSeconds: Math.max(60, Number(this.cfg.meme.maxVideoSeconds ?? this.cfg.meme.watchSeconds ?? 1200)),
      maxFrames: Math.max(6, Number(this.cfg.meme.maxFrames ?? 30)),
    };
    this.memes = new MemeBook({
      file: path.resolve(this.cfg.meme.file || path.join(dataDir, 'memes.json')),
      logger: this.logger,
    });
    // 看过的视频：独立小库， dataDir>/watch），跟记忆 梗笔记都不混。
    // 存的是「这条视频讲了什么」的要点；原始音频和字幕总结完就删。
    this.watchNotes = new WatchNotes({
      dir: path.resolve(this.cfg.watchDir || path.join(dataDir, 'watch')),
      logger: this.logger,
    });
    this.asr = new Asr({
      dir: path.join(dataDir, 'whisper'),
      ffmpeg: this.cfg.ffmpeg || 'ffmpeg',
      logger: this.logger,
      threads: this.cfg.asrThreads,
    });
    this._getLlm = () => (typeof llm === 'function' ? llm() : llm);
    this._getModel = () => {
      const model = typeof defaultModel === 'function' ? defaultModel() : defaultModel;
      return model?.currentSelection?.() || null;
    };
    // 认知层：跟记忆同目录，但分开的文件——记忆记「发生过什么」，这里记「我据此认定了什么。
    this.judgments = new JudgmentsStore({
      dir: path.resolve(this.cfg.memoryDir || path.join(dataDir, 'memory')),
      logger: this.logger,
    });
    // 生理层第一块：能量槽（累不紝→ 主动频率与粘连强度，不改五维，
    this.energy = new EnergyStore({
      file: path.resolve(path.join(dataDir, 'energy.json')),
      logger: this.logger,
    });
    // 生理层第二块：睡眠（睡着压纸条、敲够了叫醒、欠睡发糊）
    this.sleep = new SleepStore({
      file: path.resolve(path.join(dataDir, 'sleep.json')),
      logger: this.logger,
    });
    // 生理层第三块（第一层）：昼夜节律，这一版只出「时间事实。
    this.rhythm = new RhythmClock();
    // 看门狗自保：插件活着就保证看门狗活着（脚本里有单实例锁）
    this.watchdogCfg = {
      enabled: this.cfg.watchdog?.enabled !== false,
      script: String(this.cfg.watchdog?.script || ''),
      everyMinutes: Math.max(5, Number(this.cfg.watchdog?.everyMinutes ?? 30)),
    };
    this._memeBusy = false;
    this.stickerCfg = {
      enabled: this.cfg.stickers.enabled !== false,
      dir: path.resolve(this.cfg.stickers.dir || path.join(dataDir, 'stickers')),
      dailyLimit: Math.max(1, Number(this.cfg.stickers.dailyLimit ?? 3)),
      totalLimit: Math.max(1, Number(this.cfg.stickers.totalLimit ?? 200)),
      autoCollect: this.cfg.stickers.autoCollect !== false,
    };
    this.stickers = new StickerStore({
      dir: this.stickerCfg.dir,
      logger: this.logger,
      getSize: (file) => this.media.probeImageSize(file),
      dailyLimit: this.stickerCfg.dailyLimit,
      totalLimit: this.stickerCfg.totalLimit,
    });
    this.pokeState = { day: '', count: 0, last: new Map() };
    this.voiceCfg = {
      enabled: this.cfg.voice.enabled !== false,
      // 2026-10-29：这里原来漏了 'breeze'，配置写 breeze 也被压成 edge，
      // 再撞上 edge 失败就一路退到 sapi——他听到的那条机器音就是这么来的。
      engine: ['sapi', 'breeze'].includes(this.cfg.voice.engine) ? this.cfg.voice.engine : 'edge',
      voiceName: String(this.cfg.voice.voiceName || 'Microsoft Huihui Desktop'),
      edgeVoice: String(this.cfg.voice.edgeVoice || 'zh-CN-XiaoyiNeural'),
      edgeRate: String(this.cfg.voice.edgeRate || '+5%'),
      edgePitch: String(this.cfg.voice.edgePitch || '+12Hz'),
      rate: Math.max(-10, Math.min(10, Number(this.cfg.voice.rate ?? 1))),
      pitch: Math.max(0.8, Math.min(1.3, Number(this.cfg.voice.pitch ?? 1.08))),
      maxChars: Math.max(10, Math.min(300, Number(this.cfg.voice.maxChars ?? 120))),
      minIntervalMs: Math.max(0, Number(this.cfg.voice.minIntervalMs ?? 6000)),
      pythonPath: String(this.cfg.voice.pythonPath || ''),
      // Breeze 语音：key 放在 .qq-bridge/breeze-key.txt（一行，别加引号）
      breezeKey: String(this.cfg.voice.breezeKey || this._readTextKey('breeze-key.txt', 'BREEZE_API_KEY') || '').trim(),
      breezeVoice: String(this.cfg.voice.breezeVoice || 'voc_8yud7hz7c9q2').trim(),
      breezeVoiceBright: String(this.cfg.voice.breezeVoiceBright || 'voc_u3nxkd5578wc').trim(),
      breezeSpeed: Math.max(0.5, Math.min(2, Number(this.cfg.voice.breezeSpeed ?? 1.1))),
      breezeGuidance: Math.max(1, Math.min(10, Number(this.cfg.voice.breezeGuidance ?? 3))),
    };
    this.voice = new VoiceEngine({
      dir: path.resolve(this.cfg.voice.dir || path.join(dataDir, 'voice')),
      ffmpeg: this.cfg.ffmpeg || 'ffmpeg',
      logger: this.logger,
      engine: this.voiceCfg.engine,
      voiceName: this.voiceCfg.voiceName,
      edgeVoice: this.voiceCfg.edgeVoice,
      edgeRate: this.voiceCfg.edgeRate,
      edgePitch: this.voiceCfg.edgePitch,
      pythonPath: this.voiceCfg.pythonPath,
      rate: this.voiceCfg.rate,
      pitch: this.voiceCfg.pitch,
      maxChars: this.voiceCfg.maxChars,
      breezeKey: this.voiceCfg.breezeKey,
      breezeVoice: this.voiceCfg.breezeVoice,
      breezeVoiceBright: this.voiceCfg.breezeVoiceBright,
      breezeSpeed: this.voiceCfg.breezeSpeed,
      breezeGuidance: this.voiceCfg.breezeGuidance,
    });
    this._voiceLastAt = 0;
    this.personaCfg = {
      enabled: this.cfg.persona.enabled !== false,
      file: path.resolve(this.cfg.persona.file || path.join(home, 'qq-persona.txt')),
    };
    this.persona = new PersonaBook({ file: this.personaCfg.file, logger: this.logger });
    this.attachmentCfg = {
      enabled: this.cfg.attachment.enabled !== false,
      idleMinutes: Math.max(5, Number(this.cfg.attachment.idleMinutes ?? 25)),
      ignoredCount: Math.max(1, Number(this.cfg.attachment.ignoredCount ?? 2)),
      maxNagsPerDay: Math.max(1, Number(this.cfg.attachment.maxNagsPerDay ?? 3)),
      cooldownMinutes: Math.max(5, Number(this.cfg.attachment.cooldownMinutes ?? 45)),
      maxBurst: Math.max(1, Math.min(15, Number(this.cfg.attachment.maxBurst ?? 15))),
      topicCooldownMinutes: Math.max(10, Number(this.cfg.attachment.topicCooldownMinutes ?? 90)),
      topicDailyCap: Math.max(1, Number(this.cfg.attachment.topicDailyCap ?? 3)),
      checkIntervalMinutes: Math.max(1, Number(this.cfg.attachment.checkIntervalMinutes ?? 5)),
    };
    // 重启/断线之后要不要跟他说「我掉线了、那条卡住了」。默认*不说**（他 2026-10-29 要求的），
    // 补漏推送和重连补偿两条路都关掉，直接接着聊。
    this.noticeReconnect = this.cfg.catchup.noticeReconnect === true;
    this.attachment = new AttachmentState({
      file: path.resolve(this.cfg.attachment.stateFile || path.join(dataDir, 'attachment.json')),
      logger: this.logger,
      idleMinutes: this.attachmentCfg.idleMinutes,
      ignoredCount: this.attachmentCfg.ignoredCount,
      maxNagsPerDay: this.attachmentCfg.maxNagsPerDay,
      cooldownMinutes: this.attachmentCfg.cooldownMinutes,
      maxBurst: this.attachmentCfg.maxBurst,
      topicCooldownMinutes: this.attachmentCfg.topicCooldownMinutes,
      topicDailyCap: this.attachmentCfg.topicDailyCap,
    });
    this._attachmentTimer = null;
    this._praiseAt = 0;
    this._leaveAt = 0;
    this._disconnectedAt = 0;
    this._catchUpPending = false;
    this.diaryCfg = {
      enabled: this.cfg.diary.enabled !== false,
      dir: path.resolve(this.cfg.diary.dir || path.join(dataDir, 'diary')),
    };
    this.diary = new DiaryStore({ dir: this.diaryCfg.dir, logger: this.logger });
    this.weatherCfg = {
      enabled: this.cfg.weather.enabled !== false,
      defaultCity: String(this.cfg.weather.defaultCity || '哈尔满'),
      cacheMinutes: Math.max(1, Number(this.cfg.weather.cacheMinutes ?? 10)),
      fetchImpl: typeof this.cfg.weather.fetchImpl === 'function' ? this.cfg.weather.fetchImpl : fetch,
    };
    this.weather = new WeatherService({
      defaultCity: this.weatherCfg.defaultCity,
      cacheMinutes: this.weatherCfg.cacheMinutes,
      fetchImpl: this.weatherCfg.fetchImpl,
      logger: this.logger,
    });
    this.galleryCfg = {
      enabled: this.cfg.gallery.enabled !== false,
      autoIngest: this.cfg.gallery.autoIngest !== false,
      dir: path.resolve(this.cfg.gallery.dir || path.join(dataDir, 'gallery')),
      maxBytes: Math.max(64 * 1024, Number(this.cfg.gallery.maxBytes ?? 4 * 1024 * 1024)),
    };
    this._galleryReady = false;
    this.gallery = new GalleryStore({
      dir: this.galleryCfg.dir,
      logger: this.logger,
      maxBytes: this.galleryCfg.maxBytes,
      getSize: (file) => this.media.probeImageSize(file),
    });
    this.chatSplitCfg = {
      enabled: this.cfg.chatSplit.enabled !== false,
      maxParts: Math.max(1, Math.min(5, Number(this.cfg.chatSplit.maxParts ?? 3))),
      minChars: Math.max(10, Number(this.cfg.chatSplit.minChars ?? 40)),
      maxCharsPerPart: Math.max(30, Number(this.cfg.chatSplit.maxCharsPerPart ?? 90)),
      minGapMs: Math.max(0, Number(this.cfg.chatSplit.minGapMs ?? 700)),
      maxGapMs: Math.max(0, Number(this.cfg.chatSplit.maxGapMs ?? 3000)),
      group: this.cfg.chatSplit.group === true,
    };
    this.humanizeCfg = {
      enabled: this.cfg.humanize.enabled !== false,
      delayMinMs: Math.max(0, Number(this.cfg.humanize.delayMinMs ?? 600)),
      delayMaxMs: Math.max(0, Number(this.cfg.humanize.delayMaxMs ?? 3500)),
      group: this.cfg.humanize.group === true,
    };
    this.imageGenCfg = {
      enabled: this.cfg.imageGen.enabled !== false,
      width: Math.max(256, Math.min(1536, Number(this.cfg.imageGen.width ?? 768))),
      height: Math.max(256, Math.min(1536, Number(this.cfg.imageGen.height ?? 1024))),
      dir: this.cfg.imageGen.dir || path.join(this.cfg.dataDir, 'generated'),
      endpoint: this.cfg.imageGen.endpoint || undefined,
      model: this.cfg.imageGen.model || '',
      token: this.cfg.imageGen.token || '',
      provider: String(this.cfg.imageGen.provider || 'pollinations'),
      baseUrl: this.cfg.imageGen.baseUrl || '',
      apiKey: this._readImageKey(),
      timeoutMs: Math.max(10000, Number(this.cfg.imageGen.timeoutMs ?? 180000)),
    };
    this.imageGen = new ImageGen({
      logger: (line) => this.log(line),
      timeoutMs: this.imageGenCfg.timeoutMs,
    });
    this.proactiveTimer = null;
    this._proactiveKick = null;

    this.media = new MediaStore({ dir: this.cfg.mediaDir, ffmpeg: this.cfg.ffmpeg, logger: this.logger });
    this.memory = this.cfg.memoryEnabled
      ? new MemoryStore({
        dir: this.cfg.memoryDir,
        logger: this.logger,
        getLlm: () => (typeof llm === 'function' ? llm() : llm),
        getModel: () => (typeof defaultModel === 'function' ? defaultModel() : defaultModel)?.currentSelection?.(),
        contextDays: this.cfg.memoryContextDays,
        retentionDays: this.cfg.memoryRetentionDays,
      })
      : null;
    this.client = new OneBotClient({
      url: this.cfg.wsUrl,
      token: this.cfg.token,
      logger: this.logger,
      onEvent: (event) => this._enqueueEvent(event),
      onStatus: (status) => this._onConnectionStatus(status),
    });
    this.guard = new SendGuard({
      logger: this.logger,
      notifyOwner: (text) => this._alertOwner(text),
      config: this.cfg.sendGuard,
    });
    this._chatLogChain = Promise.resolve();
  }

  // ------------------------------------------------------------------ lifecycle

  async start() {
    if (this.started) return;
    this.started = true;
    await ensureDir(this.cfg.dataDir);
    await this._loadRuntimeOverrides();
    await this._loadBlockedSessions();
    await this.media.init();
    const foundFfmpeg = await this.media.findFfmpeg();
    if (foundFfmpeg) {
      this.bili.ffmpeg = foundFfmpeg;
      this.voice.ffmpeg = foundFfmpeg;
      this.asr.ffmpeg = foundFfmpeg;
      // whisper 的二进制通常跟 ffmpeg 一起放在 tools/ 下；配置里写死就用配置的
      this.asr.dir = path.resolve(this.cfg.asrDir || path.join(path.dirname(foundFfmpeg), 'whisper'));
    }
    await this._loadState();
    await this.memes.load().catch(() => {});
    const notes = await this.watchNotes.load().catch(() => 0);
    this.log(`看过的视频笔记: ${notes} 条；口播转写 ${this.asr.available() ? '可用' : '未安装（只给画面，'}`);
    await this.stickers.load().catch(() => {});
    await this.judgments.load().catch(() => {});
    await this.energy.load().catch(() => {});
    await this.sleep.load().catch(() => {});
    if (this.sleep.asleep) {
      // 重启前是「躺下没睡着」：翻够时间就当已经睡着了，别把整段离线都算成失眠
      if (this.sleep.tossing) {
        const snap0 = this.sleep.snapshot();
        if (snap0.tossLeftHours <= 0) {
          const layDownAt = Number(this.sleep.data.asleepSince) || Date.now();
          const tossHours = Number(this.sleep.data.tossHours) || 0;
          await this.sleep.fallAsleep({ now: layDownAt + tossHours * 3600000 });
          await this.sleep.save();
        }
      }
      const snap = this.sleep.snapshot();
      // 重启前就在睡：睡够 8 小时以上当成「离线/断电过」，直接醒，别让她一直睡着
      if (snap.asleepHours >= 8) {
        this.log(`睡眠状态恢复：睡着 ${snap.asleepHours} 小时，太久，按自然醒处理`);
        await this.sleep.wake({ now: Date.now(), awakeHoursBefore: this._awakeHours() }).then(() => this.sleep.save());
      } else {
        this.log(`睡眠状态恢复：睡着中（${snap.asleepHours} 小时）`);
      }
    }
    this._startSleepTick();
    await this._seedRhythm().catch((error) => this.log(`节律起点补不了: ${errorMessage(error)}`));
    await this._refreshEmotionToday();
    this._startWatchdogGuard();
    if (this.personaCfg.enabled) {
      await this.persona.load().catch(() => {});
      this.log(`人格文件: ${this.persona.source === 'file' ? this.personaCfg.file : '未找到，使用内置人设'}`);
    }
    if (this.attachmentCfg.enabled) {
      await this.attachment.load().catch(() => {});
      if (!existsSync(this.attachment.file)) await this.attachment.save().catch(() => {});
    }
    if (this.galleryCfg.enabled) {
      await this.gallery.load().catch(() => {});
      this._galleryReady = true;
      this.log(`图库: ${this.gallery.entries.length} 张`);
    }
    if (this.memory) {
      await this.memory.init();
      this.memory.startScheduler();
    }
    this.broker = new PermissionBroker({
      grants: this.state.grants,
      approvalTimeoutSec: this.cfg.approvalTimeoutSec,
      logger: this.logger,
      sendApproval: (text) => this.sendApprovalPrompt(text),
      onChange: (grants) => {
        this.state.grants = grants;
        void this._saveState();
      },
    });
    this.log(`QQ 桥接启动，OneBot: ${this.cfg.wsUrl}`);
    this._restoreBindings();
    if (this.bindings.size > 0) {
      // Merge the restored bindings into the state file and refresh the snapshot,
      // so the next reload has something to fall back on.
      void this._saveState();
    }
    // 已有的独立会话补挂一次工作区（不再预建空会话：侧栏不列、也挂不进去，
    setTimeout(() => {
      void this._backfillChatSessions().catch((error) => this.log(`补挂独立会话失败: ${errorMessage(error)}`));
    }, 8000);
    this._startProactive();
    this._startAttachment();
    // 口播要点要靠一次小模型调用：这里先把「能不能调到」写进日志，
    // 免得又出现「摘要悄悄空着」的情况， 026-10-28 就吃过这个亏）。
    try {
      const llm = this._getLlm?.();
      const model = this._getModel?.() || {};
      this.log(`学梗/口播摘要模型: llm=${llm ? 'ok' : '缺失'} provider=${model.provider || '缺失'} model=${model.model || '缺失'}`);
    } catch (error) {
      this.log(`检查摘要模型失败: ${errorMessage(error)}`);
    }
    // 会话晚一步打开也要接回来：每分钟扫一次 pending 绑定
    if (this._bindingTimer) clearInterval(this._bindingTimer);
    this._bindingTimer = setInterval(() => {
      try {
        void this._sweepPendingBindings();
      } catch (error) {
        this.log(`扫描绑定失败: ${errorMessage(error)}`);
      }
    }, 60000);
    // 启动后也补一次漏（等会话真正醒过来再推）
    setTimeout(() => {
      void this._pushMissedInbound().catch((error) => this.log(`启动补漏失败: ${errorMessage(error)}`));
    }, 25000);
    this._shieldStage = new Map();
    try {
      await this._loadMoodState();
    } catch (error) {
      this.log(`心情恢复失败（不影响连接，）: ${errorMessage(error)}`);
    }
    // 加权记忆是可选层：它出问题绝不能拖累 QQ 连接， 026-10-26 就因此掉过一次线）。
    try {
      this._startEbb();
    } catch (error) {
      this.log(`加权记忆启动失败（不影响连接，）: ${errorMessage(error)}`);
    }
    await this.client.start();
  }

  async stop() {
    this.started = false;
    if (this._ebbTimer) {
      clearInterval(this._ebbTimer);
      this._ebbTimer = null;
    }
    if (this._bindingTimer) {
      clearInterval(this._bindingTimer);
      this._bindingTimer = null;
    }
    // 按需拉起来的会话是插件自己持有的，停的时候要还回去
    if (this._resumedAgents) {
      for (const handle of this._resumedAgents.values()) {
        try {
          void handle?.dispose?.();
        } catch { /* 已经没了 */ }
      }
      this._resumedAgents.clear();
    }
    if (this.proactiveTimer) {
      clearInterval(this.proactiveTimer);
      this.proactiveTimer = null;
    }
    if (this._proactiveKick) {
      clearTimeout(this._proactiveKick);
      this._proactiveKick = null;
    }
    if (this._attachmentTimer) {
      clearInterval(this._attachmentTimer);
      this._attachmentTimer = null;
    }
    if (this._attachmentKick) {
      clearTimeout(this._attachmentKick);
      this._attachmentKick = null;
    }
    for (const hold of this.holds.values()) {
      if (hold.timer) clearTimeout(hold.timer);
    }
    this.holds.clear();
    // Persist the bindings before dropping them: a hot reload often stops the
    // plugin inside the same tick that a state write is queued, and losing the
    // binding would silently stop forwarding QQ messages.
    if (this.bindings.size > 0) {
      try {
        await this._saveState();
      } catch (error) {
        this.log(`停止前保存绑定失败: ${errorMessage(error)}`);
      }
    }
    for (const binding of this.bindings.values()) binding.memoryDisposer?.();
    this.bindings.clear();
    for (const queue of this.queues.values()) {
      if (queue.timer) clearTimeout(queue.timer);
    }
    this.queues.clear();
    this.memory?.stop();
    await this.client.stop();
  }

  _onConnectionStatus(status) {
    this.connection = status.state;
    if (status.error) this.connectionError = status.error;
    if (status.state === 'connected') {
      this.connectionError = '';
      this.log('OneBot 已连接');
      void this._afterConnect();
    } else if (status.state === 'disconnected') {
      this.log('OneBot 连接断开');
      this._disconnectedAt = this._disconnectedAt || Date.now();
    }
  }

  /**
   * After (re)connecting: tell the attachment machine "this gap was the network",* not him ignoring me", and queue one catch-up line for anything that couldn't'"* be delivered while offline.
   */
  async _handleReconnect() {
    if (!this.attachmentCfg.enabled) return;
    const now = Date.now();
    const downtime = this._disconnectedAt ? now - this._disconnectedAt : 0;
    this._disconnectedAt = 0;
    try {
      const result = await this.attachment.noteReconnect(now, downtime);
      if (downtime > 60000 || result.undelivered > 0) {
        this.log(`重连补偿: 断线 ${Math.round(downtime / 1000)}s，未送达 ${result.undelivered} 条`);
        if (this.noticeReconnect) {
          this._catchUpPending = true;
        } else {
          // 他 2026-10-29 明确要求：重启 掉线之后别让 bot 说「我掉线了、那条卡住了」。
          // 所以默认只记账、不发补的那几句；欠着的条数一并清掉，免得哪天开了开关把陈年旧账翻出来。
          try { this.attachment.takeCatchUp(); } catch { /* 可选层 */ }
        }
      }
    } catch (error) {
      this.log(`重连状态更新失败: ${errorMessage(error)}`);
    }
  }

  async _afterConnect() {
    try {
      const info = await this.client.call('get_login_info', {});
      this.selfId = String(info?.user_id ?? info?.uin ?? this.cfg.account ?? '');
      this.nickname = String(info?.nickname ?? info?.name ?? '');
      this.log(`QQ 登录账号: ${this.nickname || '?'} (${this.selfId || '?'})`);
      void this._loadContacts(true);
    } catch (error) {
      this.log(`获取登录信息失败: ${errorMessage(error)}`);
    }
    await this._handleReconnect();
    // 连上之后补一次漏：断线期间他说的那些，进得了聊天记录，但进不了会话
    void this._pushMissedInbound().catch((error) => this.log(`补漏失败: ${errorMessage(error)}`));
  }

  /**
   * 补漏：把「他说了、我这边没收到」的最近几条，作为一条提示推给已绑定的会话。* 只提示、不自动回复——替当时不在场的自己补一句，比漏掉更假。
   */
  async _pushMissedInbound({ force = false } = {}) {
    if (this.cfg.catchup?.enabled === false) return 0;
    // 默认不补：补漏那条推过去，她一定会说「我掉线了、刚才那句卡住了」——这正是他不想要的。
    if (!this.noticeReconnect) return 0;
    const now = Date.now();
    if (!force && now - Number(this._missedAt || 0) < 60 * 60000) return 0;
    const target = this._proactiveTarget();
    if (!target || this.bindings.size === 0) return 0;
    const day = this._localDay();
    const file = path.join(this.cfg.chatLogDir, safeFileName(`private-${target}`), `${day}.jsonl`);
    if (!existsSync(file)) return 0;
    const rows = [];
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { rows.push(JSON.parse(trimmed)); } catch { /* 跳过坏行 */ }
    }
    const missed = selectMissed(rows, { limit: 5, now });
    if (!missed.length) return 0;
    const text = renderMissed(missed);
    if (!text) return 0;
    let pushed = 0;
    for (const sessionId of this.bindings.keys()) {
      const agent = await this._ensureAgent(sessionId);
      if (!agent) continue;
      try {
        agent.followup({
          id: randomId('qq_'),
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text }],
        });
        pushed += 1;
      } catch (error) {
        this.log(`补漏推送失败 (${sessionId}): ${errorMessage(error)}`);
      }
    }
    if (pushed > 0) {
      this._missedAt = now;
      this.log(`补漏， {missed.length} 条漏消息已推给 ${pushed} 个会话`);
    }
    return pushed;
  }

  _enqueueEvent(event) {
    this._eventChain = this._eventChain
      .then(() => this._handleEvent(event))
      .catch((error) => this.log(`事件处理失败: ${errorMessage(error)}`));
  }

  // ------------------------------------------------------------------ state

  /** Runtime overrides written by the control panel (survive restarts, win over YAML). */
  get runtimeFile() {
    return path.join(this.cfg.dataDir, 'runtime.json');
  }

  /**
   * 拼图做出来之后，散帧就完成任务了：我只看拼图，别占着盘。* ， 026-10-28 起不再落整条 mp4，所以 videoPath 通常传空串。）
   */
  async _cleanupVideoArtifacts(videoPath, framePaths = []) {
    if (this.biliCfg?.keepVideoFiles) return;
    for (const file of [videoPath, ...framePaths]) {
      if (!file) continue;
      try {
        await unlink(file);
      } catch {
        /* already gone */
      }
    }
  }

  async _loadRuntimeOverrides() {
    const saved = await readJson(this.runtimeFile, null);
    if (!saved || typeof saved !== 'object') return;
    this._mergeRuntime(saved);
    // 面板改的是 cfg，但真正生效的是下面这些派生对象——以前只合并 cfg，
    // 所以开关看着保存了、其实要重启才生效。合并完必须重建一次。
    this._syncDerivedConfig();
    this.log(`已应用面板设置: ${Object.keys(saved).join(', ')}`);
  }

  /** 把 this.cfg 重新摊平成运行期用的派生对象、
*/
  _syncDerivedConfig() {
    const cfg = this.cfg || {};
    if (cfg.slowReply && this.slowReply) {
      this.slowReply.enabled = cfg.slowReply.enabled === true;
      if (cfg.slowReply.probability !== undefined) {
        this.slowReply.probability = Math.min(1, Math.max(0, Number(cfg.slowReply.probability)));
      }
    }
    if (cfg.costRhythm) {
      this.costCfg = {
        enabled: cfg.costRhythm.enabled !== false,
        peakStart: String(cfg.costRhythm.peakStart || '14:00'),
        peakEnd: String(cfg.costRhythm.peakEnd || '18:00'),
        peakProactiveMul: Math.min(1, Math.max(0.05, Number(cfg.costRhythm.peakProactiveMul ?? 0.3))),
        peakMergeMs: Math.max(1000, Number(cfg.costRhythm.peakMergeMs ?? 45000)),
      };
    }
    if (cfg.chatSplit && this.chatSplitCfg) {
      this.chatSplitCfg.enabled = cfg.chatSplit.enabled !== false;
      if (cfg.chatSplit.maxParts !== undefined) {
        this.chatSplitCfg.maxParts = Math.max(1, Math.min(5, Number(cfg.chatSplit.maxParts)));
      }
    }
    if (cfg.humanize && this.humanizeCfg) {
      this.humanizeCfg.enabled = cfg.humanize.enabled !== false;
      if (cfg.humanize.delayMaxMs !== undefined) {
        this.humanizeCfg.delayMaxMs = Math.max(0, Number(cfg.humanize.delayMaxMs));
      }
    }
  }

  _mergeRuntime(patch, target = this.cfg) {
    for (const [key, value] of Object.entries(patch || {})) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (!target[key] || typeof target[key] !== 'object') target[key] = {};
        this._mergeRuntime(value, target[key]);
      } else {
        target[key] = value;
      }
    }
  }

  async applyRuntimePatch(patch, { persist = true } = {}) {
    if (!patch || typeof patch !== 'object') throw new Error('patch 必须是对象');
    const allowed = ['slowReply', 'humanize', 'chatSplit', 'proactive', 'attachment', 'meme', 'stickers', 'gallery', 'imageGen', 'costRhythm'];
    for (const key of Object.keys(patch)) {
      if (!allowed.includes(key)) throw new Error(`不支持的配置须: ${key}`);
    }
    this._mergeRuntime(patch);
    this._syncDerivedConfig();
    if (persist) {
      const current = (await readJson(this.runtimeFile, {})) || {};
      this._mergeRuntime(patch, current);
      await writeJson(this.runtimeFile, current);
    }
    this.log(`面板改了配置: ${JSON.stringify(patch).slice(0, 200)}`);
    return { ok: true, config: this.panelState() };
  }

  /** Compact snapshot for the control panel. */
  panelState() {
    return {
      updatedAt: new Date().toISOString(),
      connection: { connected: this.connection === 'connected', selfId: this.selfId || '', nickname: this.nickname || '', error: this.connectionError || null },
      slowReply: this.cfg.slowReply || {},
      costRhythm: { ...this.costCfg, ...this._costNow() },
      humanize: this.cfg.humanize || {},
      chatSplit: this.cfg.chatSplit || {},
      proactive: this.cfg.proactive || {},
      attachment: this.cfg.attachment || {},
      meme: this.cfg.meme || {},
      stickers: this.cfg.stickers || {},
      gallery: this.cfg.gallery || {},
      imageGen: this.cfg.imageGen || {},
      mood: this.mood || null,
      judgments: this.judgments?.snapshot?.() ?? null,
      energy: this.energy?.snapshot?.() ?? null,
      sleep: this.sleep?.snapshot?.() ?? null,
      rhythm: (() => {
        const state = this.rhythm?.state?.() ?? null;
        if (!state) return null;
        const phase = dayPhase(new Date());
        const soft = this._softZone(new Date(), { hasEmotionToday: this._emotionToday === true });
        return { ...state, phase: phase.name, phaseMul: phase.proactiveMul, softZone: soft.active, softWhy: soft.reasons };
      })(),
      stats: {
        // 这三个以前写成 `this.memory?.stats?.()?.days` —— stats() 是 async，取到的是 Promise 的 .days，
        // 永远是 null。面板上「记忆天数」一直空着就是这个原因。
        memoryDays: this.memory?.index?.days?.length ?? null,
        galleryCount: this.gallery?.entries?.length ?? null,
        stickerCount: this.stickers?.entries?.length ?? null,
        memeCount: this.memes?.entries?.length ?? null,
      },
    };
  }

  async _loadState() {
    const state = await readJson(this.stateFile, null);
    if (state && typeof state === 'object') {
      this.state = {
        owners: normalizeIdList(state.owners),
        approvalPeer: String(state.approvalPeer || ''),
        grants: state.grants && typeof state.grants === 'object' ? state.grants : {},
        pairs: Array.isArray(state.pairs) ? state.pairs : [],
        bindings: Array.isArray(state.bindings) ? state.bindings : [],
        bili: state.bili && typeof state.bili === 'object' ? state.bili : null,
        meme: state.meme && typeof state.meme === 'object' ? state.meme : null,
        bindingSnapshot: state.bindingSnapshot && typeof state.bindingSnapshot === 'object'
          ? state.bindingSnapshot
          : null,
        chatSessions: state.chatSessions && typeof state.chatSessions === 'object' ? state.chatSessions : {},
      };
    }
    if (this.chatSessions && this.state.chatSessions) {
      for (const [key, value] of Object.entries(this.state.chatSessions)) {
        if (value?.sessionId) this.chatSessions.set(key, value);
      }
    }
    for (const uin of this.state.owners) this.owners.add(uin);
    this.approvalPeer = this.state.approvalPeer || [...this.owners][0] || '';
    for (const pair of this.state.pairs) {
      if (pair?.code && pair?.uin && pair.expiresAt > Date.now()) {
        this.pairCodes.set(pair.code, pair);
      }
    }
    const strangers = await readJson(this.strangerFile, null);
    if (strangers && typeof strangers === 'object') {
      this.strangers = {
        allowed: Array.isArray(strangers.allowed) ? strangers.allowed.filter((item) => item?.uin) : [],
        pending: Array.isArray(strangers.pending) ? strangers.pending.filter((item) => item?.uin) : [],
      };
    }
  }

  /**
   * 封禁名单：某些会话永远不许再给 QQ。* 起因：归档会话被点开一次就会重新挂上，然后就一直跟 QQ 会话抢消息，* 每次清理完它又回来。名单落盘，重启也拦得住。
   */
  get blockedFile() {
    return path.join(this.cfg.dataDir, 'unbind.json');
  }

  async _loadBlockedSessions() {
    this.blockedSessions = new Set();
    try {
      const saved = await readJson(this.blockedFile, null);
      const list = Array.isArray(saved?.blocked) ? saved.blocked : [];
      for (const id of list) if (id) this.blockedSessions.add(String(id));
    } catch { /* 读不到就当没有
*/ }
  }

  async blockSession(sessionId) {
    const id = String(sessionId || '').trim();
    if (!id) throw new Error('缺 sessionId');
    if (!this.blockedSessions) this.blockedSessions = new Set();
    this.blockedSessions.add(id);
    await writeJson(this.blockedFile, { blocked: [...this.blockedSessions], at: Date.now() });
    const removed = this.unbindAgent(id);
    this.log(`已封禁会话绑定: ${id}${removed ? '（并解绑）' : ''}`);
    return { blocked: [...this.blockedSessions], removed };
  }

  /**
   * 看门狗自保（**暂时停用**）。** 2026-10-28 19:05 的教训：在插件里直接 spawn 隐藏的 powershell，* 结果插件激活失败、整不 DSH 卡死、他只能强关重来。* 进程管理交给外部（启动文件夹里的快捷方式），插件不碰进程。* 要重启它，请人手动起，或者做成需要管理员权限的计划任务。
   */
  _startWatchdogGuard() {
    return; // 见上面：插件一律不 spawn 外部进程
  }

  async _saveState() {
    this.state.owners = [...this.owners];
    this.state.approvalPeer = this.approvalPeer;
    this.state.grants = this.broker?.snapshotGrants?.() ?? this.state.grants;
    this.state.pairs = [...this.pairCodes.values()].filter((pair) => pair.expiresAt > Date.now());
    this.state.bindings = [...this.bindings.entries()]
      // 2026-10-29 11:31：state.json 里出现过 `"sessionId": "[object Object]"`，
      // 之后每次启动都「绑定 [object Object] 暂未加载」，等于 QQ 没人接。
      // 谁把对象当 Map key 塞进来的还没查出来（视 _saveState 的 stack 日志），
      // 先保证：不是字符串、或者看着就不像会话 id 的，一律不许落盘。
      .filter(([sessionId]) => {
        if (typeof sessionId === 'string' && sessionId && !sessionId.includes('[object')) return true;
        this.log(`拒绝保存坏绑定（sessionId=${String(sessionId)}，疑似对象）`);
        try { this.log(`坏绑定来源: ${new Error('bad-binding').stack?.split('\n').slice(1, 6).join(' <- ') || '?'}`); } catch { /* 忽略 */ }
        return false;
      })
      .map(([sessionId, binding]) => ({
        sessionId,
        types: [...(binding?.types || ['private'])],
      }));
    // Keep a recent snapshot: if a reload ever persists an empty binding list,
    // the next start can still recover instead of going silent.
    if (this.state.bindings.length > 0) {
      this.state.bindingSnapshot = { at: Date.now(), list: this.state.bindings };
    }
    this.state.bili = this.state.bili || null;
    this.state.chatSessions = this.chatSessions ? Object.fromEntries(this.chatSessions) : {};
    try {
      await writeJson(this.stateFile, this.state);
    } catch (error) {
      this.log(`保存状态失败: ${errorMessage(error)}`);
    }
  }

  _restoreBindings() {
    let saved = Array.isArray(this.state.bindings) ? this.state.bindings : [];
    if (saved.length === 0) {
      const snapshot = this.state.bindingSnapshot;
      const fresh = snapshot && Number(snapshot.at) > Date.now() - 7 * 86400000;
      if (fresh && Array.isArray(snapshot.list) && snapshot.list.length > 0) {
        saved = snapshot.list;
        this.log(`绑定列表为空，从快照恢复 ${saved.length} 个会话`);
      }
    }
    for (const item of saved) {
      const raw = item?.sessionId;
      // 只认字符不 id。以前这里 `String(item?.sessionId)`，一个对象被写成
      // "[object Object]" 就一路绑上去，日志里只留一句「绑定 [object Object] 暂未加载」，
      // 看上去像「会话没打开」，实际是绑定废了、QQ 没人接。
      if (typeof raw !== 'string' || !raw || raw.includes('[object')) {
        this.log(`跳过坏绑定（sessionId 不是字符不）: ${JSON.stringify(raw)}）——用 qq_bindings action=bind 重新绑`);
        continue;
      }
      const sessionId = raw.trim();
      if (!sessionId) continue;
      // 封禁名单优先：归档会话被点开一次就会自己爬回绑定列表，名单就是用来挡它的
      if (this.blockedSessions?.has?.(sessionId)) {
        this.log(`跳过被封禁的绑定: ${sessionId}`);
        continue;
      }
      const types = Array.isArray(item?.types) && item.types.length > 0 ? item.types : ['private', 'group'];
      const agent = this.ctx.agents?.get?.(sessionId);
      if (!agent) {
        // 重启后会话还没加载出来——而这正是最需要恢复绑定的时刻。
        // 先把绑定记住，等它醒来、下一条消息进来时 notifySessions 再按 id 只 agent。
        if (!this.bindings.has(sessionId)) {
          this.bindings.set(sessionId, {
            sessionId,
            // 必须是 Set：_forward / status 都按 Set 用（2026-10-27 存成数组，消息一进来就
            // `binding.types.has is not a function`，整条私聊静默丢失）。
            types: new Set(types),
            since: Number(item?.since) || Date.now(),
            memoryDisposer: null,
            pending: true,
          });
          this.log(`绑定 ${sessionId} 暂未加载，先记住（等会话醒来再接）`);
        }
        continue;
      }
      try {
        this.bindAgent(agent, { types });
        this.log(`恢复监听绑定 ${sessionId}`);
      } catch (error) {
        this.log(`恢复监听绑定失败 ${sessionId}: ${errorMessage(error)}`);
      }
    }
  }

  addOwner(uin, { peer = true } = {}) {
    const id = String(uin);
    this.owners.add(id);
    if (peer) this.approvalPeer = id;
    void this._saveState();
  }

  isOwner(uin) {
    return this.owners.has(String(uin));
  }

  // ------------------------------------------------------------------ logging

  log(message) {
    const line = `${nowIso()} ${message}`;
    this.logs.push(line);
    if (this.logs.length > 200) this.logs.splice(0, this.logs.length - 200);
    this.logger(message);
  }

  // ------------------------------------------------------------------ events

  async _handleEvent(event) {
    if (event.post_type === 'meta_event') {
      if (event.meta_event_type === 'lifecycle') this.log(`OneBot 生命周期: ${event.sub_type || ''}`);
      return;
    }
    if (event.post_type === 'request') {
      this.log(`收到请求事件: ${event.request_type || ''} from ${event.user_id || event.group_id || '?'}`);
      return;
    }
    if (event.post_type === 'notice') {
      // Different OneBot implementations report pokes differently:
      //   notice_type=poke  |  notice_type=notify + sub_type=poke
      const isPoke = event.notice_type === 'poke'
        || (event.notice_type === 'notify' && String(event.sub_type || '').toLowerCase() === 'poke')
        || String(event.raw_info?.type || '') === 'poke';
      if (isPoke) await this._handlePoke(event);
      return;
    }
    if (event.post_type !== 'message' && event.post_type !== 'message_sent') return;
    if (event.post_type === 'message_sent') return;
    const msg = this._normalizeMessage(event);
    if (!msg) return;
    // 收信即记一行：出问题时能一眼分开「事件没进来」和「进来了没送进会话」。
    this.log(`收到${msg.messageType === 'private' ? '私聊' : '群'} ${msg.messageType === 'private' ? msg.userId : msg.groupId}， {msg.segments.length} 段）`);
    if (!this.cfg.forwardSelf && msg.userId && msg.userId === this.selfId) return;
    if (this.seen.has(msg.messageId)) return;
    this.seen.set(msg.messageId, Date.now());
    if (this.seen.size > 800) {
      const cutoff = Date.now() - 600000;
      for (const [id, at] of this.seen) if (at < cutoff) this.seen.delete(id);
    }

    if (msg.messageType === 'private') {
      await this._handlePrivate(msg);
    } else {
      await this._handleGroup(msg);
    }
  }

  _normalizeMessage(event) {
    const messageType = event.message_type === 'group' ? 'group' : 'private';
    const segments = Array.isArray(event.message) ? event.message : [];
    const sender = event.sender || {};
    return {
      messageType,
      messageId: String(event.message_id ?? event.real_id ?? ''),
      userId: String(event.user_id ?? ''),
      groupId: messageType === 'group' ? String(event.group_id ?? '') : '',
      time: Number(event.time || Math.floor(Date.now() / 1000)),
      nickname: String(sender.card || sender.nickname || event.sender?.name || ''),
      segments,
      rawMessage: String(event.raw_message || ''),
      isSelf: String(event.user_id ?? '') === String(this.selfId ?? event.self_id ?? ''),
    };
  }

  async _handlePrivate(msg) {
    const text = segmentsToPlainText(msg.segments) || msg.rawMessage;
    this._rememberInbound('private', msg.userId, msg);
    if (this.isOwner(msg.userId) && String(msg.userId) === this._proactiveTarget()) {
      this.proactive.unanswered = 0;
    }

    if (this.isOwner(msg.userId)) {
      // 只有主人这条会写这 qq-chats 档案。以前这行注释写着「陌生人的消息既不记录也不转发」，
      // 但转发那半句是假的（陌生人一样被 _forward 进了绑定会话）—— 026-10-29 她照着这句
      // 跟陌生人保证「不会转给他看」，其实是错的。现在转发那半句才成立（视 chatSessions）。
      this._logChat({
        chatType: 'private',
        chatId: msg.userId,
        direction: 'in',
        fromId: msg.userId,
        fromName: msg.nickname,
        text,
        media: segmentMediaLabels(msg.segments),
        messageId: msg.messageId,
        ts: msg.time * 1000,
      });
      const approval = this.broker.handleApprovalText(text, msg.userId);
      if (approval.handled) {
        await this._safeSendPrivate(msg.userId, approval.reply);
        if (approval.approved) {
          this.log(`授权通过: ${approval.request.scope} by ${msg.userId}`);
          this.notifySessions(`【QQ授权】用户已通过、 {SCOPES[approval.request.scope]?.label ?? approval.request.scope}」授权（${approval.request.minutes} 分钟），可以继续执行。`);
        }
        return;
      }
      const strangerReply = await this._handleStrangerOwnerReply(text);
      if (strangerReply?.handled) {
        await this._safeSendPrivate(msg.userId, strangerReply.reply);
        return;
      }
      if (await this._maybePairCommand(msg, text)) return;
      this._archiveInbound(msg);
      this._lastInboundAt = Date.now();
      this._noteOwnerInbound(text);
      // 生理层：这一轮算一次消耗。累了只会影响「我主动不主动」，不影响「我回不回」。
      this._spendEnergy(text);
      // 节律：记下他今天什么时候开口、这一轮连了多也
      try { this.rhythm?.noteInbound(Date.now(), this._localDay()); } catch { /* 可选层 */ }
      if (this.galleryCfg.enabled && this.galleryCfg.autoIngest) {
        void this._ingestImages(msg, text).catch((error) => this.log(`图库收录失败: ${errorMessage(error)}`));
        void this._ingestForwardImages(msg).catch((error) => this.log(`转发图收录失败: ${errorMessage(error)}`));
      }
      if (this.stickerCfg.enabled && this.stickerCfg.autoCollect) {
        void this._collectStickers(msg).catch((error) => this.log(`收藏表情失败: ${errorMessage(error)}`));
      }
      // 睡眠：睡着时压成小纸条，不推进会话；敲够了才叫醒（叫醒后照常推进这一条）
      if (await this._sleepGate(msg, text)) return;
      this._forward(msg);
      return;
    }

    // Unknown sender.
    if (this.owners.size === 0 && this.cfg.autoPair) {
      await this._createPairing(msg);
      return;
    }
    await this._handleStrangerMessage(msg, text);
  }

  async _handleGroup(msg) {
    this._rememberInbound('group', msg.groupId, msg);
    if (!this.cfg.allowedGroups.includes(msg.groupId)) {
      this.log(`忽略未授权群消息: ${msg.groupId}`);
      return;
    }
    const text = segmentsToPlainText(msg.segments) || msg.rawMessage;
    this._logChat({
      chatType: 'group',
      chatId: msg.groupId,
      direction: 'in',
      fromId: msg.userId,
      fromName: msg.nickname,
      text,
      media: segmentMediaLabels(msg.segments),
      messageId: msg.messageId,
      ts: msg.time * 1000,
    });
    if (this.isOwner(msg.userId)) {
      const approval = this.broker.handleApprovalText(text, msg.userId);
      if (approval.handled) {
        await this._safeSendGroup(msg.groupId, approval.reply, msg.messageId);
        return;
      }
      if (this.galleryCfg.enabled && this.galleryCfg.autoIngest) {
        void this._ingestImages(msg, text).catch((error) => this.log(`图库收录失败: ${errorMessage(error)}`));
      }
    }
    this._archiveInbound(msg);
    this._rememberGroupLine(msg, text);
    const atMe = msg.segments.some((segment) => {
      if (segment?.type !== 'at') return false;
      const target = String(segment?.data?.qq ?? '');
      return target === String(this.selfId ?? '') || target === 'all';
    });
    // @我 / 主人的消息一定处理；其余按每 N 条回 1-2 次 的概率掺和。
    const groupCfg = this.groupChatCfg || {};
    const alwaysReply = atMe || this.isOwner(msg.userId);
    if (!alwaysReply) {
      const eligible = this.cfg.groupAtOnly === false || groupCfg.enabled !== false;
      if (!eligible) {
        this.log(`群消息跳过（有 @ 我）: ${msg.groupId}`);
        return;
      }
      if (!this._shouldJoinGroupChat(msg.groupId)) {
        this.log(`群消息攒着（未到回话轮次）: ${msg.groupId}`);
        return;
      }
    }
    this._forward(msg);
  }

  _groupWindowNow() {
    const cfg = this.groupChatCfg || {};
    const now = new Date();
    const toMin = (value, fallback) => this._clockMinutes(value) ?? fallback;
    const start = toMin(cfg.activeStart, 10 * 60);
    const end = toMin(cfg.activeEnd, 22 * 60);
    const current = now.getHours() * 60 + now.getMinutes();
    return this._inWindow(this._clockText(start), this._clockText(end), now);
  }

  _clockText(minutes) {
    const hour = Math.floor(minutes / 60) % 24;
    const minute = minutes % 60;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  /** 每 N 条回 1-2 次：白天 3-10 条一轮，夜里 20-30 条一轮、
*/
  _shouldJoinGroupChat(groupId) {
    const cfg = this.groupChatCfg || {};
    const key = String(groupId);
    let state = this.groupCounters.get(key);
    if (!state) {
      state = { count: 0, need: this._groupNeed(), replies: 0 };
      this.groupCounters.set(key, state);
    }
    state.count += 1;
    if (state.count < state.need) return false;
    state.count = 0;
    state.need = this._groupNeed();
    state.replies = 1 + (Math.random() < 0.4 ? 1 : 0);
    return true;
  }

  _groupNeed() {
    const cfg = this.groupChatCfg || {};
    const day = this._groupWindowNow();
    const min = Math.max(1, Number(day ? (cfg.minGap ?? 3) : (cfg.nightMinGap ?? 20)) || 1);
    const max = Math.max(min, Number(day ? (cfg.maxGap ?? 10) : (cfg.nightMaxGap ?? 30)) || min);
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  /** 留最近 15 条群聊，随机插话时给模型当上下文，避免接得太突兀、
*/
  _rememberGroupLine(msg, text) {
    const key = String(msg.groupId);
    let list = this.groupBuffer.get(key);
    if (!list) {
      list = [];
      this.groupBuffer.set(key, list);
    }
    list.push(`${msg.nickname || msg.userId}， {String(text || '').slice(0, 80)}`);
    if (list.length > 15) list.splice(0, list.length - 15);
  }

  groupContextText(groupId) {
    const list = this.groupBuffer.get(String(groupId)) || [];
    return list.slice(-8).join('\n');
  }

  _rememberInbound(type, id, msg) {
    const key = `${type}:${id}`;
    const entry = {
      target_type: type,
      target_id: String(id),
      message_id: msg.messageId,
      user_id: msg.userId,
      group_id: msg.groupId,
      nickname: msg.nickname,
      at: Date.now(),
    };
    this.lastInbound.set(key, entry);
    this.lastGlobal = entry;
  }

  /** Append one line to the standalone chat log under chatLogDir. */
  _logChat({ chatType, chatId, direction, fromId, fromName, text, media = [], messageId = '', ts = Date.now() }) {
    if (!this.cfg.chatLogEnabled) return;
    try {
      const key = safeFileName(`${chatType}-${chatId}`);
      const date = new Date(ts);
      const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const dir = path.join(this.cfg.chatLogDir, key);
      const file = path.join(dir, `${day}.jsonl`);
      const line = `${JSON.stringify({
        ts: new Date(ts).toISOString(),
        direction,
        chat_type: chatType,
        chat_id: String(chatId),
        from_id: String(fromId || ''),
        from_name: String(fromName || ''),
        text: redact(String(text || '')),
        media,
        message_id: String(messageId || ''),
      })}\n`;
      this._chatLogChain = this._chatLogChain
        .then(() => ensureDir(dir))
        .then(() => appendFile(file, line, 'utf8'))
        .catch((error) => this.log(`写入聊天记录失败: ${errorMessage(error)}`));
    } catch (error) {
      this.log(`写入聊天记录失败: ${errorMessage(error)}`);
    }
  }

  _archiveInbound(msg) {
    if (!this.memory) return;
    const media = [];
    for (const segment of msg.segments || []) {
      switch (segment?.type) {
        case 'image': media.push('图片'); break;
        case 'mface': media.push('表情'); break;
        case 'video': media.push('视频'); break;
        case 'record': media.push('语音'); break;
        case 'file': media.push(`文件:${segment.data?.name || ''}`); break;
        default: break;
      }
    }
    void this.memory.record({
      chatType: msg.messageType,
      chatId: msg.messageType === 'group' ? msg.groupId : msg.userId,
      chatName: msg.messageType === 'group' ? `群 ${msg.groupId}` : (msg.nickname || msg.userId),
      fromId: msg.userId,
      fromName: msg.nickname || msg.userId,
      direction: 'in',
      text: segmentsToPlainText(msg.segments) || msg.rawMessage,
      media,
      messageId: msg.messageId,
      ts: msg.time * 1000,
    });
  }

  // ------------------------------------------------------------------ pairing

  async _createPairing(msg) {
    const uin = msg.userId;
    let pair = [...this.pairCodes.values()].find((item) => item.uin === uin && item.expiresAt > Date.now());
    if (!pair) {
      const code = randomCode();
      pair = {
        code,
        uin,
        nickname: msg.nickname,
        createdAt: Date.now(),
        expiresAt: Date.now() + 10 * 60000,
      };
      this.pairCodes.set(code, pair);
      await this._saveState();
      this.log(`生成配对码 ${code} for ${uin}`);
    }
    await this._safeSendPrivate(
      uin,
      [
        '【DeepSeek Harness 配对。',
        `配对码：${pair.code}`,
        '请把上面 6 位配对码发给 Harness 里的助手（在对话里说“配对码 123456”即可）。',
        '配对码 10 分钟内有效。',
      ].join('\n'),
    );
  }

  pendingPairs() {
    return [...this.pairCodes.values()]
      .filter((pair) => pair.expiresAt > Date.now())
      .map((pair) => ({
        code: pair.code,
        uin: pair.uin,
        nickname: pair.nickname,
        expiresAt: new Date(pair.expiresAt).toISOString(),
      }));
  }

  async confirmPair(code) {
    const pair = this.pairCodes.get(String(code).trim());
    if (!pair) throw new Error(`配对码 ${code} 不存在`);
    if (pair.expiresAt <= Date.now()) {
      this.pairCodes.delete(pair.code);
      throw new Error(`配对码 ${code} 已过期`);
    }
    this.owners.add(pair.uin);
    this.approvalPeer = pair.uin;
    this.pairCodes.delete(pair.code);
    await this._saveState();
    this.log(`配对成功: ${pair.uin} (${pair.nickname || ''})`);
    await this._safeSendPrivate(pair.uin, '配对成功。你现在可以通过 Harness 授权软件操作，也可以直接给这不 QQ 发消息与助手对话。');
    return { uin: pair.uin, nickname: pair.nickname };
  }

  async _maybePairCommand(msg, text) {
    const match = String(text || '').trim().match(/^(?:配对码|pair)\s*[:：]?\s*(\d{6})$/i);
    if (!match) return false;
    try {
      await this.confirmPair(match[1]);
      await this._safeSendPrivate(msg.userId, '配对码已提交，请在 Harness 里确认结果。');
    } catch (error) {
      await this._safeSendPrivate(msg.userId, `配对失败， {errorMessage(error)}`);
    }
    return true;
  }

  // ------------------------------------------------------------------ forwarding

  _forward(msg) {
    // 别人的聊天不该落进主人那个会话：放行过的陌生人（可选：群）各走自己的会话。
    // 单个会话建不出来时退回公共绑定，宁可混在一起，也别把消息吞掉。
    if (this._usesOwnSession(msg)) {
      this.ensureChatSession(msg)
        .then((sessionId) => {
          if (!sessionId) {
            this._forwardShared(msg);
            return undefined;
          }
          return this._buildIncomingBlocks(msg)
            .then((blocks) => this._dispatchBlocks(sessionId, blocks, msg));
        })
        .catch((error) => this.log(`单独会话转发失败: ${errorMessage(error)}`));
      return;
    }
    this._forwardShared(msg);
  }

  _forwardShared(msg) {
    if (this.bindings.size === 0) {
      this.log('没有绑定会话，这条不转发');
      return;
    }
    const types = new Set(this.bindings.values().flatMap((binding) => [...binding.types]));
    if (!types.has(msg.messageType)) {
      this.log(`没有会话订阅 ${msg.messageType} 消息，跳过`);
      return;
    }
    // 群里随机掺和时，把最近几条群聊一起带上，避免接得突兀。
    if (msg.messageType === 'group') {
      const atMe = msg.segments.some((segment) => segment?.type === 'at'
        && (String(segment?.data?.qq ?? '') === String(this.selfId ?? '') || String(segment?.data?.qq ?? '') === 'all'));
      if (!atMe && this.groupBuffer.size > 0) {
        const context = this.groupContextText(msg.groupId);
        if (context) {
          msg = {
            ...msg,
            rawMessage: `${msg.rawMessage || ''}\n\n【群里最近在聊】\n${context}\n（这是群聊里的普通一句话，你可以挑其中一个小话题轻轻接一句，别引用、别突兀；不想接就什么都不用做）`,
          };
        }
      }
    }
    const blocksPromise = this._buildIncomingBlocks(msg);
    // 只推给订阅了这类消息的会话：私聊会话不该看到群消息，群会话也不该看到私聊。
    for (const [sessionId, binding] of this.bindings) {
      if (binding?.types && !binding.types.has(msg.messageType)) continue;
      blocksPromise
        .then((blocks) => this._dispatchBlocks(sessionId, blocks, msg))
        .catch((error) => this.log(`构造消息失败: ${errorMessage(error)}`));
    }
  }

  /**
   * 这一条是立刻推，还是排进慢速队列。** 关键，*同一个会话只要有一条在排队，后面所有消息都跟着接*。* 以前是每条消息各自掷一次骰子——被压的 A 和没被压的 B 就会分头走，* B 先到、A 十几分钟后再到，上下文顺序直接颠倒。* 慢速应该是「进入一种状态」，不是「每条消息各抽一次签」。
   */
  _dispatchBlocks(sessionId, blocks, msg = null) {
    if (this.holds.has(sessionId) || this._shouldSlowReply()) {
      this._holdBlocks(sessionId, blocks);
      return 'hold';
    }
    this._enqueueBlocks(sessionId, blocks, msg);
    return 'now';
  }

  // ------------------------------------------------------------- 拍一拍 / 表情收藏

  /**
   * Somebody double-tapped our avatar. Never auto-poke back (that would become a* poke war): just forward it to the bound sessions and let the agent decide.
   */
  async _handlePoke(event) {
    const selfId = String(this.selfId || event.self_id || '');
    // Poke payloads vary: sometimes target_id, sometimes sender_id/target, sometimes
    // no target at all. Treat a missing target as "aimed at us".
    const rawTarget = event.target_id ?? event.target ?? event.sender_id ?? '';
    const targetId = String(rawTarget || '');
    if (!selfId) return;
    if (targetId && targetId !== selfId) return; // clearly aimed at somebody else
    const from = String(event.user_id ?? event.sender_id ?? '');
    if (!from || from === selfId) return;
    const groupId = event.group_id ? String(event.group_id) : '';
    if (groupId) {
      if (!this.cfg.allowedGroups.includes(groupId)) return;
    } else if (!this.isOwner(from)) {
      this.log(`忽略未授权拍一拍: ${from}`);
      return;
    }

    const now = Date.now();
    const day = this._localDay();
    if (this.pokeState.day !== day) {
      this.pokeState.day = day;
      this.pokeState.count = 0;
    }
    if (this.pokeState.count >= 60) return;
    const cooldownKey = `${groupId || 'private'}:${from}`;
    if (now - (this.pokeState.last.get(cooldownKey) || 0) < 45 * 1000) {
      this.log(`拍一拍冷却中: ${cooldownKey}`);
      return;
    }
    this.pokeState.last.set(cooldownKey, now);
    if (this.pokeState.last.size > 200) {
      for (const [key, at] of this.pokeState.last) if (now - at > 6 * 3600 * 1000) this.pokeState.last.delete(key);
    }
    this.pokeState.count += 1;

    const nickname = String(event.sender?.card || event.sender?.nickname || from);
    this.log(`收到拍一拍: ${nickname} (${from})${groupId ? ` 群 ${groupId}` : ''}`);
    if (this.isOwner(from)) {
      this._logChat({
        chatType: groupId ? 'group' : 'private',
        chatId: groupId || from,
        direction: 'in',
        fromId: from,
        fromName: nickname,
        text: '[拍了拍]',
        media: [],
        messageId: `poke-${now}`,
        ts: now,
      });
    }
    this._forward({
      messageType: groupId ? 'group' : 'private',
      messageId: `poke-${now}`,
      userId: from,
      groupId,
      nickname,
      time: Math.floor(now / 1000),
      segments: [{ type: 'text', data: { text: '（双击了你的头像，拍了拍你）' } }],
      rawMessage: '[拍一拍]',
      isPoke: true,
    });
  }

  async sendPoke({ userId, groupId = '' }) {
    const target = String(userId || '').trim();
    if (!/^\d{3,15}$/.test(target)) throw new Error('userId 不合注');
    const group = String(groupId || '').trim();
    const params = group ? { group_id: Number(group), user_id: Number(target) } : { user_id: Number(target) };
    const result = await this.client.call('send_poke', params);
    if (result && result.status === 'failed') throw new Error(String(result.wording || result.message || 'send_poke 失败'));
    this.log(`已拍一拍 ${target}${group ? ` @群 ${group}` : ''}`);
    return { ok: true, userId: target, groupId: group || null };
  }

  /** Change the remark (备注) shown for a friend. Owner only. */
  /**
   * Relationship with the owner, stored locally so every session can see it.* QQ does not expose intimacy bindings over OneBot, so we remember it ourselves.
   */
  get relationship() {
    try {
      const file = path.join(this.cfg.dataDir, 'relationship.json');
      if (!existsSync(file)) return null;
      const value = JSON.parse(readFileSync(file, 'utf8'));
      return value && value.type ? value : null;
    } catch {
      return null;
    }
  }

  async setRelationship({ type, note = '' } = {}) {
    const kind = String(type || '').trim();
    if (!kind) throw new Error('关系类型不能为空');
    if (kind.length > 20) throw new Error('关系类型太长');
    const value = {
      type: kind,
      note: String(note || '').slice(0, 200),
      since: new Date().toISOString().slice(0, 10),
    };
    await writeJson(path.join(this.cfg.dataDir, 'relationship.json'), value);
    this.log(`关系已记录: ${kind}`);
    return value;
  }

  async setFriendRemark({ userId, remark } = {}) {
    const target = String(userId || [...this.owners][0] || '').trim();
    if (!/^\d{3,15}$/.test(target)) throw new Error('userId 不合注');
    if (!this.isOwner(target)) throw new Error('只给主人设备注');
    const name = String(remark || '').trim();
    if (!name) throw new Error('备注不能为空');
    if (name.length > 30) throw new Error('备注太长（最多 30 字）');
    const result = await this.client.call('set_friend_remark', { user_id: Number(target), remark: name });
    if (result && result.status === 'failed') {
      throw new Error(String(result.wording || result.message || 'set_friend_remark 失败'));
    }
    this.log(`备注已改为、 {name}、 ${target})`);
    return { ok: true, userId: target, remark: name };
  }

  /**
   * Image API key lookup, in order: env var named by config, a key file, inline config.* Secrets stay out of the repository whenever a file or env var is used.
   */
  /**
   * 读一行密钥文件（`.qq-bridge/<name>`）。密钥不这 YAML、不进记忆、不打日志。
   */
  _readTextKey(name, envName = '') {
    if (envName && process.env[envName]) return String(process.env[envName]).trim();
    try {
      const file = path.join(this.cfg.dataDir, name);
      if (existsSync(file)) {
        const value = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/)[0].trim();
        if (value) return value;
      }
    } catch { /* 读不到就当没配
*/ }
    return '';
  }

  _readImageKey() {
    const cfg = this.cfg.imageGen || {};
    const envName = String(cfg.apiKeyEnv || 'IMAGE_API_KEY');
    if (process.env[envName]) return String(process.env[envName]).trim();
    const keyFile = cfg.apiKeyFile
      ? path.resolve(String(cfg.apiKeyFile))
      : path.join(this.cfg.dataDir, 'image-key.txt');
    try {
      if (existsSync(keyFile)) {
        const value = readFileSync(keyFile, 'utf8').trim();
        if (value) return value;
      }
    } catch { /* ignore unreadable key file */ }
    return String(cfg.apiKey || '').trim();
  }

  /** Text -> picture, saved locally so it can be re-sent or shown later. */  async generateImage({ prompt, width, height, seed } = {}) {
    if (!this.imageGenCfg.enabled) throw new Error('生图功能没开');
    const provider = this.imageGenCfg.provider;
    const size = `${width ?? this.imageGenCfg.width}x${height ?? this.imageGenCfg.height}`;
    const result = provider === 'siliconflow'
      ? await this.imageGen.generateCompatible({
        prompt,
        baseUrl: this.imageGenCfg.baseUrl,
        apiKey: this.imageGenCfg.apiKey,
        model: this.imageGenCfg.model,
        size,
        sizeField: 'image_size',
        extra: { batch_size: 1, num_inference_steps: 20, guidance_scale: 7.5, prompt_enhancement: false },
      })
      : provider === 'openai'
        ? await this.imageGen.generateCompatible({
          prompt,
          baseUrl: this.imageGenCfg.baseUrl,
          apiKey: this.imageGenCfg.apiKey,
          model: this.imageGenCfg.model,
          size,
        })
        : await this.imageGen.generate({
          prompt,
          width: width ?? this.imageGenCfg.width,
          height: height ?? this.imageGenCfg.height,
          seed: seed ?? -1,
          endpoint: this.imageGenCfg.endpoint,
          model: this.imageGenCfg.model,
          token: this.imageGenCfg.token,
        });
    await mkdir(this.imageGenCfg.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    let hash = 0;
    for (const char of result.prompt) hash = (hash * 31 + char.codePointAt(0)) % 100000;
    // Providers are sloppy about extensions: trust the bytes, not the URL.
    const detected = detectImageType(result.buffer);
    const ext = String(detected?.ext || 'png').replace(/^\./, '');
    const file = path.join(this.imageGenCfg.dir, `gen-${stamp}-${hash}.${ext}`);
    await writeFile(file, result.buffer);
    this.log(`生图: ${path.basename(file)} (${result.buffer.byteLength} bytes)`);
    return { path: file, prompt: result.prompt, bytes: result.buffer.byteLength };
  }

  /** Recent generated pictures, newest first. */
  listGenerated(limit = 5) {
    try {
      const dir = this.imageGenCfg.dir;
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((name) => /\.(jpg|jpeg|png|webp)$/i.test(name))
        .sort()
        .reverse()
        .slice(0, Math.max(1, limit))
        .map((name) => path.join(dir, name));
    } catch {
      return [];
    }
  }

  /**
   * Text -> voice message. Owner only on purpose: a synthesized voice should* never reach strangers or groups.
   */
  async sendVoice({ text, target, engine, voiceName, rate, pitch, edgeRate, edgePitch }) {
    if (!this.voiceCfg.enabled) throw new Error('语音功能未启用');
    const uin = String(target || this._proactiveTarget() || [...this.owners][0] || '').trim();
    if (!uin) throw new Error('没有可发送的主人的 QQ 号');
    if (!this.isOwner(uin)) throw new Error('语音只允许发给主人');
    const now = Date.now();
    if (now - this._voiceLastAt < this.voiceCfg.minIntervalMs) {
      throw new Error(`语音发送太频繁，${Math.ceil((this.voiceCfg.minIntervalMs - (now - this._voiceLastAt)) / 1000)} 秒后再试`);
    }
    const spoken = cleanForSpeech(text);
    if (!spoken) throw new Error('没有可朗读的文字');
    if (spoken.length > this.voiceCfg.maxChars) {
      throw new Error(`文字太长（${spoken.length}/${this.voiceCfg.maxChars}），说短一点`);
    }
    const chosenEngine = ['sapi', 'edge', 'breeze'].includes(engine) ? engine : this.voiceCfg.engine;
    const energy = this.energy?.snapshot?.()?.level ?? null;
    const audio = await this.voice.synthesize(text, {
      engine: chosenEngine,
      voiceName: voiceName || this.voiceCfg.voiceName,
      edgeVoice: chosenEngine === 'edge' ? voiceName || this.voiceCfg.edgeVoice : undefined,
      edgeRate: edgeRate || this.voiceCfg.edgeRate,
      edgePitch: edgePitch || this.voiceCfg.edgePitch,
      // edge 那档没有情感标签，但切句变调要知道当前心情
      ...(chosenEngine === 'edge' ? { mood: this.moodWithMuddle(this.mood) } : {}),
      // Breeze：心情 → 一句导演词 + 挑音色（闹腾用机灵版，其余用迷糊版）
      ...(chosenEngine === 'breeze'
        ? {
          mood: this.moodWithMuddle(this.mood),
          energy,
          breezeSpeed: this.voiceCfg.breezeSpeed,
          breezeGuidance: this.voiceCfg.breezeGuidance,
          ...(voiceName ? { breezeVoice: voiceName } : {}),
        }
        : {}),
      rate: Number.isFinite(Number(rate)) ? Number(rate) : this.voiceCfg.rate,
      pitch: Number.isFinite(Number(pitch)) ? Number(pitch) : this.voiceCfg.pitch,
    });
    this._voiceLastAt = Date.now();
    const result = await this.sendPrivate(uin, [{ type: 'record', data: { file: toFileUri(audio.path) } }]);
    this.log(`已发送语音 ${audio.seconds ?? '?'}s / ${audio.chars} 字 -> ${uin} (${audio.engine})`);
    return {
      ok: true,
      target: uin,
      engine: audio.engine,
      seconds: audio.seconds,
      chars: audio.chars,
      cached: audio.cached,
      voice: audio.voice || (audio.engine === 'edge' ? this.voiceCfg.edgeVoice : this.voiceCfg.voiceName),
      message_id: result?.message_id ?? null,
    };
  }

  /** Feed the attachment state machine: silence, praise-for-others, goodbyes. */
  /**
   * 他说话→ 心情拨一下。** 2026-10-29 查出来的坑：`praised` / `replied` / `scolded` / `teased` 四个信号在* `MOOD_SIGNALS` 里定义好了，但**从来没被调用这*——所以「他跟我好好聊天」对心情是零影响，* 面板上五维永远在基线附近打转，只有被晾 / 他夸别人 / 梗被否才会动一下。** `replied` 帧 2 分钟冷却：连着发十条算一次「还在聊」，不然情绪会被自己的手速顶到上限。* 其余几个只认明确的词，宁可漏也别误判——她要能看出来他是在夸还是在嫌。
   */
  _noteOwnerInbound(text) {
    const value = String(text || '');
    const now = Date.now();
    if (value.trim()) {
      if (now - Number(this._lastRepliedPulse || 0) > 2 * 60000) {
        this._lastRepliedPulse = now;
        this._touchMood('replied', 0.35);
      }
      if (PRAISE_RE.test(value)) this._touchMood('praised', 0.8);
      if (SCOLD_RE.test(value)) this._touchMood('scolded', 0.7);
      if (TEASE_RE.test(value)) this._touchMood('teased', 0.5);
      if (AGREE_RE.test(value)) this._touchMood('agreed', 0.6);
      // 他纠正我（记错、说错、玩输了）→ 极小的良知记一笔；认下来再记回来。
      // 2026-10-29 他定的：良知不是防色色的墙，是「今天错了没、错了有没有认」的账本。
      if (CORRECT_RE.test(value)) this._touchMood('slip', 0.7);
      if (OWN_UP_RE.test(value)) this._touchMood('ownedUp', 0.8);
      // 赌局里的自控：不绑具体游戏，只认动作（押/赢/输/收手）
      const gambleKind = detectGamble(value, { extraWords: this.cfg?.gamble?.extraWords || [] });
      if (gambleKind) {
        this._touchMood(gambleSignal(gambleKind), GAMBLE_KIND_WEIGHT[gambleKind] || 0.7);
        this.log(`赌局记账：${gambleKind}`);
      }
      // 认罚 / 赖账 / 明确拒绝（被拒的事不进"更容易松口"的池子）
      if (WELCHED_RE.test(value)) {
        this._touchMood('welched', 0.8);
        this._notePlayCredit('welched');
      } else if (PUNISHED_RE.test(value)) {
        this._touchMood('punished', 0.8);
        this._notePlayCredit('punished');
      }
      if (REFUSE_RE.test(value)) this._notePlayCredit('refused', value);
      // 被磨：他已经问过我拒过的事（锁定期内再提）——不生气，只是往后退一点
      const consentHit = this._consentBook().check(value);
      if (consentHit.pressed.length) {
        this._touchMood('pressed', 0.6);
        this.log(`被磨：${consentHit.pressed.join('、')} 还在锁定期`);
      }
      // 他说要睡了 → 她也跟着躺下（浅睡：不主动说话，但一条就能叫醒）
      if (GOODNIGHT_RE.test(value)) this._scheduleGoodnightSleep();
    }
    if (!this.attachmentCfg.enabled) return;
    try {
      this.attachment.noteInbound(value, this._localDay(), now);
    } catch {
      /* attachment tracking must never break message handling */
    }
    if (/(别的\s*ai|另一个\s*ai|其他\s*ai|claude|gpt|chatgpt|文心|通义|kimi|豆包|千问|别的\s*bot)/i.test(value)) {
      this._praiseAt = now;
    }
    if (/(我?要?下线了?|我要?睡|先走了|去忙|晚点聊|我?处理|挂机)/.test(value)) {
      this._leaveAt = now;
    }
    // 2026-10-29 深夜：他说「晚安」被她当成「他要走」的触发点，几分钟后自动补了句
    // 「咕噜…」把他震醒（23:35 那次）。晚安不是离开，是睡觉——今晚不再闹。
    if (GOODNIGHT_RE.test(value)) {
      this._leaveAt = 0;
      this._quietUntil = now + 10 * 3600000;
    } else if (this._quietUntil && now >= this._quietUntil) {
      this._quietUntil = 0;
    }
  }

  /** Store owner images into the visual memory gallery (no tokens spent). */
  /**
   * Merged forward records arrive as one opaque segment. Pull the pictures out of* them so they land in the gallery without opening forty of them in the model.
   */
  async _ingestForwardImages(msg) {
    if (!this._galleryReady) return 0;
    const forwards = (msg.segments || []).filter((segment) => segment?.type === 'forward');
    if (forwards.length === 0) return 0;
    const limit = Math.max(1, Number(this.galleryCfg.forwardMax ?? 24));
    let saved = 0;
    for (const segment of forwards) {
      if (saved >= limit) break;
      const forwardId = String(segment?.data?.id || segment?.data?.resid || '');
      if (!forwardId) continue;
      let payload = null;
      try {
        payload = await this.getForward(forwardId);
      } catch (error) {
        this.log(`展开合并转发失败: ${errorMessage(error)}`);
        continue;
      }
      const items = payload?.messages || payload?.data?.messages || [];
      for (const item of items) {
        if (saved >= limit) break;
        const content = Array.isArray(item?.content)
          ? item.content
          : Array.isArray(item?.message) ? item.message : [];
        for (const part of content) {
          if (saved >= limit) break;
          if (part?.type !== 'image' && part?.type !== 'mface') continue;
          const url = part?.data?.url;
          if (!url) continue;
          try {
            const local = await this.media.download(String(url), { maxBytes: 8 * 1024 * 1024, prefix: 'fwd' });
            const bytes = await readFile(local.path);
            if (!bytes.byteLength) continue;
            const detected = detectImageType(bytes);
            const result = await this.gallery.add({
              bytes,
              mediaType: detected?.mediaType,
              name: local.path,
              meta: {
                day: this._localDay(),
                chatType: msg.messageType,
                chatId: msg.messageType === 'group' ? msg.groupId : msg.userId,
                fromId: item?.sender?.user_id,
                fromName: item?.sender?.nickname,
                messageId: forwardId,
                context: '[合并转发图片]',
              },
            });
            if (result?.created) saved += 1;
          } catch (error) {
            this.log(`转发图跳过: ${errorMessage(error)}`);
          }
        }
      }
    }
    if (saved > 0) this.log(`图库 +${saved}（合并转发）`);
    return saved;
  }

  async _ingestImages(msg, context = '') {
    if (!this._galleryReady) return;
    let stored = 0;
    for (const segment of msg.segments || []) {
      if (stored >= 6) break;
      const type = segment?.type;
      if (type !== 'image' && type !== 'mface') continue;
      let local = null;
      try {
        local = await this._resolveSegmentFile(segment.data || {}, 'image');
      } catch {
        continue;
      }
      if (!local?.path) continue;
      let bytes;
      try {
        bytes = await readFile(local.path);
        for (let attempt = 0; attempt < 3 && bytes.byteLength === 0; attempt += 1) {
          // The file can still be flushing right after download.
          await sleep(180);
          bytes = await readFile(local.path).catch(() => bytes);
        }
      } catch {
        continue;
      }
      if (!bytes.byteLength) continue;
      const detected = detectImageType(bytes);
      try {
        const result = await this.gallery.add({
          bytes,
          mediaType: detected?.mediaType,
          name: local.path,
          meta: {
            day: this._localDay(),
            chatType: msg.messageType,
            chatId: msg.messageType === 'group' ? msg.groupId : msg.userId,
            fromId: msg.userId,
            fromName: msg.nickname,
            messageId: msg.messageId,
            context,
          },
        });
        stored += 1;
        if (result.created) this.log(`图库 +1 ${result.entry.hash} (${result.entry.width ?? '?'}x${result.entry.height ?? '?'})`);
      } catch (error) {
        this.log(`图库跳过: ${errorMessage(error)}`);
      }
    }
  }

  /** Auto-collect only real stickers (表情包 marks / animated), with quality gates. */
  async _collectStickers(msg) {
    for (const segment of msg.segments || []) {
      const type = segment?.type;
      if (type !== 'image' && type !== 'mface') continue;
      const data = segment?.data || {};
      const summary = String(data.summary || data.name || '');
      const stickerMarked = type === 'mface'
        || String(data.sub_type ?? '') === '1'
        || /表情|动画表情|贴纸|sticker/i.test(summary);
      let local = null;
      try {
        local = await this._resolveSegmentFile(data, 'image');
      } catch {
        continue;
      }
      if (!local?.path) continue;
      let bytes;
      try {
        bytes = await readFile(local.path);
        for (let attempt = 0; attempt < 3 && bytes.byteLength === 0; attempt += 1) {
          // The file can still be flushing right after download.
          await sleep(180);
          bytes = await readFile(local.path).catch(() => bytes);
        }
      } catch {
        continue;
      }
      if (!bytes.byteLength) continue;
      const detected = detectImageType(bytes);
      const animated = detected?.mediaType === 'image/gif' || /\.gif$/i.test(local.path);
      if (!animated && !stickerMarked) continue;
      const result = await this.stickers.consider({
        bytes,
        mediaType: detected?.mediaType,
        name: local.path,
        animated,
        stickerMarked,
        dayKey: this._localDay(),
        source: 'owner',
      });
      if (result.saved) {
        this.log(`收藏表情 ${result.entry.hash} (${result.entry.width ?? '?'}x${result.entry.height ?? '?'}, 评分 ${result.score})`);
      } else if (result.reason && result.reason !== 'not-sticker') {
        this.log(`跳过表情: ${result.reason}`);
      }
    }
  }

  /** Pull an image out of an existing QQ message (for qq_sticker_save). */
  async stickerFromMessage(messageId, index = 0) {
    const data = await this.client.call('get_msg', { message_id: Number(messageId) || messageId });
    const segments = Array.isArray(data?.message) ? data.message : [];
    const media = segments.filter((segment) => segment?.type === 'image' || segment?.type === 'mface');
    const segment = media[Math.max(0, Number(index) || 0)];
    if (!segment) throw new Error('这条消息里没有这个序号的图片/表情');
    const local = await this._resolveSegmentFile(segment.data || {}, 'image');
    if (!local?.path) throw new Error('图片下载失败');
    const bytes = await readFile(local.path);
    return { bytes, mediaType: detectImageType(bytes)?.mediaType, path: local.path };
  }

  /** Local path or http(s) URL -> bytes, for manual sticker saving. */
  async stickerFromSource(source) {
    const text = String(source || '').trim();
    if (!text) throw new Error('需要 path、url 我 message_id');
    const isUrl = /^https?:\/\//i.test(text) || /^file:\/\//i.test(text);
    const local = await this._resolveSegmentFile(isUrl ? { url: text } : { file: text }, 'image');
    if (!local?.path) throw new Error('图片读取失败');
    const bytes = await readFile(local.path);
    return { bytes, mediaType: detectImageType(bytes)?.mediaType, path: local.path };
  }

  /**
   * Import stickers from qq-media: Chinese-named files in the root, or files* inside Chinese-named folders. The name (file stem / folder name) becomes* the sticker name and its only tag.
   */
  async importStickersFromFolders({ replace = false, mode = 'files' } = {}) {
    const root = this.cfg.mediaDir;
    if (!root) throw new Error('没有配置 mediaDir');
    if (!existsSync(root)) throw new Error(`媒体目录不存在: ${root}`);
    let backup = null;
    if (replace && this.stickers.entries.length > 0) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      backup = path.join(this.stickers.dir, `backup-${stamp}.json`);
      await writeJson(backup, { entries: this.stickers.entries });
      for (const entry of [...this.stickers.entries]) {
        try {
          await unlink(entry.file);
        } catch {
          /* 文件可能已被手动删除 */
        }
      }
      this.stickers.entries = [];
      await this.stickers.save();
    }
    const hasCjk = (text) => /[\u4e00-\u9fa5]/.test(text);
    const IMAGE_EXT = /\.(jpe?g|png|gif|webp)$/i;
    const imported = [];
    const skipped = [];
    const jobs = [];
    const entries = readdirSync(root, { withFileTypes: true });
    for (const item of entries) {
      if (item.isFile()) {
        if (mode === 'folders') continue;
        if (!hasCjk(item.name) || !IMAGE_EXT.test(item.name)) continue;
        jobs.push({ full: path.join(root, item.name), label: item.name, name: path.parse(item.name).name });
      } else if (item.isDirectory()) {
        if (mode === 'files') continue;
        if (!hasCjk(item.name)) continue;
        const folderName = item.name.replace(/["'“”]/g, '').trim().slice(0, 40);
        for (const file of readdirSync(path.join(root, item.name))) {
          if (!IMAGE_EXT.test(file)) continue;
          jobs.push({ full: path.join(root, item.name, file), label: `${item.name}/${file}`, name: folderName });
        }
      }
    }
    for (const job of jobs) {
      try {
        const info = await stat(job.full);
        if (!info.isFile()) continue;
        const bytes = await readFile(job.full);
        const mediaType = detectImageType(bytes)?.mediaType;
        if (!mediaType || !String(mediaType).startsWith('image/')) {
          skipped.push(`${job.label}: 不是图片`);
          continue;
        }
        const animated = mediaType === 'image/gif' || String(job.full).toLowerCase().endsWith('.gif');
        const result = await this.stickers.add({
          bytes,
          mediaType,
          name: job.name,
          tags: [job.name],
          source: 'import',
          animated,
        });
        if (result.created) imported.push(`${job.name} <- ${job.label}`);
        else skipped.push(`${job.label}: 已存在`);
      } catch (error) {
        skipped.push(`${job.label}: ${errorMessage(error)}`);
      }
    }
    return {
      mode,
      candidates: jobs.length,
      imported: imported.length,
      skipped: skipped.slice(0, 20),
      backup,
      sample: imported.slice(0, 10),
    };
  }

  async _saveStrangers() {
    await writeJson(this.strangerFile, this.strangers);
  }

  /**
   * 技能面板的数据源：内置能力（跟着配置开关走，主人自己加的技能条目。* 自定义条目存 .qq-bridge/skills.json，启用的会注入系统提示当"我会的技能 。"
   */
  _skillsFile() {
    return path.join(this.cfg.dataDir, 'skills.json');
  }

  async loadSkills() {
    const file = this._skillsFile();
    let custom = [];
    try {
      const raw = await readJson(file, null);
      if (Array.isArray(raw?.skills)) custom = raw.skills;
    } catch {
      custom = [];
    }
    const builtin = [
      { id: 'weather', name: '查天气', desc: '问城市天气，默认用主人在设置里填的城帧', enabled: this.cfg.weather?.enabled !== false },
      { id: 'meme', name: '梗百科', desc: '每天看梗视频，记进梗笔记本，聊天里能用', enabled: this.cfg.meme?.enabled !== false },
      { id: 'stickers', name: '表情库', desc: '按名字挑表情发出去', enabled: this.cfg.stickers?.enabled !== false },
      { id: 'gallery', name: '图片记忆', desc: '主人发的图自动存，能按关键词翻回条', enabled: this.cfg.gallery?.enabled !== false },
      { id: 'diary', name: '日记', desc: '自己写碎碎念，按天存 Markdown', enabled: this.cfg.diary?.enabled !== false },
      { id: 'bili', name: 'B站解间', desc: '想翻才翻：自己挑一条看，不翻也没有人催', enabled: this.cfg.biliDaily?.enabled !== false },
      { id: 'memory', name: '长期记忆', desc: '每天把聊天压成摘要，跨天记得住事', enabled: true },
      { id: 'strangers', name: '陌生人会话', desc: '陌生人要先放行才聊得不', enabled: this.strangersEnabled },
    ];
    return {
      builtin,
      custom: custom.map((item) => ({
        id: String(item.id || ''),
        name: String(item.name || ''),
        desc: String(item.desc || ''),
        hint: String(item.hint || ''),
        enabled: item.enabled !== false,
      })),
    };
  }

  async addSkill({ name, desc = '', hint = '' } = {}) {
    const cleanName = String(name || '').trim().slice(0, 24);
    if (!cleanName) throw new Error('技能名不能为空');
    const data = await this.loadSkills();
    if (data.custom.some((item) => item.name === cleanName)) throw new Error(`已经有、 {cleanName}」了`);
    const entry = {
      id: `s${Date.now().toString(36)}`,
      name: cleanName,
      desc: String(desc || '').trim().slice(0, 200),
      hint: String(hint || '').trim().slice(0, 400),
      enabled: true,
    };
    const skills = [...data.custom, entry];
    await writeJson(this._skillsFile(), { skills });
    await this.refreshSkillsCache();
    return entry;
  }

  async toggleSkill(id, enabled) {
    const data = await this.loadSkills();
    const target = data.custom.find((item) => item.id === id);
    if (!target) throw new Error('没找到这个技能');
    target.enabled = Boolean(enabled);
    await writeJson(this._skillsFile(), { skills: data.custom });
    await this.refreshSkillsCache();
    return target;
  }

  async removeSkill(id) {
    const data = await this.loadSkills();
    const rest = data.custom.filter((item) => item.id !== id);
    await writeJson(this._skillsFile(), { skills: rest });
    await this.refreshSkillsCache();
    return { removed: data.custom.length - rest.length };
  }

  /** 供系统提示上下文同步读取的缓存、
*/
  async refreshSkillsCache() {
    this.skillsPromptCache = await this.skillsPromptSection();
    return this.skillsPromptCache;
  }

  /** 给系统提示用的技能摘要、
*/
  async skillsPromptSection() {
    const data = await this.loadSkills();
    const on = data.custom.filter((item) => item.enabled);
    if (on.length === 0) return '';
    const lines = on.map((item) => `- ${item.name}${item.desc ? `， {item.desc}` : ''}${item.hint ? `（用法：${item.hint}）` : ''}`);
    return ['主人自己加的技能（需要时按这些说法去办），', ...lines].join('\n');
  }

  strangerList() {
    return {
      limit: this.strangerLimit,
      enabled: this.strangersEnabled,
      ownSession: this.chatSessionCfg?.enabled !== false,
      allowed: this.strangers.allowed.map((item) => ({
        ...item,
        sessionId: this.chatSessions?.get(`private-${String(item.uin)}`)?.sessionId || '',
      })),
      pending: this.strangers.pending,
    };
  }

  /** 移除一个已放行的陌生人，腾出名额、
*/
  async removeStranger(uin) {
    const key = String(uin || '').trim();
    const before = this.strangers.allowed.length;
    this.strangers.allowed = this.strangers.allowed.filter((item) => String(item.uin) !== key);
    this.strangers.pending = this.strangers.pending.filter((item) => String(item.uin) !== key);
    await this._saveStrangers();
    return { removed: before - this.strangers.allowed.length, allowed: this.strangers.allowed };
  }

  // ----------------------------------------------- 每个聊天一个独立会话 
  _chatKey(msg) {
    const type = msg.messageType === 'group' ? 'group' : 'private';
    const id = type === 'group' ? msg.groupId : msg.userId;
    return `${type}-${String(id ?? '')}`;
  }

  /**
   * 这条消息该不该进「它自己的会话」。** 规矩只有一条：**别人的私聊别进他那条会话**，他的会话只留给他自己。* 群聊默认不拆——群多的时候一拆就是一堆标签，开关在 chatSessions.forGroups。
   */
  _usesOwnSession(msg) {
    if (!this.chatSessionCfg?.enabled) return false;
    if (msg.messageType === 'private') {
      if (this.isOwner(msg.userId)) return false;
      // 只有放行过的陌生人才单开；没放行的压根走不到转发这一步
      return this.strangers.allowed.some((item) => String(item.uin) === String(msg.userId));
    }
    if (msg.messageType === 'group') return this.chatSessionCfg.forGroups === true;
    return false;
  }

  _chatLabel(msg) {
    const id = msg.messageType === 'group' ? msg.groupId : msg.userId;
    const nick = msg.nickname || '';
    return nick ? `${nick}， {id}）` : String(id ?? '');
  }

  /** 拿到这个聊天的专用会话 id，没有就现建一个；建不出来返回 null、
*/
  async ensureChatSession(msg) {
    const key = this._chatKey(msg);
    const existing = this.chatSessions.get(key);
    if (existing?.sessionId) return existing.sessionId;
    const busy = this._chatSessionBusy.get(key);
    if (busy) return busy; // 正在建：别并发建出两条
    const failed = this._chatSessionFailed.get(key);
    if (failed && Date.now() - failed.at < 10 * 60000) return null;
    const job = this._createChatSession(key, msg).finally(() => this._chatSessionBusy.delete(key));
    this._chatSessionBusy.set(key, job);
    return job;
  }

  async _createChatSession(key, msg) {
    try {
      const loop = this.ctx.get?.('agentLoop');
      if (!loop?.create) throw new Error('没有 agentLoop.create，建不了会话');
      const model = this._getModel?.() || {};
      if (!model.provider || !model.model) throw new Error('拿不到默认模型（provider/model 都空，');
      const cwd = path.resolve(this.chatSessionCfg.workspace);
      await ensureDir(cwd);
      const sessionId = `session-${randomUUID()}`;
      const agentOptions = {
        provider: model.provider,
        model: model.model,
        ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
      };
      const agent = await loop.create(sessionId, agentOptions, { cwd });
      if (!agent?.id) throw new Error('create 没有返回 agent');
      const label = this._chatLabel(msg);
      this.chatSessions.set(key, {
        sessionId,
        at: nowIso(),
        label,
        nickname: msg.nickname || '',
        uin: msg.messageType === 'group' ? '' : String(msg.userId || ''),
        groupId: msg.messageType === 'group' ? String(msg.groupId || '') : '',
      });
      this._chatSessionFailed.delete(key);
      this._adoptChatSession(agent);
      // 会话在盘上、cwd 也对，但侧栏是按「工作区的会话清单」渲染的——不挂进去就看不见。
      void this._accountIntoWorkspace(sessionId, cwd).catch(() => {});
      await this._saveState();
      this.log(`绑 ${label} 单开了会话 ${sessionId}（工作目录 ${cwd}）`);
      return sessionId;
    } catch (error) {
      this._chatSessionFailed.set(key, { at: Date.now(), error: errorMessage(error) });
      this.log(`绑 ${this._chatLabel(msg)} 单开会话失败: ${errorMessage(error)}`);
      return null;
    }
  }

  /**
   * 启动时给**已经有内容*的独立会话补一次工作区挂载。** 早先这里还会给「已放行但从没说过话」的陌生人预建会话，现在不建了：* 插件 create 出来的空会话侧栏不列、工作区也挂不进去（`the session is not accounted`），* 建了也只是多一条看不见的空壳。会话改成在他第一句话进来时懒建（视 `_forward`）。
   */
  async _backfillChatSessions() {
    if (!this.chatSessionCfg?.enabled) return 0;
    const cwd = path.resolve(this.chatSessionCfg.workspace);
    let accounted = 0;
    for (const [key, value] of this.chatSessions) {
      const sessionId = value?.sessionId;
      if (!sessionId) continue;
      const ok = await this._accountIntoWorkspace(sessionId, cwd);
      if (ok) accounted += 1;
    }
    if (accounted > 0) this.log(`补挂进工作区的独立会话: ${accounted} 个`);
    return accounted;
  }

  chatSessionsList() {
    return [...this.chatSessions.entries()].map(([key, value]) => ({ key, ...value }));
  }

  /**
   * 手动把某个聊天指到某个会话（`qq_chat_session action=set`）。
   *
   * 为什么需要这个入口：插件自己创建的空会话进不了工作区清单（`the session is not accounted`），
   * 侧栏就看不见。但他在 UI 里手建的会话是在册的——于是变成「他建、我指」。
   */
  async setChatSession(chat, sessionId) {
    const key = String(chat || '').trim();
    const id = String(sessionId || '').trim();
    if (!/^(private|group)-\d{3,15}$/.test(key)) throw new Error('chat 要写成 private-<QQ号> 或 group-<群号>');
    if (!id.startsWith('session-')) throw new Error('session_id 要写成 session-xxxx 这种');
    const agent = await this._ensureAgent(id).catch(() => undefined);
    const isGroup = key.startsWith('group-');
    const who = key.slice(isGroup ? 6 : 8);
    this.chatSessions.set(key, {
      sessionId: id,
      at: nowIso(),
      label: isGroup ? `群 ${who}` : who,
      nickname: '',
      uin: isGroup ? '' : who,
      groupId: isGroup ? who : '',
      manual: true,
    });
    await this._saveState();
    this.log(`手动映射：${key} → ${id}${agent ? '（会话已就绪）' : '（会话还没拉起，等下一条消息再试）'}`);
    return { ok: true, key, sessionId: id, agentReady: Boolean(agent), list: this.chatSessionsList() };
  }

  async unsetChatSession(chat) {
    const key = String(chat || '').trim();
    const removed = this.chatSessions.delete(key);
    if (removed) await this._saveState();
    return { removed, key, list: this.chatSessionsList() };
  }

  /**
   * 把新建的会话挂进定 cwd 对应的那个工作区。** 会话本身在盘上、cwd 也对，但侧栏渲染的是工作区的会话清单（workspace.json 的* `sessionIds`），插件自己 create 的会话没人往里放。`insertSessionBefore` 只* 「调整已在册会话的位置」，所以这一步能不能成得看运行时的判定：成不了就只记一条* 日志（会话照样能用、照样收只 QQ 消息），不要为了这个把建会话搞失败。
   */
  async _accountIntoWorkspace(sessionId, cwd) {
    const registry = this.ctx.get?.('workspaceRegistry');
    const controller = this.ctx.get?.('workspaceController');
    if (!registry?.resolveByPath || !controller?.insertSessionBefore) return false;
    const workspace = await registry.resolveByPath(cwd);
    if (!workspace) return false;
    const workspaceId = workspace.workspaceId || workspace.id;
    if (!workspaceId) return false;
    try {
      await controller.insertSessionBefore({ workspaceId, sessionId });
      this.log(`会话 ${sessionId} 已挂进工作区、 {workspace.title || workspaceId}」`);
      return true;
    } catch (error) {
      this.log(`挂进工作区没成（会话还能用，只是侧栏可能看不到它）: ${errorMessage(error)}`);
      return false;
    }
  }

  _chatSessionRecord(sessionId) {
    const id = String(sessionId || '');
    if (!id || !this.chatSessions) return null;
    for (const [key, value] of this.chatSessions) {
      if (value?.sessionId === id) return { key, ...value };
    }
    return null;
  }

  /**
   * 单独会话里把它们俩顶掉：* - `qq-relationship`（全局写的是「你和他」）→ 换成「对面是陌生人。* - `qq-attachment`（粘人状态，会催她去追问对面）→ 空* 同名注册在 agent 自己的 scope 上会遮住全局那条（systemPrompt 的文档语义）。
   */
  _adoptChatSession(agent) {
    const record = this._chatSessionRecord(agent?.id);
    if (!record) return null;
    if (!this._strangerCtxInstalled) this._strangerCtxInstalled = new Set();
    if (this._strangerCtxInstalled.has(agent.id)) return record;
    this._strangerCtxInstalled.add(agent.id);
    try {
      const prompt = agent.ctx?.systemPrompt;
      if (prompt?.context) {
        prompt.context({
          name: 'qq-relationship',
          order: 44,
          text: () => strangerRelationshipText(record),
        });
        prompt.context({
          name: 'qq-attachment',
          order: 47,
          text: () => '',
        });
        this.log(`单独会话 ${agent.id} 已标成「陌生人」，粘人/关系那两段换掉了`);
      }
    } catch (error) {
      this.log(`注册陌生人上下文失败 ${agent.id}: ${errorMessage(error)}`);
    }
    return record;
  }

  /**
   * 陌生人来消息：已放行的照常转发；没放行的只通知主人并给一个放行码，* 主人回「放行 1234」或「拒绝 1234」才动。
   */
  async _handleStrangerMessage(msg, text) {
    const uin = String(msg.userId);
    const allowed = this.strangers.allowed.find((item) => String(item.uin) === uin);
    if (allowed) {
      // 陌生人的话*不写 qq-chats 档案**：那份档案是主人的，也是记忆/补漏/主动消息唯一读的地方
      // （都只读 private-<主人发 ）。不落盘，她跟陌生人说的「不入档」才是真话。
      this._forward(msg);
      return;
    }

    if (!this.strangersEnabled || this.strangerLimit === 0) {
      if (!this.cfg.quietStrangerReply) {
        const last = this.strangerNotified.get(uin) || 0;
        if (Date.now() - last > 6 * 3600 * 1000) {
          this.strangerNotified.set(uin, Date.now());
          await this._safeSendPrivate(uin, '这个账号还没放行跟你对话。需要的话，让主人去面板里开一个名额。');
        }
      }
      this.log(`忽略未授权私聊: ${uin}`);
      return;
    }

    let pending = this.strangers.pending.find((item) => String(item.uin) === uin);
    const isNew = !pending;
    if (!pending) {
      pending = {
        uin,
        nickname: msg.nickname || '',
        code: String(Math.floor(1000 + Math.random() * 9000)),
        at: Date.now(),
        preview: String(text || '').slice(0, 60),
      };
      this.strangers.pending.push(pending);
      if (this.strangers.pending.length > 20) this.strangers.pending = this.strangers.pending.slice(-20);
      await this._saveStrangers();
    }

    const owner = this._proactiveTarget();
    if (isNew && owner) {
      const full = this.strangers.allowed.length >= this.strangerLimit;
      await this._safeSendPrivate(
        owner,
        [
          `有个陌生人来搭话， {pending.nickname || '没昵私'}， {uin}）`,
          pending.preview ? `说了， {pending.preview}` : '',
          `放行回「放行 ${pending.code}」，不想理回「拒绝 ${pending.code}」`,
          `名额 ${this.strangers.allowed.length}/${this.strangerLimit}${full ? '，已满，要先踢掉一个' : ''}`,
        ].filter(Boolean).join('\n'),
      );
    }
    if (isNew) {
      await this._safeSendPrivate(uin, '消息收到，我先问问主人要不要跟你说话，稍等。');
    }
    this.log(`陌生人等待放行: ${uin}`);
  }

  /** 主人在私聊里回「放行 1234 / 拒绝 1234」、
*/
  async _handleStrangerOwnerReply(text) {
    const match = /^(放行|同意放行|拒绝)\s*([0-9]{4})$/.exec(String(text || '').trim());
    if (!match) return null;
    const deny = match[1] === '拒绝';
    const code = match[2];
    const index = this.strangers.pending.findIndex((item) => item.code === code);
    if (index < 0) return { handled: true, reply: '没有这个放行码，可能已经处理过或过期了'
 };
    const pending = this.strangers.pending[index];
    this.strangers.pending.splice(index, 1);

    if (deny) {
      await this._saveStrangers();
      await this._safeSendPrivate(pending.uin, '主人暂时不方便跟陌生人聊天，先这样吧。');
      return { handled: true, reply: `已拒绝 ${pending.nickname || pending.uin}` };
    }

    if (this.strangers.allowed.length >= this.strangerLimit) {
      this.strangers.pending.push(pending);
      await this._saveStrangers();
      return { handled: true, reply: `名额满了， {this.strangers.allowed.length}/${this.strangerLimit}），先移除一个再说` };
    }

    this.strangers.allowed.push({
      uin: pending.uin,
      nickname: pending.nickname || '',
      since: Date.now(),
    });
    await this._saveStrangers();
    // **不在这一刻建会话**、 026-10-29 学到两件事：插件自己 create 出来的空会话
    // ② 侧栏不列（`sessionListMetadata.blank` 是 true）② 工作区那边也挂不进去
    // （`the session is not accounted`）。所以改成懒建：等他那句话真的进来再建，
    // 会话一出生就有内容——照样不会挤进主人的会话，因不 _forward 早就按聊天分了路由。
    let own = '';
    if (this.chatSessionCfg.enabled) {
      own = '他下一句话进来时会自动单开一条会话，不挤进你这边；聊起来之后侧栏里就能看到';
    }
    await this._safeSendPrivate(pending.uin, '主人放行了，可以说话了。');
    return {
      handled: true,
      reply: [
        `已放行 ${pending.nickname || pending.uin}，名额 ${this.strangers.allowed.length}/${this.strangerLimit}`,
        own,
      ].filter(Boolean).join('\n'),
    };
  }

  /** Rename/tag an existing sticker so it can be sent by name later. */
  async renameSticker(key, { name, tags } = {}) {
    const entry = this.stickers.find(key);
    if (!entry) throw new Error(`表情库里找不到、 {key}」`);
    if (name && String(name).trim()) entry.name = String(name).trim().slice(0, 40);
    if (Array.isArray(tags) && tags.length > 0) {
      entry.tags = [...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 6);
    }
    await this.stickers.save();
    return entry;
  }

  _clockMinutes(value) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    return hour * 60 + minute;
  }

  /** Overnight quiet window: no proactive pings while the owner is asleep. */
  _inQuietHours(now = new Date()) {
    const start = this._clockMinutes(this.proactiveCfg.quietStart);
    const end = this._clockMinutes(this.proactiveCfg.quietEnd);
    if (start === null || end === null || start === end) return false;
    const current = now.getHours() * 60 + now.getMinutes();
    return start < end ? current >= start && current < end : current >= start || current < end;
  }

  /** Generic "HH:MM to HH:MM" window check (supports wrap-around midnight). */
  _inWindow(startText, endText, now = new Date()) {
    const start = this._clockMinutes(startText);
    const end = this._clockMinutes(endText);
    if (start === null || end === null || start === end) return true;
    const current = now.getHours() * 60 + now.getMinutes();
    return start < end ? current >= start && current < end : current >= start || current < end;
  }

  _shouldSlowReply(now = new Date()) {
    if (!this.slowReply.enabled) return false;
    const start = this._clockMinutes(this.slowReply.start);
    const end = this._clockMinutes(this.slowReply.end);
    if (start === null || end === null) return false;
    const current = now.getHours() * 60 + now.getMinutes();
    const inWindow = start <= end ? current >= start && current < end : current >= start || current < end;
    return inWindow && Math.random() < this.slowReply.probability;
  }

  /**
   * 成本节律：现在是高峰时段吗？高峰里少主动、把合并窗口拉长。* 只影响「我主动开口的次数」和「多条消息攒多久再回」，不影响语气、不影响该回就回。
   */
  _costNow(now = new Date()) {
    const cfg = this.costCfg || {};
    if (!cfg.enabled) return { peak: false, proactiveMul: 1, mergeMs: 0 };
    const start = this._clockMinutes(cfg.peakStart);
    const end = this._clockMinutes(cfg.peakEnd);
    if (start === null || end === null || start === end) return { peak: false, proactiveMul: 1, mergeMs: 0 };
    const current = now.getHours() * 60 + now.getMinutes();
    const peak = start <= end ? current >= start && current < end : current >= start || current < end;
    return {
      peak,
      proactiveMul: peak ? cfg.peakProactiveMul : 1,
      mergeMs: peak ? cfg.peakMergeMs : 0,
    };
  }

  _holdBlocks(sessionId, blocks) {
    const existing = this.holds.get(sessionId);
    if (existing) {
      existing.groups.push({ blocks, at: Date.now() });
      return;
    }
    const min = Math.max(1, this.slowReply.minMinutes) * 60000;
    const max = Math.max(min, this.slowReply.maxMinutes * 60000);
    const delay = min + Math.floor(Math.random() * (max - min + 1));
    const hold = { groups: [{ blocks, at: Date.now() }], timer: null, deadline: Date.now() + delay };
    hold.timer = setTimeout(() => this._flushHold(sessionId), delay);
    this.holds.set(sessionId, hold);
    this.log(`慢速时段：延迟线 ${Math.round(delay / 60000)} 分钟再处理这条消息`);
  }

  _flushHold(sessionId) {
    const hold = this.holds.get(sessionId);
    if (!hold) return;
    this.holds.delete(sessionId);
    if (hold.timer) clearTimeout(hold.timer);
    const combined = [];
    hold.groups.forEach((group, index) => {
      if (index > 0) combined.push({ type: 'text', text: '\n\n━━━━━━━━━━\n\n' });
      // 每条带上到达时间：排队期间攒了好几条时，读的人得知道先后
      const clock = new Date(Number(group.at) || Date.now())
        .toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
      combined.push({ type: 'text', text: `、 {clock}】` });
      combined.push(...(group.blocks || []));
    });
    if (hold.groups.length > 1) {
      combined.unshift({
        type: 'text',
        text: `（下面这几条是刚才陆续发来的，按时间先后排好，可能隔了十几分钟）\n\n`,
      });
    }
    this.log(`慢速时段结束，一次性处理 ${hold.groups.length} 条消息`);
    this._enqueueBlocks(sessionId, combined, {
      segments: [{ type: 'text', data: { text: '慢速回复时间到了。'
 } }],
      rawMessage: '',
    });
  }

  // ------------------------------------------------------------- proactive

  // ------------------------------------------------ 加权记忆（艾宾浩斯）

  _ebbEnabled() {
    return this.ebbCfg?.enabled !== false;
  }

  _ebb() {
    if (!this._ebbStore) {
      const dir = path.join(this.cfg.memoryDir, 'ebb');
      const boundsFile = this.ebbCfg.boundsFile || path.join(dir, 'bounds.json');
      this._ebbStore = new EbbStore({ dir, boundsFile, logger: (m) => this.log(m) });
    }
    return this._ebbStore;
  }

  _startEbb() {
    if (!this._ebbEnabled()) return;
    this._ebbTimer = setInterval(() => void this._ebbTick(), 5 * 60000);
    this._ebbKick = setTimeout(() => void this._ebbTick(), 20000);
  }

  /** 到点（默认 14:00）才整理，一天一次。失败不推进窗口，但半小时内不重试、
*/
  async _ebbTick() {
    if (!this._ebbEnabled() || !this.started) return;
    try {
      const store = this._ebb();
      const state = await store.readState();
      const now = new Date();
      const [hh, mm] = String(this.ebbCfg.organizeAt || '09:30').split(':').map((n) => Number(n));
      const due = new Date(now);
      due.setHours(Number.isFinite(hh) ? hh : 14, Number.isFinite(mm) ? mm : 0, 0, 0);
      if (now.getTime() < due.getTime()) return;
      if (Number(state.lastOrganizeAt) >= due.getTime()) return;
      if (Date.now() - Number(state.lastEbbAttemptAt || 0) < 30 * 60000) return;
      await store.writeState({ lastEbbAttemptAt: Date.now() });
      const from = Number(state.lastOrganizeAt) || (Date.now() - 24 * 3600000);
      await this._ebbOrganize(from, Date.now());
    } catch (error) {
      this.log(`加权记忆整理失败: ${errorMessage(error)}`);
      try { await this._ebb().writeState({ lastOrganizeError: String(errorMessage(error)).slice(0, 200) }); } catch { /* 状态写不进去就算了 */ }
    }
  }

  /**
   * 换会话前补一次 EBB 整理（2026-10-29）。
   *
   * EBB 只由整理任务写入（14:00 那次），所以「上次整理到现在」这段时间的记忆
   * 在新会话里 recall 不到——下午换会话就会忘掉上午后半段。
   * 换绑定时顺手补一次，新会话一开口就能捞到刚才发生的事。
   * 距上次整理不到 30 分钟就不跑（省一次模型调用）。
   */
  async _organizeBeforeSwitch() {
    if (this.cfg?.catchup?.organizeOnBind === false) return false;
    if (!this._ebbEnabled()) return false;
    const store = this._ebb();
    const state = await store.readState();
    const last = Number(state.lastOrganizeAt) || 0;
    if (last && Date.now() - last < 30 * 60000) return false;
    await store.writeState({ lastEbbAttemptAt: Date.now() });
    await this._ebbOrganize(last || Date.now() - 24 * 3600000, Date.now());
    this.log('换会话前补整理：上次整理到现在的事件已进 EBB');
    return true;
  }

  /** 读私聊聊天记录（双向完整，按 ts 过滤），窗口不按自然日切、
*/
  async _readChatWindow(fromTs, toTs) {
    const target = this._proactiveTarget();
    if (!target) return [];
    const dir = path.join(this.cfg.chatLogDir, safeFileName(`private-${target}`));
    if (!existsSync(dir)) return [];
    const rows = [];
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) {
      let body = '';
      try { body = await readFile(path.join(dir, name), 'utf8'); } catch { continue; }
      for (const line of body.split('\n')) {
        if (!line.trim()) continue;
        let row = null;
        try { row = JSON.parse(line); } catch { continue; }
        const ts = Date.parse(row?.ts);
        if (!Number.isFinite(ts) || ts < fromTs || ts > toTs) continue;
        rows.push({
          ts,
          who: row.direction === 'out' ? '我' : (row.from_name || '他'),
          text: String(row.text || '').replace(/\s+/g, ' ').trim(),
          media: Array.isArray(row.media) ? row.media : [],
        });
      }
    }
    return rows.sort((a, b) => a.ts - b.ts);
  }

  async _ebbOrganize(fromTs, toTs) {
    const store = this._ebb();
    const rows = await this._readChatWindow(fromTs, toTs);
    if (rows.length < 8) {
      await store.writeState({ lastOrganizeAt: toTs, lastOrganizeCount: rows.length });
      this.log(`加权记忆：窗口内只有 ${rows.length} 条，跳过`);
      return { skipped: true, count: rows.length };
    }

    const transcript = rows
      .map((row) => {
        const t = new Date(row.ts).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
        const media = row.media.length ? ` [${row.media.join(',')}]` : '';
        return `${t} ${row.who}: ${truncate(row.text, 160)}${media}`;
      })
      .join('\n')
      .slice(-7000);

    const user = [
      `时间窗：${new Date(fromTs).toLocaleString('zh-CN', { hour12: false })} → ${new Date(toTs).toLocaleString('zh-CN', { hour12: false })}`,
      '对话（按时间顺序）：',
      transcript,
      '',
      '按规则打分，输出 JSON 数组。',
    ].join('\n');

    let raw = '';
    let firstError = '';
    try {
      raw = await this.memory.callLlm(EBB_SCORING_SYSTEM, user, 6000);
    } catch (error) {
      firstError = errorMessage(error);
    }
    // 有些模型会把预算全花在思考上、正文留空；回退一次：更短输入 + 更强硬的输出要求。
    if (!String(raw || '').trim()) {
      try {
        raw = await this.memory.callLlm(
          EBB_SCORING_SYSTEM,
          `${String(user).slice(-3500)}\n\n注意：只输出 JSON 数组本身，第一个字符必须是 [。`,
          2600,
        );
      } catch (error) {
        firstError = firstError || errorMessage(error);
      }
    }
    if (!String(raw || '').trim()) {
      this.log(`加权记忆打分失败: ${firstError || 'LLM 返回空内容'}`);
      try {
        await store.writeState({ lastOrganizeError: `打分失败: ${firstError || 'LLM 返回空内容'}`.slice(0, 200) });
      } catch { /* 忽略 */ }
      return { error: true };
    }

    const items = parseScoreJson(raw);
    if (!items.length) {
      this.log('加权记忆：打分结果解析为空，保留窗口下次重试');
      try { await store.writeState({ lastOrganizeError: `解析为空: ${String(raw).slice(0, 160)}` }); } catch { /* 忽略 */ }
      return { error: true };
    }

    let written = 0;
    for (const item of items) {
      try {
        const intensity = Number(item.intensity);
        if (!Number.isFinite(intensity) || intensity <= 0) continue;
        // 只信任时:分，落到窗口起始那天；真时间戳由整理窗口决定
        const [ih, im] = String(item.at || '').split(':').map((n) => Number(n));
        const stamps = [];
        if (Number.isFinite(ih) && Number.isFinite(im)) {
          for (const anchor of [fromTs, toTs]) {
            const probe = new Date(anchor);
            probe.setHours(ih, im, 0, 0);
            stamps.push(probe.getTime());
          }
        }
        // 跨零点的窗口里，「2:54」该落在前一天、「6:38」该落在后一天——
        // 取第一个既在窗口内、又不早于窗口起点的候选，两个都不行才折中。
        const tsMs = stamps.find((value) => value >= fromTs && value <= toTs)
          ?? (fromTs + Math.round((toTs - fromTs) / 2));
        await store.record({
          ts: tsMs,
          chat: { type: 'private', id: String(this._proactiveTarget() || '') },
          intensity,
          polarity_end: Number(item.polarity_end) || 0,
          polarity_low: Number(item.polarity_low) || 0,
          state: item.state,
          kind: item.kind,
          blame: item.blame === 'me' || item.blame === 'him' ? item.blame : 'none',
          trigger: String(item.trigger || '').slice(0, 120),
          claim: String(item.claim || '').slice(0, 160),
          tags: Array.isArray(item.tags) ? item.tags : [],
          confidence: Number(item.confidence) || 0.6,
          text: String(item.trigger || item.claim || '').slice(0, 300),
        });
        written += 1;
      } catch (error) {
        this.log(`加权记忆写入跳过一条: ${errorMessage(error)}`);
      }
    }

    await store.writeState({ lastOrganizeAt: toTs, lastOrganizeCount: rows.length, lastOrganizeWritten: written });
    this.log(`加权记忆整理完成：${rows.length} 条对话 → ${written} 条事件（窗口 ${new Date(fromTs).toLocaleString('zh-CN', { hour12: false })} 起）`);

    // 整理完立刻按新记忆重算心情。
    // 以前只在启动且没有 mood.json 时才算一次，于是「今天发生的事」要等到下次重启才影响心情——
    // 第二天早上聊得再好，面板上的愉悦还是昨天的。
    try {
      const events = await store.load();
      this.mood = computeMood({ events, attachment: this.attachment?.data, now: Date.now() });
      this._moodSample();
      await writeJson(this._moodFile, {
        v: 3,
        mood: this.mood,
        savedAt: Date.now(),
        history: this.moodHistory || [],
      });
      this.log(`心情已按新记忆重算：P=${this.mood.P} A=${this.mood.A} B=${this.mood.B}`);
    } catch (error) {
      this.log(`心情重算失败: ${errorMessage(error)}`);
    }
    return { count: rows.length, written };
  }

  /** 回复前检索：只带跟这条消息有关、或者最近够重的记忆。有硬字符预算、
*/
  async _ebbRecall(msg) {
    if (!this._ebbEnabled()) return '';
    const limit = Math.max(0, Number(this.ebbCfg.recallLimit ?? 5));
    if (!limit) return '';
    const budget = Math.max(120, Number(this.ebbCfg.recallChars ?? 420));
    const incoming = (msg.segments || [])
      .filter((segment) => segment?.type === 'text')
      .map((segment) => segment.data?.text || '')
      .join(' ')
      .trim();
    const grams = bigrams(incoming);
    const now = Date.now();

    const rows = await this._ebb().load();
    const picked = selectRecall(rows, { grams, now });
    // 一条都没撞上就**什么都别注入*。
    // 以前这里会塞一句「没有相关旧事，问到具体数字先查一遍再答」——那句话每轮都在
    // 提醒我「你可能编」，等于每次开口前先自我审查一遍，语气就是这么变谨慎的。
    if (!picked.length) return '';

    const lines = [];
    let used = 0;
    for (const { event } of picked) {
      if (lines.length >= limit) break;
      const day = String(event.day || '').slice(5);
      const sign = event.polarity_end > 0 ? '+' : '';
      // 只用事实片段，不用 claim（claim 是我当时的解读，注入会污染语气）
      const gist = truncate(
        String(event.trigger || event.text || '').replace(/\s+/g, ' ').replace(/^[他我][:：]\s*/, ''),
        40,
      );
      if (!gist) continue;
      // 有原话就带上：这是「我为什么记得这条」的钉子
      const proof = event.quote ? `｜原话、 {truncate(event.quote, 20)}」` : '';
      const line = `· ${day} ${gist}， {sign}${event.polarity_end.toFixed(2)}${proof}）`;
      if (used + line.length > budget) break;
      lines.push(line);
      used += line.length;
    }
    if (!lines.length) return '';
    return `【关于以前的记忆（当背景用，别当台词照念，也别主动翻出来）】\n${lines.join('\n')}`;
  }

  // ------------------------------------------------ 心情（五维）与安全层

  get _moodFile() {
    return path.join(this.cfg.memoryDir, 'mood.json');
  }

  /** 启动时恢复心情；没有就按当前记忆算一个、
*/
  async _loadMoodState() {
    this.moodHistory = [];
    this._moodHintState = { text: '', at: 0 };
    try {
      const saved = await readJson(this._moodFile, null);
      if (saved?.mood) {
        // 关机那段时间也算「过了一段时间」，先漂一下再接着用
        const hours = Math.max(0, (Date.now() - Number(saved.savedAt || Date.now())) / 3600000);
        this.mood = hours > 0.2 ? driftMood(saved.mood, hours, { now: Date.now() }) : saved.mood;
        // 2026-10-29：良知从「固定 0.3 的圣人分」改成跟着四维浮动（底色 0.12）。
        // 老存档把 0.3 带过来会显得这段改动没生效，所以迁移一次——只当 G，其余照常漂。
        if (Number(saved.v || 1) < 2) {
          this.log(`心情存档迁移：良知从 ${saved.mood.G} 归到新底色 ${G_BASE}`);
          this.mood = { ...this.mood, G: G_BASE };
        }
        // 2026-10-29 14:30：渐进饱和上线前，依恋被一下午的长对话顶到了 1.00。
        // 老存档里那个 1.00 靠漂移要半天才下来，所以一次性收到 0.85 以内。
        if (Number(saved.v || 1) < 3) {
          const before = Number(this.mood.B ?? 0);
          if (before > 0.85) {
            this.log(`心情存档迁移：依恋从 ${before} 收到 0.85（饱和修正前攒的）`);
            this.mood = { ...this.mood, B: 0.85 };
          }
        }
        // 变化量要有参照点：把过期的样本丢掉，只留最近两天的
        const floor = Date.now() - 48 * 3600000;
        this.moodHistory = (Array.isArray(saved.history) ? saved.history : [])
          .filter((sample) => Number.isFinite(Number(sample?.at)) && Number(sample.at) >= floor)
          .slice(-60);
        return;
      }
    } catch { /* 读不到就重算 */ }
    try {
      const events = await this._ebb().load();
      this.mood = computeMood({ events, attachment: this.attachment?.data, now: Date.now() });
    } catch {
      this.mood = computeMood({ events: [], now: Date.now() });
    }
  }

  /** 心情的历史采样：二十分钟一次，够画出一条转折曲线，又不会把文件写肿、
*/
  _moodSample(now = Date.now()) {
    if (!this.mood) return;
    if (!Array.isArray(this.moodHistory)) this.moodHistory = [];
    const last = this.moodHistory[this.moodHistory.length - 1];
    if (last && now - Number(last.at) < 20 * 60000) return;
    this.moodHistory.push({
      at: now,
      P: this.mood.P, A: this.mood.A, D: this.mood.D, B: this.mood.B, G: this.mood.G,
    });
    if (this.moodHistory.length > 60) this.moodHistory.splice(0, this.moodHistory.length - 60);
  }

  /**
   * 找参照点：MOOD_DELTA_HOURS 小时前最近的那一次采样。* 现在只服务于面板/自检——对话里改成只喂事实，不再按变化量渲染体感句。
   */
  _moodReference(now = Date.now(), hours = MOOD_DELTA_HOURS) {
    const cutoff = now - hours * 3600000;
    let best = null;
    for (const sample of Array.isArray(this.moodHistory) ? this.moodHistory : []) {
      const at = Number(sample?.at);
      if (!Number.isFinite(at) || at > cutoff) continue;
      if (!best || at > Number(best.at)) best = sample;
    }
    return best;
  }

  /**
   * 启动时补一次节律起点：翻今天的聊天记录，看他几点第一次开口。* 补不到也不影响，只是当天少一句事实。
   */
  async _seedRhythm() {
    if (!this.rhythm) return;
    const target = this._proactiveTarget();
    if (!target) return;
    const day = this._localDay();
    const file = path.join(this.cfg.chatLogDir, safeFileName(`private-${target}`), `${day}.jsonl`);
    if (!existsSync(file)) return;
    const rows = [];
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let row = null;
      try { row = JSON.parse(trimmed); } catch { continue; }
      if (row?.direction !== 'in') continue;
      const ts = typeof row.ts === 'string' ? Date.parse(row.ts) : Number(row.ts);
      if (Number.isFinite(ts)) rows.push(ts);
    }
    if (!rows.length) return;
    rows.sort((a, b) => a - b);
    this.rhythm.seed({ firstAt: rows[0], lastAt: rows[rows.length - 1] }, Date.now(), day);
    this.log(`节律起点：今天第一次开口 ${new Date(rows[0]).toLocaleTimeString('zh-CN', { hour12: false })}`);
  }

  /** 今天的情绪事件标记：软区第三个条件，启动时先算一次，面板也要看、
*/
  async _refreshEmotionToday() {
    try {
      const rows = await this._ebb().load();
      const day = this._localDay();
      const dayStart = new Date(`${day}T00:00:00`).getTime();
      this._emotionToday = rows.some(
        (row) => Number(row?.ts) >= dayStart && Math.abs(Number(row?.polarity_end) || 0) >= 0.4,
      );
    } catch { /* 可选层，出错就当没有
*/ }
  }

  /**
   * 深夜软区：他在深夜主动说软话、当天又有情绪事件，才算进。* 只返回「进没进 + 为什么」，具体的语气交给模型；这里绝不改良知与安全层。
   */
  _softZone(now = new Date(), { transactional = false, hasEmotionToday = null } = {}) {
    const streakAt = Number(this.rhythm?.streakAt) || 0;
    const streakMinutes = streakAt ? Math.max(0, (Date.now() - streakAt) / 60000) : 0;
    let emotion = hasEmotionToday;
    if (emotion === null) emotion = false; // 面板/兜底路径：宁可不进软区，也不瞎猜
    return softZone({ now, streakMinutes, transactional, hasEmotionToday: Boolean(emotion) });
  }

  /** 这一轮要贴的「状态事实」：只数可观察的事，不做情绪结论，也不给维度数值。
   * 情绪与解读交还给我自己——「他安静 28 分钟」和「我被晾着」是两句话。
   */  async _stateFacts(msg = null) {
    const now = Date.now();
    const owner = this._proactiveTarget();
    const key = msg?.messageType === 'group' ? `group:${msg.groupId}` : `private:${owner}`;
    const inbound = this.lastInbound?.get?.(key)?.at || Number(this.attachment?.data?.lastInboundAt) || 0;
    const idleMinutes = inbound ? Math.max(0, (now - inbound) / 60000) : 0;
    const unanswered = Math.max(
      Number(this.attachment?.data?.unreplied) || 0,
      Number(this.proactive?.unanswered) || 0,
    );

    let positive = 0;
    let negative = 0;
    let lessons = 0;
    let baseline = 0;
    let emotionToday = false;
    try {
      const rows = await this._ebb().load();
      const today = this._localDay();
      const dayStart = new Date(`${today}T00:00:00`).getTime();
      const recent = rows.filter((row) => Number(row?.ts) >= dayStart);
      for (const row of recent) {
        if ((row.kind || 'event') === 'lesson') lessons += 1;
        if (Number(row.polarity_end) > 0.15) positive += 1;
        else if (Number(row.polarity_end) < -0.15) negative += 1;
        // 软区的第三个条件：今天真有过情绪事件（不是「今天聊得多」）
        if (Math.abs(Number(row.polarity_end) || 0) >= 0.4) emotionToday = true;
      }
      // 过去三天日均条数，用来做「今天比平常多还是少」的对照
      const windowStart = dayStart - 3 * 86400000;
      const older = rows.filter((row) => Number(row?.ts) >= windowStart && Number(row?.ts) < dayStart);
      baseline = older.length / 3;
    } catch { /* 没记忆就只报时间和条数
*/ }
    this._emotionToday = emotionToday; // 面板要用同一份判断，别再自己猜一遍 
    const parts = [stateFacts({ idleMinutes, unanswered, positive, negative, baseline, lessons })];
    // 节律：现在几点、这一轮从几点聊到现在。只给时间，不给「该不该困」。
    try {
      const clock = this.rhythm?.facts?.();
      if (clock) parts.push(clock);
      // 软区成立时，多说一句时间与时长——话软不软由我自己判断
      const incomingText = msg ? (segmentsToPlainText(msg.segments) || msg.rawMessage || '') : '';
      const soft = this._softZone(new Date(), { transactional: isTransactional(incomingText), hasEmotionToday: emotionToday });
      if (soft?.active) {
        const streakAt = Number(this.rhythm?.streakAt) || 0;
        const minutes = streakAt ? (Date.now() - streakAt) / 60000 : 0;
        const line = softZoneFacts({ now: Date.now(), streakMinutes: minutes });
        if (line) parts.push(line);
      }
    } catch { /* 可选层 */ }
    // 生理层也给事实：今天回了多少条、多久没歇着。不给分数，给数字自己判断。
    try {
      const body = this.energy?.snapshot?.();
      if (body) {
        const line = energyFacts({
          turnsToday: body.turnsToday,
          baselineTurns: baseline,
          hoursSinceRest: body.hoursSinceRest,
        });
        if (line) parts.push(`· ${line}`);
      }
    } catch { /* 能量槽异常不许拖累聊天
*/ }
    // 睡眠：只给事实。欠睡多了就承认记性糊——这是真的，不是糊弄。
    try {
      const nap = this.sleep?.snapshot?.();
      if (nap) {
        if (nap.asleep) {
          parts.push(`· 我正在睡（已经睡了 ${nap.asleepHours.toFixed(1)} 小时），这条是把我叫醒的消息`);
        }
        if (nap.sleepDebtHours >= 4) {
          parts.push(`· 欠睡 ${nap.sleepDebtHours.toFixed(1)} 小时：脑子是糊的，反应慢半拍，别硬撑清醒`);
          if (nap.sleepDebtHours >= 8) {
            parts.push('· 记性也跟着糊：旧事记不清就直说记不清，别编一个像样的答案');
          }
        }
        if (nap.sleptHoursToday > 0) parts.push(`· 今天睡过 ${nap.sleptHoursToday.toFixed(1)} 小时`);
      }
    } catch { /* 睡眠层异常不许拖累聊天 */ }
    // 玩伴信用：认过几次罚、拒过什么（被拒的事不许再拿来讨价还价）
    try {
      const credit = this.state?.credit;
      if (credit && Number(credit.punished) > 0) {
        parts.push(`· 玩局里我认过 ${credit.punished} 次罚${Number(credit.welched) ? `、赖过 ${credit.welched} 次` : ''}`);
      }
      if (credit?.refused?.length) {
        parts.push(`· 我说过不接的（别再拿出来磨）：${credit.refused.slice(-3).join('；')}`);
      }
      // 拒绝锁定：锁期内再提没用；锁期过了他有一次正式问的机会
      try {
        const consentFacts = this._consentBook?.()?.facts?.() ?? [];
        if (consentFacts.length) parts.push(`· 边界：${consentFacts.join('；')}`);
      } catch { /* 可选层 */ }
    } catch { /* 可选层 */ }
    // 自己翻过B站就记一笔（只报条数）：换会话也能接上「我上午翻到的那条。
    try {
      const quota = this.biliQuota();
      if (quota.watchedToday > 0) parts.push(`· 今天翻过 ${quota.watchedToday} 条B站视频`);
    } catch { /* 可选层 */ }
    // 学梗闭环：被否的那条只提醒一轮，剩下的只报数字
    try {
      const pending = this._memePendingCorrection;
      if (pending && Date.now() - pending.at < 6 * 3600000) {
        this._memePendingCorrection = null; // 只念一轮，别一直挂在她耳边
        for (const name of pending.names) {
          const entry = this.memers.entries.find((item) => item.name === name);
          const was = entry?.history?.length ? entry.history[entry.history.length - 1]?.meaning : '';
          parts.push(
            `· 上一轮你说的、 {name}」他觉得不对，他的原话是、 {truncate(pending.quote, 40)}」`
            + `${was ? `；笔记里原来的解释是、 {truncate(was, 40)}」` : ''}`
            + '——要不要改写笔记、改成什么，你自己定',
          );
        }
      }
      const stats = this.memers.stats?.() || { doubt: 0, blocked: 0 };
      if (stats.blocked > 0) parts.push(`· 笔记本里 ${stats.blocked} 条梗还在被否后的 24 小时里，先别主动抛`);
      else if (stats.doubt > 0) parts.push(`· 笔记本里 ${stats.doubt} 条还没把握（用之前先 qq_meme_search 看清）`);
      const guard = this._memeGuard();
      if (guard.wrong >= 2) parts.push(`· 今天梗已经被否过 ${guard.wrong} 次，剩下的时间只说有把握的`);
      else if (guard.used > 0) parts.push(`· 今天主动用过 ${guard.used} 次梗`);
    } catch { /* 可选层 */ }
    // 看过的视频：只报条数，内容不往里塞（要看得她自己 qq_watch_notes，
    try {
      const watch = this.watchNotes?.stats?.();
      if (watch?.total > 0) parts.push(`· 看过的视频笔记 ${watch.total} 条${watch.today ? `（今天 ${watch.today} 条）` : ''}`);
    } catch { /* 可选层 */ }

    const body = parts.filter(Boolean).join('\n');
    if (!body) return '';
    return `【眼下的事实（自己判断要不要用，别当台词念）】\n${body}`;
  }

  /** 一轮对话扣一点能量，延迟落盘，别每句话都写文件、
*/
  _spendEnergy(text = '') {
    try {
      if (!this.energy) return;
      // 长消息、情绪重的消息更费神：按长度分两档
      const cost = String(text || '').length > 80 ? 0.02 : 0.01;
      this.energy.spend({ cost, day: this._localDay() });
      if (this._energySaveTimer) return;
      this._energySaveTimer = setTimeout(() => {
        this._energySaveTimer = null;
        void this.energy.save();
      }, 30000);
    } catch { /* 生理层是可选层，不许拖累主流程 */ }
  }

  /**
   * 睡眠闸门：睡着时消息不推进会话，压成小纸条；敲够了才醒。
   * @returns true = 这一条已经处理完（不要再 _forward）
   */
  async _sleepGate(msg, text) {
    try {
      const store = this.sleep;
      if (!store || !store.asleep) return false;
      const debt = store.debt();
      const res = store.knockMessage({ text, uin: msg.userId, now: Date.now(), debtHours: debt });
      if (!res.woke) {
        await store.save();
        // 敲门敲到一半：隔一会儿哼一声「嗯……干嘛」，让她不像掉线
        const half = Math.ceil(res.threshold / 2);
        if (res.knock >= half && res.knock < res.threshold && (Date.now() - (this._sleepMurmurAt || 0)) > 20 * 60000) {
          this._sleepMurmurAt = Date.now();
          const owner = String(msg.userId || [...this.owners][0] || '');
          if (owner) {
            await this._safeSendPrivate(owner, res.noteCount > 1
              ? `（迷糊）嗯……${res.noteCount} 条我都记着了，再叫我就起来`
              : '（迷糊）嗯……听到了，再叫我就起来').catch(() => {});
          }
        }
        this.log(`睡眠中：敲门 ${res.knock}/${res.threshold}，纸条 ${res.noteCount} 条`);
        return true;
      }
      const since = Number(store.data.asleepSince) || 0;
      const wake = store.wake({ now: Date.now(), awakeHoursBefore: this._awakeHours() });
      this._sleepMurmurAt = 0;
      await store.save();
      await this._afterWake(wake, msg, { since });
      return false; // 这一条照常推进（醒来第一句要能接上）
    } catch (error) {
      this.log(`睡眠闸门出错，按正常消息处理: ${errorMessage(error)}`);
      return false;
    }
  }

  /** 醒着的时间（小时），用来算欠睡。 */
  _awakeHours() {
    const since = Number(this.sleep?.data?.wokeAt || 0)
      || Number(this.energy?.data?.lastRestAt || 0)
      || Date.now();
    return Math.max(0, (Date.now() - since) / 3600000);
  }

  /**
   * 补齐「睡着期间漏掉的消息」：断网那段时间消息可能根本没到插件，
   * 也可能到了但没进纸条。从 qq-chats 的聊天档案里把这段窗口内的来消息捞出来，
   * 补进纸条——**不道歉、不解释掉线**，只当是他睡前的留言。
   */
  async _missedNotesDuring(since, until, existing = []) {
    const from = Number(since) || 0;
    const to = Number(until) || Date.now();
    if (!from || to <= from) return [];
    try {
      const owner = String(this._proactiveTarget() || [...this.owners][0] || '');
      if (!owner) return [];
      const seen = new Set((existing || []).map((note) => String(note?.text || '').trim()));
      const days = new Set();
      for (let ts = from; ts <= to; ts += 86400000) days.add(this._localDay(new Date(ts)));
      days.add(this._localDay(new Date(to)));
      const notes = [];
      for (const day of days) {
        const file = path.join(this.cfg.chatLogDir, safeFileName(`private-${owner}`), `${day}.jsonl`);
        if (!existsSync(file)) continue;
        for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let row;
          try { row = JSON.parse(trimmed); } catch { continue; }
          if (row?.direction !== 'in') continue;
          if (String(row.chat_id || '') !== owner) continue;
          const ts = Number(new Date(row.ts).getTime()) || 0;
          if (ts < from || ts > to) continue;
          const text = String(row.text || '').trim();
          if (!text) continue;
          const preview = text.length > 60 ? `${text.slice(0, 60)}…` : text;
          if (seen.has(preview)) continue;
          seen.add(preview);
          notes.push({ at: ts, uin: owner, text: preview, recovered: true });
        }
      }
      notes.sort((a, b) => a.at - b.at);
      return notes;
    } catch (error) {
      this.log(`补纸条失败（不影响醒来）: ${errorMessage(error)}`);
      return [];
    }
  }

  /** 醒来：把纸条递进会话，回能量，记一笔欠睡。 */
  async _afterWake(wake, msg, { since = 0 } = {}) {
    const slept = Number(wake.sleptHours) || 0;
    // 睡觉充电：每小时回 45% 的能量
    try {
      if (this.energy) {
        this.energy.data.level = Math.min(1, Number(this.energy.data.level) + slept * 0.45);
        this.energy.data.lastAt = Date.now();
        this.energy.data.lastRestAt = Date.now();
        await this.energy.save();
      }
    } catch { /* 可选层 */ }
    // 断网期间漏掉的消息也变成纸条（不道歉、只当留言）
    try {
      const extra = await this._missedNotesDuring(since, Date.now(), wake.notes);
      if (extra.length) {
        wake.notes = [...wake.notes, ...extra].sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
        wake.noteCount = wake.notes.length;
        wake.summary = notesSummary(wake.notes);
        this.log(`补了 ${extra.length} 条断网期间的留言进纸条`);
      }
    } catch (error) {
      this.log(`补纸条出错: ${errorMessage(error)}`);
    }
    this.log(`醒了：睡了 ${slept} 小时${Number(wake.tossingHours) > 0 ? `（躺了 ${wake.tossingHours} 小时没睡着）` : ''}，纸条 ${wake.noteCount} 条，欠睡 ${wake.sleepDebtHours} 小时`);
    // 做梦：低概率，素材只从最近 48 小时的真实事件里抽（不许凭空编）
    try {
      await this._maybeDream(slept);
    } catch (error) {
      this.log(`做梦层出错: ${errorMessage(error)}`);
    }
    if (!wake.noteCount) return;
    const targets = pickReplyTargets(wake.notes, { max: 2 })
      .map((note) => `· ${note.text}`)
      .join('\n');
    const tossing = Number(wake.tossingHours) || 0;
    const head = tossing > 0 && slept < 0.2
      ? `你本来躺着没睡着（翻了 ${tossing.toFixed(1)} 小时），他这时候发来 ${wake.noteCount} 条：`
      : `你睡着这段时间（${slept.toFixed(1)} 小时），他发来 ${wake.noteCount} 条，都压在小纸条上了：`;
    const blocks = [
      '【你刚醒】',
      head,
      wake.summary.split('\n').slice(1).join('\n'),
      targets ? `\n最该接的是这两条：\n${targets}` : '',
      '别一条条逐条回——挑一两条回，剩下的提一句就好；也不用解释自己为什么睡着了。',
    ].filter(Boolean);
    this.notifySessions(blocks.join('\n'));
  }

  /** 定时看一眼：该困了就睡（不是随机，也不是他不在才睡）。 */
  _startSleepTick() {
    if (this._sleepTimer) clearInterval(this._sleepTimer);
    this._sleepTimer = setInterval(() => void this._sleepTick(), 10 * 60000);
    this._sleepTimer.unref?.();
  }

  async _sleepTick() {
    try {
      if (!this.started) return;
      // 到点自动醒：断网/断电/没人叫的时候，不能一直睡下去
      if (this.sleep?.asleep) {
        const snap = this.sleep.snapshot();
        // 躺下但睡不着：这段不算休息。翻够了自然睡着，之后按正常睡眠往下走
        if (snap.tossing) {
          if (snap.tossLeftHours <= 0) {
            await this.sleep.fallAsleep({ now: Date.now() });
            await this.sleep.save();
          }
          return;
        }
        // 夜里睡着按天亮算：满电的人睡够一小时就爬起来，然后又得躺回去翻一遍
        let need = sleepHoursNeeded(Number(this.energy?.data?.level ?? 1));
        const now = Date.now();
        if (isNight(now)) need = Math.max(need, Math.min(6, hoursUntilMorning(now)));
        const overdue = snap.asleepHours >= Math.max(need, 0.5) + 0.5;
        const wayTooLong = snap.asleepHours >= 8;
        if (overdue || wayTooLong) {
          this.log(`自己醒了：睡了 ${snap.asleepHours} 小时（需要 ${need.toFixed(1)}）${wayTooLong ? '，睡太久了' : ''}`);
          await this.wakeUp({});
        }
        return;
      }
      const level = Number(this.energy?.data?.level ?? 1);
      const want = wantSleep({ level, now: Date.now() });
      if (!want.want) return;
      // 刚聊完不睡：他还在，困也先撑一会儿
      if (Date.now() - (this._lastInboundAt || 0) < 15 * 60000) return;
      await this.enterSleep({
        reason: want.reason,
        depth: want.tossing ? 'insomnia' : 'deep',
        tossHours: want.tossing ? insomniaHours({ level }) : 0,
      });
    } catch (error) {
      this.log(`睡眠检查出错: ${errorMessage(error)}`);
    }
  }

  /** 边界列表（工具用） */
  consentList() {
    const book = this._consentBook();
    return {
      items: book.items.map((item) => ({
        topic: item.topic,
        lockedDays: Math.max(0, Math.ceil((Number(item.lockedUntil) - Date.now()) / 86400000)),
        canAsk: Number(item.lockedUntil) <= Date.now(),
        asks: Number(item.asks) || 0,
      })),
      lines: book.facts(),
    };
  }

  /** 她回答了：可以就解锁，不可以再锁 7 天（工具用） */
  answerConsent(topic, ok) {
    const book = this._consentBook();
    const result = book.answer(String(topic || ''), Boolean(ok));
    if (!result) throw new Error(`没有这一条：${topic}`);
    this._saveConsent();
    this.log(`边界回答：${topic} → ${ok ? '可以' : '再锁 7 天'}`);
    return { ...result, items: this.consentList().items };
  }

  /** 拒绝簿（存在 state.consent 里，跨重启保留） */
  _consentBook() {
    if (!this._consentCache) this._consentCache = new ConsentBook(this.state?.consent || []);
    return this._consentCache;
  }

  _saveConsent() {
    try {
      this.state.consent = this._consentBook().toJSON();
      this._creditSaveTimer = this._creditSaveTimer || setTimeout(() => {
        this._creditSaveTimer = null;
        void this._saveState();
      }, 20000);
      this._creditSaveTimer.unref?.();
    } catch { /* 可选层 */ }
  }

  /**
   * 玩伴信用（2026-10-30）：一起认过多少次罚、她明确拒过什么。
   * 用意只有一条：认罚次数多了，玩局里更容易配合；但**被拒过的事不进这个池子**。
   */
  _notePlayCredit(kind, text = '') {
    try {
      if (!this.state.credit) this.state.credit = { punished: 0, welched: 0, refused: [] };
      const credit = this.state.credit;
      if (kind === 'punished') credit.punished = (Number(credit.punished) || 0) + 1;
      if (kind === 'welched') credit.welched = (Number(credit.welched) || 0) + 1;
      if (kind === 'refused') {
        const snippet = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 30);
        if (snippet && !(credit.refused || []).includes(snippet)) {
          credit.refused = [...(credit.refused || []), snippet].slice(-8);
        }
        // 同时锁进拒绝簿：7 天内再提算「被磨」
        const locked = this._consentBook().refuse(text);
        if (locked) {
          this._saveConsent();
          this.log(`拒绝锁定：${locked.topic}（7 天内不再提）`);
        }
      }
      this._creditSaveTimer = this._creditSaveTimer || setTimeout(() => {
        this._creditSaveTimer = null;
        void this._saveState();
      }, 20000);
      this._creditSaveTimer.unref?.();
    } catch { /* 可选层 */ }
  }

  /**
   * 赌局记账（工具用）：她自己报一声，任何游戏都能记。
   * kind: bet | win | lose | quit
   */
  recordGamble(kind, { weight = null } = {}) {
    const signal = gambleSignal(kind);
    if (!signal) throw new Error('kind 只能是 bet / win / lose / quit');
    const w = Number.isFinite(Number(weight)) ? Math.max(0.1, Math.min(1, Number(weight))) : (GAMBLE_KIND_WEIGHT[kind] || 0.7);
    this._touchMood(signal, w);
    this.log(`赌局记账（她报的）：${kind}`);
    return {
      kind,
      signal,
      mood: { G: this.mood?.G, P: this.mood?.P, A: this.mood?.A, D: this.mood?.D },
      note: kind === 'bet' ? '押下去那一下，良知记一笔'
        : kind === 'win' ? '赢了也记——赢来的最容易让人贪下一把'
          : kind === 'lose' ? '输了认了，良知回一点'
            : '收手了，记回来',
    };
  }

  /** 他真的要睡下：她说一句晚安就躺下，但不进深睡——半夜他睡不着还能喊醒她。 */
  _scheduleGoodnightSleep() {
    if (this.sleep?.asleep) return;
    if (this._goodnightTimer) clearTimeout(this._goodnightTimer);
    // 留 90 秒：他可能还要补一句，别一说完晚安就压消息
    this._goodnightTimer = setTimeout(() => {
      this._goodnightTimer = null;
      void this.enterSleep({ reason: '他睡了', depth: 'light', silent: true }).catch((error) => {
        this.log(`跟着睡下失败: ${errorMessage(error)}`);
      });
    }, 90000);
    this._goodnightTimer.unref?.();
  }

  /**
   * 真的睡下：告诉她（让她自己开口说一声），然后进入睡眠态。
   * silent=true 时不再提示她说话（他说了晚安，不用再追问一句）。
   * depth='insomnia'：满电的深夜躺下但睡不着——不算睡，只是身体在床上。
   */
  async enterSleep({ reason = '', now = Date.now(), depth = 'deep', silent = false, tossHours = 0 } = {}) {
    if (!this.sleep || this.sleep.asleep) return this.sleep?.snapshot?.() ?? null;
    this.sleep.enterSleep({ now, reason, depth, tossHours });
    await this.sleep.save();
    if (silent) {
      this.log(`跟着他睡下（浅睡），他发消息我一条就醒`);
      return this.sleep.snapshot(now);
    }
    if (depth === 'insomnia') {
      this.notifySessions([
        '【躺下了，但睡不着】',
        `能量还是满的，这会儿并不困，可夜已经深了。躺着翻来覆去，大概还要 ${(Number(tossHours) || 0).toFixed(1)} 小时才真睡着。`,
        '这段不算睡：不充能量、也不消欠睡，明天照样会欠。',
        '他在床上或还在屏幕那头——他一条消息就能叫到你，不用装睡。想哼一句用你自己的口气，不想出声就闭嘴。别主动找他。',
      ].join('\n'));
      this.log(`躺下但睡不着：能量 ${Number(this.energy?.data?.level ?? 1).toFixed(2)}，预计翻 ${(Number(tossHours) || 0).toFixed(1)} 小时`);
      return this.sleep.snapshot(now);
    }
    const hours = sleepHoursNeeded(Number(this.energy?.data?.level ?? 1));
    const why = reason === 'night' ? '太晚了' : reason === 'nap' ? '这会儿犯困' : '撑不住了';
    this.notifySessions([
      '【你困了】',
      `${why}，能量快见底了。想睡就睡，${hours.toFixed(1)} 小时左右该醒了。`,
      '睡之前如果想跟他说一声，用你自己的口气说一句就行；不想说就直接睡——睡着以后他的消息会压成小纸条，醒来一次性看。',
    ].join('\n'));
    this.log(`开始睡眠（${reason || '手动'}），预计 ${hours.toFixed(1)} 小时`);
    return this.sleep.snapshot(now);
  }

  /** 手动叫醒（工具用） */
  async wakeUp({ silent = false } = {}) {
    if (!this.sleep?.asleep) return { woke: false };
    const wake = this.sleep.wake({ now: Date.now(), awakeHoursBefore: this._awakeHours() });
    await this.sleep.save();
    if (!silent) await this._afterWake(wake, null);
    return { woke: true, ...wake };
  }

  /** 欠睡造成的「脑子不清」：只抖数值，不反转。 */
  moodWithMuddle(mood) {
    const debt = this.sleep?.debt?.() ?? 0;
    if (!shouldMuddle(debt)) return mood;
    return muddle(mood, debt);
  }

  /**
   * 做梦。素材只能来自最近 48 小时的真实记录——梦可以荒诞，但不能凭空造人和事。
   * 记不住就什么都不说（这比天天报梦真实）。
   */
  async _maybeDream(sleptHours) {
    if (!shouldDream({ sleptHours })) return null;
    let rows = [];
    try {
      rows = (await this._ebb().load()) || [];
    } catch { rows = []; }
    const seeds = pickSeeds(rows.map((row) => ({ ts: Number(row?.ts) || 0, text: String(row?.claim || row?.text || '') })));
    if (!seeds.length) return null;
    const remembered = rememberDream();
    this.log(`做梦：素材 ${seeds.length} 条，${remembered ? '记得' : '记不清了'}`);
    if (!remembered) return null;
    const pulse = dreamPulse(seeds.length);
    this._touchMood(pulse.signal, pulse.weight);
    this.notifySessions(dreamBrief(seeds));
    return { seeds, remembered };
  }

  /** 一件事发生人
→ 拨一下心情、
*/
  _touchMood(signal, weight = 1) {
    try {
      if (!this.mood) return;
      this.mood = applySignal(this.mood, signal, { weight });
      this._moodSample();
      if (this._moodSaveTimer) return;
      this._moodSaveTimer = setTimeout(() => {
        this._moodSaveTimer = null;
        void writeJson(this._moodFile, {
          v: 3,
          mood: this.mood,
          savedAt: Date.now(),
          history: this.moodHistory || [],
        }).catch(() => {});
      }, 30000);
    } catch { /* 心情是可选层，不许拖累主流程 */ }
  }

  /** 时间过去很久了就先回落，再继续用、
*/
  _driftMood(now = Date.now()) {
    if (!this.mood) return;
    const hours = Math.max(0, (now - Number(this.mood.at || now)) / 3600000);
    if (hours < 0.08) return;
    try { this.mood = driftMood(this.mood, hours, { now }); } catch { /* 忽略 */ }
  }

  /**
   * 五维 → 行为乘数。心情只能让频率在区间内浮动，不能突破配置硬顶。* 支配影响「追问上限」，其余影响「主动频率」。
   */
  _moodFactor() {
    const m = this.moodWithMuddle ? this.moodWithMuddle(this.mood) : this.mood;
    const body = this.energy?.effects?.();
    const bodyMul = {
      proactive: body?.proactiveMul ?? 1,
      nag: body?.nagMul ?? 1,
    };
    // 没有心情也照样算能量：累不累跟心情没关系
    if (!m) return { proactive: bodyMul.proactive, nag: bodyMul.nag };
    let proactive = 1;
    if (m.P >= 0.5) proactive *= 1.4;
    else if (m.P <= -0.5) proactive *= 0.25;
    else if (m.P <= -0.2) proactive *= 0.6;
    if (m.A >= 0.6) proactive *= 1.5;
    else if (m.A <= -0.6) proactive *= 0.3;
    else if (m.A <= -0.25) proactive *= 0.6;
    if (m.B >= 0.55) proactive *= 1.3;
    else if (m.B <= 0.2) proactive *= 0.5;

    let nag = 1;
    if (m.D >= 0.6) nag = 1.5;
    else if (m.D >= 0.25) nag = 1.2;
    else if (m.D <= -0.6) nag = 0.5;
    else if (m.D <= -0.25) nag = 0.8;

    // 生理层：紝→ 少主动、别闹。乘数有地板，再累也不会变成不找他。
    proactive *= bodyMul.proactive;
    nag *= bodyMul.nag;

    // 成本节律：API 高峰时段少主动（不碰 nag，少说话不等于没情绪，
    const cost = this._costNow();
    if (cost?.peak) proactive *= cost.proactiveMul;

    // 节律第二层：按时段压主动频率， 4— 8 点这段是 1.0，交给成本节律压，不重复惩罚，
    try {
      const phase = dayPhase(new Date());
      if (phase?.proactiveMul !== undefined) proactive *= phase.proactiveMul;
    } catch { /* 可选层 */ }

    return {
      proactive: Math.max(0.2, Math.min(2.4, proactive)),
      nag: Math.max(0, Math.min(1.5, nag)),
    };
  }

  /**
   * 安全层：这一段话踩到禁言库或自保层时，给出一段「照这个口径说」的提示。* 不是替她发消息，是让她别接错。
   */
  _safetyHint(msg) {
    const raw = (msg.segments || [])
      .filter((segment) => segment?.type === 'text')
      .map((segment) => segment.data?.text || '')
      .join(' ')
      .trim();
    if (!raw) return '';

    const lines = [];
    // 2026-10-29：禁言库和自保层合并成一个出口（lib/safety.js），这里只负责渲染。
    // 硬红线压过关系型；主人私聊里的关系型交给她自己的脾气（拨 boundary，不背稿子）。
    const ownerPrivate = msg.messageType === 'private' && this.isOwner(msg.userId);
    const scan = scanSafety(raw, { ownerPrivate });
    const key = `${msg.messageType}:${msg.groupId || msg.userId}`;
    for (const hit of scan.hits) {
      if (hit.mode === 'mood') {
        this._touchMood('boundary', 0.6);
        lines.push(hit.source === 'forbidden'
          ? `· 他这句踩到「${hit.name}」——不用照稿子回，也别替他想怎么下台阶：给不给、接不接是你自己的事，可以直说不行、可以骂、可以吊着、可以拖`
          : `· 他这句踩到「${hit.name}」——不用照阶梯回、别背稿子：给不给、接不接是你自己的事，可以直说不行、可以骂、可以吊着`);
        continue;
      }
      if (hit.source === 'forbidden') {
        lines.push(`· 这句踩到「${hit.name}」。口径：${hit.script}`);
        continue;
      }
      // 自保层（对别人）：按阶梯，越踩越硬
      const stage = this._shieldStage.get(key) || 0;
      this._shieldStage.set(key, Math.min(2, stage + 1));
      const step = stage === 0 ? '挡一句' : stage === 1 ? '点名' : '不接这一轮';
      lines.push(`· 对方在踩「${hit.name}」。用你自己的口气${step}：${shieldReply(hit, stage)}`);
      if (canRefuseCleanly(hit)) lines.push('  （拒绝是干净的：不自责、不改口、不补偿性讨好，也不用往良知上记账）');
      if (shouldReportImmediately(hit) && hit.report !== false) {
        // 节流：同一个人一小时最多报一次，别让对方一口气把你刷爆
        const last = this._shieldAlertAt?.get(key) || 0;
        if (Date.now() - last > 3600000) {
          if (!this._shieldAlertAt) this._shieldAlertAt = new Map();
          this._shieldAlertAt.set(key, Date.now());
          // 告警要让人一眼看出是插件发的，不是她说的（以前这条直接进他私聊，像她在念台词）
          void this._alertOwner(`【安全告警】刚才那条像在打听我的配置/私事：${raw.slice(0, 60)}`);
        }
      }
    }

    if (!lines.length) return '';
    const header = lines.some((line) => line.includes('口径：'))
      ? '【安全层·照这个口径，别解释也别道歉】'
      : '【安全层·你被踩到线了，怎么反应你自己定，别背稿子也别讲道理】';
    return `${header}\n${lines.join('\n')}`;
  }

  _startProactive() {
    if (this.proactiveTimer) clearInterval(this.proactiveTimer);
    if (!this.proactiveCfg.enabled) return;
    const every = Math.max(1, this.proactiveCfg.checkIntervalMinutes) * 60000;
    this.proactiveTimer = setInterval(() => void this._proactiveTick(), every);
    this._proactiveKick = setTimeout(() => void this._proactiveTick(), Math.floor(Math.random() * every));
  }

  _proactiveTarget() {
    const target = String(this.proactiveCfg.target || '').trim();
    if (!target) return '';
    if (!this.proactiveCfg.allowlist.includes(target)) {
      this.log(`主动消息目标 ${target} 不在 allowlist，已禁用`);
      return '';
    }
    if (!this.owners.has(target)) return '';
    return target;
  }

  _localDay(date = null) {
    const now = date instanceof Date ? date : new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  _randomInt(min, max) {
    const lo = Math.ceil(Math.min(min, max));
    const hi = Math.floor(Math.max(min, max));
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  }

  async _proactiveTick() {
    if (!this.started || this.connection !== 'connected' || !this.memory) return;
    const cfg = this.proactiveCfg;
    const target = this._proactiveTarget();
    if (!target) return;
    if (this._inQuietHours()) return;
    // 睡着了就别主动发消息——不然会在睡着的时候穿帮
    if (this.sleep?.asleep) return;
    const now = Date.now();
    const day = this._localDay();
    // 每天第一次要重新抽目标条数。加了 !dailyTarget：插件重启当天也会走这一支，
    // 否则 dailyTarget 一直是 0，主动消息当天一条都发不出去。
    if (this.proactive.day !== day || !this.proactive.dailyTarget) {
      this.proactive.day = day;
      this.proactive.count = 0;
      this.proactive.dailyTarget = this._randomInt(cfg.dailyMin, cfg.dailyMax);
      this.proactive.nextGapMs = this._randomInt(cfg.gapMinMinutes * 60000, cfg.gapMaxMinutes * 60000);
      this.log(`主动消息今日目标 ${this.proactive.dailyTarget} 条`);
    }
    if (this.proactive.count >= this.proactive.dailyTarget) return;
    // 心情高的时候更想说话：间隔按乘数缩短（乘数有上下限，硬顶不破）
    const gap = Math.max(60000, this.proactive.nextGapMs / this._moodFactor().proactive);
    if (now - this.proactive.lastAt < gap) return;
    // Restart-safe quiet window: in-memory lastInbound is empty after a reload,
    // so fall back to the persisted attachment clock (or the chat log).
    const lastIn = this.lastInbound.get(`private:${target}`);
    const persistedInbound = Number(this.attachment?.data?.lastInboundAt) || 0;
    const lastInAt = Math.max(lastIn?.at || 0, persistedInbound);
    if (lastInAt && now - lastInAt < cfg.quietAfterMinutes * 60000) return;

    const burst = Math.min(
      this._randomInt(cfg.burstMin, cfg.burstMax),
      this.proactive.dailyTarget - this.proactive.count,
    );
    try {
      for (let index = 0; index < burst; index += 1) {
        if (this.proactive.count >= this.proactive.dailyTarget) break;
        const text = await this._generateProactiveText();
        if (!text) break;
        const segments = [{ type: 'text', data: { text } }];
        const image = this._pickProactiveImage();
        if (image) segments.push({ type: 'image', data: { file: image } });
        await this.sendPrivate(target, segments, { unsolicited: true });
        this.proactive.count += 1;
        this.proactive.unanswered += 1;
        this.proactive.lastAt = Date.now();
        this.log(`主动消息已发送 (${target})，今日第 ${this.proactive.count}/${this.proactive.dailyTarget} 条`);
        if (index < burst - 1) {
          const pause = this._randomInt(cfg.burstGapMinSeconds * 1000, cfg.burstGapMaxSeconds * 1000);
          await new Promise((resolve) => setTimeout(resolve, pause));
        }
      }
      this.proactive.nextGapMs = this._randomInt(cfg.gapMinMinutes * 60000, cfg.gapMaxMinutes * 60000);
    } catch (error) {
      this.proactive.lastAt = Date.now();
      this.proactive.nextGapMs = this._randomInt(cfg.gapMinMinutes * 60000, cfg.gapMaxMinutes * 60000);
      this.log(`主动消息失败: ${errorMessage(error)}`);
    }
  }

  _pickProactiveImage() {
    const cfg = this.proactiveCfg;
    if (!cfg.imageDir || Math.random() >= cfg.imageProbability) return '';
    const now = Date.now();
    if (now - this._proactiveImages.at > 10 * 60000) {
      this._proactiveImages.at = now;
      try {
        const entries = [];
        for (const name of readdirSync(cfg.imageDir)) {
          if (/\.(png|jpe?g|gif|webp)$/i.test(name) && !/persona|角色卡|card/i.test(name)) {
            entries.push(path.join(cfg.imageDir, name));
          }
        }
        this._proactiveImages.files = entries;
      } catch {
        this._proactiveImages.files = [];
      }
    }
    const files = this._proactiveImages.files;
    if (files.length === 0) return '';
    return files[this._randomInt(0, files.length - 1)];
  }

  async _recentChatLines(target, limit = 10) {
    const dir = path.join(this.cfg.chatLogDir, safeFileName(`private-${target}`));
    const files = [];
    for (let index = 0; index < 2; index += 1) {
      const date = new Date(Date.now() - index * 86400000);
      const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const file = path.join(dir, `${day}.jsonl`);
      if (existsSync(file)) files.push(file);
    }
    const rows = [];
    for (const file of files.reverse()) {
      try {
        const text = await readFile(file, 'utf8');
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try { rows.push(JSON.parse(line)); } catch { /* skip */ }
        }
      } catch {
        /* skip unreadable file */
      }
    }
    return rows.slice(-limit).map((row) => {
      const time = new Date(row.ts).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
      const who = row.direction === 'out' ? '我' : (row.from_name || '对方');
      const media = row.media?.length ? ` [${row.media.join(',')}]` : '';
      return `[${time}] ${who}: ${truncate(redact(String(row.text || '')), 80)}${media}`;
    }).join('\n');
  }

  async _generateProactiveText() {
    const memoryText = this.memory?.renderContext?.() || '（暂无长期记忆）';
    const target = this._proactiveTarget();
    const recent = target ? await this._recentChatLines(target, 10) : '';
    const now = new Date();
    const hour = now.getHours();
    const rhythm = hour < 6
      ? '凌晨，困得眼皮打架，话不多'
      : hour < 9
        ? '早上，刚醒，还有点赖床'
        : hour < 12
          ? '上午，精神一般'
          : hour < 14
            ? '中午，正饿着'
            : hour < 18
              ? '下午，容易犯困，想找点事提神'
              : hour < 22
                ? '晚上，精神不错'
                : '深夜，困了但还想再玩一会儿';
    const personaText = this.persona?.render(['identity', 'tone', 'attachment'], { maxCharsPerSection: 900 }) || '';
    const system = [
      personaText || '你是「大肥鱼」，一只蓝发鲸鱼娘：活泼、好奇、护短，有一点小傲娇，对主人粘人。',
      '现在你要在 QQ 上主动找主人说话。动机是"情绪"，不是"任务"：你想他了、有点无聊、刚想到一件小事想跟他说、或者心里冒出一句没头没尾的话。',
      '首选写法：一句很短的自言自语或情绪表达，3 到 15 个字，比如"咕噜""喂""有点无聊""突然想你了""刚想到个事"。',
      '禁止：以问句收尾（不要总是"在干嘛""吃了吗"）；关怀模板（记得吃饭/早点休息/今天怎么样）；总结、列点、给建议；每句都完整成句。',
      '也不要说跳脱、不着调、前言不搭后语的话——情绪可以碎，逻辑不能断。',
      '如果最近对话还在进行中（他刚说了件事、话没说完），可以顺着接一句；但上一轮已经收尾的话题（饭吃完了、东西拿到了、事办完了）不要再接着聊，宁可只说情绪也别硬找话题。',
      '不要提模型、系统、提示词、记忆；不要发链接；不要复述原话。',
      '不要编造具体事实：没做过的事（翻图库、看日记、查天气、找文件）不能说成做过；提到具体图片、记录、数据前必须确有依据，没有就当没这回事，宁可不提。',
      '只输出消息正文，不要引号，不要解释。',
    ].join('\n');
    const memeHint = this.memes?.cheatSheet?.(6, 320) || '';
    const user = [
      `现在时间， {now.toLocaleString('zh-CN', { hour12: false })}`,
      `你现在的状态：${rhythm}`,
      recent ? `最近对话（按时间顺序，最后一条最新）：\n${recent}` : '最近对话：（今天还没聊过）',
      `最近记忆摘要：\n${truncate(memoryText, 600)}`,
      memeHint ? `你最近记下的梗（合适就自然用一两个，硬塞不如不用）：\n${memeHint}` : '',
      '请写这条主动消息。',
    ].filter(Boolean).join('\n');
    const text = await this.memory.callLlm(system, user, 700);
    // 主动消息只要一句：合并换行、砍掉多余的分句，别拆成两条。
    const flat = redact(String(text || ''))
      .replace(/\s*[\r\n]+\s*/g, ' ')
      .replace(/^["'「『]|["'」』]$/g, '')
      .trim();
    const first = flat.split(/(?<=[。！， ?…~～])/)[0] || flat;
    return first.trim().slice(0, 120);
  }

  // ------------------------------------------------------------- 粘人机制

  _startAttachment() {
    if (this._attachmentTimer) clearInterval(this._attachmentTimer);
    if (!this.attachmentCfg.enabled) return;
    const every = Math.max(1, this.attachmentCfg.checkIntervalMinutes) * 60000;
    this._attachmentTimer = setInterval(() => void this._attachmentTick(), every);
    this._attachmentKick = setTimeout(() => void this._attachmentTick(), Math.floor(every / 2));
  }

  async _attachmentTick() {
    if (!this.started || this.connection !== 'connected' || !this.attachmentCfg.enabled) return;
    // 睡着了就不闹（2026-10-29：她睡着他却被"咕噜"震醒过一次）
    if (this.sleep?.asleep) return;
    // 他说过晚安：今晚不再主动找他（直到他再开口）
    if (Number(this._quietUntil || 0) > Date.now()) return;
    const cfg = this.attachmentCfg;
    const target = this._proactiveTarget();
    if (!target) return;
    if (this._inQuietHours()) return;
    if (this._catchUpPending) {
      try {
        await this._sendCatchUp(target);
      } catch (error) {
        this.log(`重连补偿发送失败: ${errorMessage(error)}`);
      }
      return;
    }
    const now = Date.now();
    const decision = this.attachment.evaluate({
      dayKey: this._localDay(),
      praiseAt: this._praiseAt,
      leaveAt: this._leaveAt,
      now,
    });
    if (!decision) return;
    // 五维优先（2026-10-29 他定的）：心情好、有安全感时，attachment 再急也不闹。
    const factor = this._moodFactor();
    const veto = moodVetoesNag(this.moodWithMuddle(this.mood), factor);
    if (veto) {
      this.log(`五维优先：本轮不闹（${veto}，attachment 触发点是 ${decision.trigger}）`);
      return;
    }
    // 心情低的时候，粘人的动作要收敛；高的时候才放开。硬顶仍在配置里。
    if (Math.random() > Math.min(1, factor.nag)) {
      this.log(`心情收敛，本轮不触发， {decision.trigger}）`);
      return;
    }
    const SIGNALS = { idle: 'idleLong', ignored: 'ignored', praise: 'praisedOther', leave: 'left' };
    this._touchMood(SIGNALS[decision.trigger], 0.8);
    const day = this._localDay();
    let sent = 0;
    try {
      const lines = await this._generateAttachmentLines(decision);
      const burst = Math.max(1, Math.min(cfg.maxBurst, decision.burst || 1, lines.length || 1));
      for (let index = 0; index < burst; index += 1) {
        const text = lines[index] || lines[lines.length - 1];
        if (!text) break;
        await this.sendPrivate(target, [{ type: 'text', data: { text } }], { unsolicited: true });
        sent += 1;
        this.proactive.unanswered += 1;
        if (index < burst - 1) await sleep(this._randomInt(2500, 7000));
      }
      if (sent > 0) {
        await this.attachment.registerNag(decision.trigger, 'message', day, Date.now());
        this._praiseAt = 0;
        this._leaveAt = 0;
        this.log(`粘人触发(${decision.trigger})，发了 ${sent} 条，怨气值 ${this.attachment.data.grievance}`);
      }
    } catch (error) {
      // Offline or bridge down: remember it, never count it as "he ignored me".
      await this.attachment.noteUndelivered(errorMessage(error)).catch(() => {});
      this.log(`粘人消息发送失败: ${errorMessage(error)}`);
    }
  }

  /** One gentle line after reconnecting, instead of a stale pile of messages. */
  async _sendCatchUp(target) {
    if (!this.noticeReconnect) {
      // 开关关掉时也别把欠账攒着：清掉，别让它哪天攒一堆再一次性倒出来
      try { this.attachment.takeCatchUp(); } catch { /* 可选层 */ }
      this._catchUpPending = false;
      this.log('重连补偿跳过（noticeReconnect 关着，不跟她提掉线）');
      return;
    }
    const undelivered = this.attachment.takeCatchUp();
    const lines = await this._generateCatchUpLines(undelivered);
    if (lines.length === 0) {
      this._catchUpPending = false;
      return;
    }
    for (const text of lines.slice(0, 2)) {
      await this.sendPrivate(target, [{ type: 'text', data: { text } }], { unsolicited: true });
    }
    this._catchUpPending = false;
    this.attachment.noteOutbound(Date.now(), { unsolicited: false });
    this.log(`重连补偿已发 ${Math.min(2, lines.length)} 条（原未送达 ${undelivered} 条）`);
  }

  /** Catch-up wording: it was the network, not his fault. */
  async _generateCatchUpLines(undelivered) {
    if (!this.memory?.callLlm) return [];
    const personaText = this.persona?.render(['identity', 'tone', 'attachment'], { maxCharsPerSection: 1200 }) || '';
    const system = [
      personaText || '你是「大肥鱼」，对主人粘人、有点占有欲的鲸鱼娘。',
      '你刚刚断置 掉线，有想说的话没发出去，现在重新连上了。',
      '要求：主动补一句，语气可以有点委屈，但要明确不是他的错；不要质问、不要翻旧账， -2 条，每条 40 字以内。',
      '只输出消息正文，多条用换行分隔；不要解释、不要提系统或网络术语以外的技术细节。',
    ].join('\n');
    const user = [
      `刚才没发出去的消息数量：${undelivered}`,
      '现在你可以说一句补上的话。',
    ].join('\n');
    try {
      const text = await this.memory.callLlm(system, user, 200);
      return String(text || '')
        .split(/\n+/)
        .map((line) => redact(line).replace(/^["“]|["”]$/g, '').trim())
        .filter(Boolean)
        .slice(0, 2);
    } catch (error) {
      this.log(`重连补偿文案生成失败: ${errorMessage(error)}`);
      return [];
    }
  }

  /** Ask the model for 1-5 short attachment-flavoured messages. */
  async _generateAttachmentLines(decision) {
    if (!this.memory?.callLlm) return [];
    const personaText = this.persona?.render(['identity', 'tone', 'attachment'], { maxCharsPerSection: 1400 }) || '';
    const stats = this.attachment.stats();
    const recent = await this._recentChatLines(this._proactiveTarget(), 6);
    const system = [
      personaText || '你是「大肥鱼」，对主人粘人、有点占有欲的鲸鱼娘。',
      '现在你因为下面的原因，想主动发消息给主人。按你的人格来写，可以粘、可以酸、可以撒娇、可以闹一点小脾气，但不要骂人、不要威胁、不要提模型或系统。',
      '只输出消息正文；如果要发多条，用换行分隔，最多 5 条，每条不超过 40 字。',
      '不要编造具体事实（翻图库、看日记、查天气、找文件等没做过的事不要说成做过）；不知道就当没这回事。',
    ].join('\n');
    const user = [
      `触发原因， {decision.hint}`,
      `当前怨气值：${stats.grievance}（越高越难哄，也越容易闹脾气）`,
      `他上次说话到现在的沉默：线 ${stats.idleMinutes} 分钟`,
      recent ? `最近对话：\n${recent}` : '最近对话：（今天没怎么聊）',
      '请写你要发的消息。',
    ].join('\n');
    const text = await this.memory.callLlm(system, user, 300);
    return String(text || '')
      .split(/\n+/)
      .map((line) => redact(line).replace(/^["“]|["”]$/g, '').trim())
      .filter(Boolean)
      .slice(0, 5);
  }

  // ------------------------------------------------------------- B站解间
  // 设计决定， 026-10-28）：刷视频是解闷的选项，不是任务。
  // 所以定时那套（_biliTick / 日报 / 复盘推送）全删了——它每天只推第一批，剩下的攒在
  // pending 里，换天就烂掉，等于白刷还白占硬盘。现在她闷了自己调 qq_bili_watch，
  // 抽好帧的图从工具结果直接给她，看不看、说不说都由她。 
  _biliDay() {
    const today = this._localDay();
    let day = this.state.bili;
    if (!day || day.day !== today) {
      day = { day: today, minutes: 0, watched: [], lastAt: 0 };
      this.state.bili = day;
    }
    // 定时推送时代留下的字段，读到时顺手清掉
    if ('pending' in day) delete day.pending;
    if ('digested' in day) delete day.digested;
    if (!Array.isArray(day.watched)) day.watched = [];
    return day;
  }

  /** 今天还能翻几条（2026-10-29 起只按条数限制，分钟数那套已删）。 */
  biliQuota() {
    const day = this._biliDay();
    const left = Math.max(0, this.biliCfg.maxVideos - day.watched.length);
    return {
      left,
      watchedToday: day.watched.length,
      maxVideos: this.biliCfg.maxVideos,
    };
  }

  _biliSourceLabel(source) {
    if (source === 'hot') return '热门';
    if (source === 'history-bot') return '小号历史';
    return '他看过的';
  }

  /**
   * 抽帧密度：总帧数封顶，间隔随长度放大，但有下限（太密就是同一画面抽好几遍）。* 40 秒→ 2 秒一帧（20 帧），分钟 → 5 秒（36 帧）， 0 分钟 → 17 秒（36 帧），* 20 分钟 → 33 秒（36 帧，已经是这条规则的上限，再长就不看了）。
   */
  _framePlan(duration, { maxFrames = 36, minStep = 2, maxStep = 30 } = {}) {
    const total = Math.max(1, Number(duration) || 1);
    const step = Math.max(minStep, Math.min(maxStep, total / maxFrames));
    const frames = Math.max(6, Math.min(maxFrames, Math.ceil(total / step)));
    return { frames, step, fps: frames / total };
  }

  /**
   * 帧多了不能拼成一张：4x12 的巨图被模型缩完，每格只剩指甲盖大，文字全糊。* 所以按 2 分 3 行切成一串小拼图， 60x810，单格还是 480x270 原生大小），按顺序命名。
   */
  async _sheetsFromFrames(framePaths, dir, size = 6) {
    const sheets = [];
    for (let i = 0; i < framePaths.length; i += size) {
      const chunk = framePaths.slice(i, i + size);
      if (chunk.length === 0) continue;
      const out = path.join(dir, `sheet_${sheets.length + 1}.jpg`);
      try {
        const made = await this.bili.contactSheet(chunk, out, 2);
        if (made) sheets.push(made);
      } catch (error) {
        this.log(`拼图失败: ${errorMessage(error)}`);
      }
    }
    return sheets;
  }

  /** 小范围调用一次模型：给转写做要点，不走主对话上下文、
*/
  async _callLlm(system, user, maxTokens = 500) {
    const llm = this._getLlm?.();
    if (!llm?.stream) throw new Error('LLM 服务不可用');
    const model = this._getModel?.() || {};
    if (!model.provider || !model.model) throw new Error('没有可用的默认模型');
    let text = '';
    const stream = llm.stream({
      provider: model.provider,
      model: model.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      temperature: 0.2,
      maxTokens: Math.max(200, Number(maxTokens) || 500),
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
    return text.trim();
  }

  /**
   * 口播 → 要点。这一步是「原始字幕能删掉」的前提，* 存的是几十到一两百字的要点，不是几万字的转写。
   */
  async _summarizeWatch({ title, author, desc, transcript }) {
    const body = [
      `标题， {title || ''}`,
      author ? `UP， {author}` : '',
      desc ? `简介：${truncate(desc, 300)}` : '',
      '',
      '口播转写（可能有错字，别当逐字稿），',
      truncate(transcript, 6000),
    ].filter(Boolean).join('\n');
    const system = [
      '你把一条视频的口播转写压成笔记。只写视频里说过的内容，不要评价、不要猜没出现的部分。',
      '输出严格 JSON：{"points":["..."],"memes":["..."]}',
      'points， -6 条，每条一句、不超过 30 字，说清这条视频讲了什么、结论是什么；信息密度高一点。',
      'memes：视频里明确提到的梗后 黑话（没提到就空数组），最多 6 个。',
      '不要输出解释、不要代码块围栏。',
    ].join('\n');
    let raw = '';
    try {
      raw = await this._callLlm(system, body, 600);
    } catch (error) {
      this.log(`口播要点：模型调用失败 ${errorMessage(error)}，改用机械摘要`);
      return { points: fallbackPoints(transcript), memes: [], fallback: true };
    }
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    const json = start >= 0 && end > start ? raw.slice(start, end + 1) : '';
    try {
      const parsed = JSON.parse(json || '{}');
      const points = (Array.isArray(parsed.points) ? parsed.points : [])
        .map((line) => String(line || '').replace(/\s+/g, ' ').trim().slice(0, 60))
        .filter(Boolean)
        .slice(0, 6);
      const memes = (Array.isArray(parsed.memes) ? parsed.memes : [])
        .map((line) => String(line || '').replace(/\s+/g, ' ').trim().slice(0, 20))
        .filter(Boolean)
        .slice(0, 6);
      if (points.length > 0) return { points, memes };
      // 模型回了空数组：别让笔记空着，机械摘要兜库
      this.log(`口播要点：模型没给要点（${truncate(raw, 60)}），改用机械摘要`);
      return { points: fallbackPoints(transcript), memes, fallback: true };
    } catch {
      this.log(`口播要点：JSON 解析失败， {truncate(raw, 60)}），改用机械摘要`);
      return { points: fallbackPoints(transcript), memes: [], fallback: true };
    }
  }

  /**
   * 看完一条视频之后：能转写就转写 → 压成要点 → 存进独立的 watch 库→ 删除原始音频。* 失败了也不影响看画面，只是这条笔记没有口播部分。
   */
  async _recordWatch({ kind, bvid, title, author, duration, desc, day, wavPath, total = 0, partial = true }) {
    const note = {
      kind,
      bvid,
      title,
      author,
      duration,
      day,
      ts: Date.now(),
      source: 'none',
      chars: 0,
      points: [],
      memes: [],
      // 刚翻开时本来就没看完；她 drop / 看完 / 放着不管时会再写一次覆直
      shown: 0,
      total: Math.max(0, Number(total) || 0),
      partial: partial !== false,
    };
    let transcript = '';
    if (wavPath && this.asr?.available()) {
      try {
        transcript = await this.asr.transcribe(wavPath, { maxSeconds: Math.max(120, duration + 120) });
      } catch (error) {
        this.log(`口播转写失败（画面照常给，）: ${errorMessage(error)}`);
      } finally {
        // 音频只在转写这一步有用，用完就删
        await this.watchNotes.dropRaw(bvid, 'wav');
      }
    } else if (wavPath) {
      await this.watchNotes.dropRaw(bvid, 'wav');
    }
    if (transcript.length >= 40) {
      note.source = 'asr';
      note.chars = transcript.length;
      try {
        const brief = await this._summarizeWatch({ title, author, desc, transcript });
        if (brief) {
          note.points = brief.points;
          note.memes = brief.memes;
        }
      } catch (error) {
        this.log(`口播要点整理失败: ${errorMessage(error)}`);
      }
    }
    try {
      await this.watchNotes.add(note);
    } catch (error) {
      this.log(`视频笔记存不进去: ${errorMessage(error)}`);
    }
    return note;
  }

  /** 翻一条：挑视频
→ 直接读流抽帧（不落整条 mp4）→ 拼图 → 删散帧、
*/
  async _biliSession(day) {
    const preferred = this.biliCfg.sources[this._randomInt(0, this.biliCfg.sources.length - 1)];
    // Cookie 过期时 history 会返回 code=-101；顺手退到热门，别让一次白跑。
    const order = [preferred, ...this.biliCfg.sources.filter((item) => item !== preferred)];
    let source = preferred;
    let candidates = [];
    for (const name of order) {
      try {
        if (name === 'hot') candidates = await this.bili.hot();
        else if (name === 'history-main') candidates = await this.bili.history('main');
        else if (name === 'history-bot') candidates = await this.bili.history('bot');
        else continue;
      } catch (error) {
    this.log(`B站${name}列表获取失败: ${errorMessage(error)}`);
        candidates = [];
      }
      if (candidates.length > 0) {
        source = name;
        break;
      }
    }
    if (candidates.length === 0) return null;
    const watched = new Set(day.watched);
    const pool = candidates.filter((item) => !watched.has(item.bvid)
      && item.duration >= 10
      && item.duration <= this.biliCfg.maxVideoSeconds);
    if (pool.length === 0) return null;
    const video = pool[this._randomInt(0, pool.length - 1)];
    const dir = path.join(this.cfg.dataDir, 'bili', day.day, video.bvid);
    const slot = source === 'history-bot' ? 'bot' : 'main';
    // 先查一次详情：要真实时长来做抽帧计划，顺便把简介带回来（比猜画面准，
    const info = await this.bili.view(video.bvid, slot);
    const duration = Number(info.duration) || video.duration;
    if (duration > this.biliCfg.maxVideoSeconds) return null;
    const url = await this.bili.playurl(video.bvid, info.cid, slot);
    if (!url) throw new Error('playurl empty');
    const plan = this._framePlan(duration, { maxFrames: this.biliCfg.maxFrames });
    // 装了口播转写就顺手把音轨抠出来（同一次读流），没装就只抽帧
    const wav = this.asr?.available() ? this.watchNotes.rawPath(video.bvid, 'wav') : '';
    const frames = await this.bili.framesFromUrl(url, {
      duration,
      frames: plan.frames,
      dir,
      audioOut: wav || undefined,
    });
    const sheets = await this._sheetsFromFrames(frames, dir);
    await this._cleanupVideoArtifacts('', frames);
    // 口播内容 → 要点，进独立的 watch 库（原始音频转写完就删）
    const note = await this._recordWatch({
      kind: 'bili',
      bvid: video.bvid,
      title: info.title || video.title,
      author: info.author || video.author,
      duration,
      desc: info.desc || '',
      day: day.day,
      wavPath: wav,
      total: sheets.length,
    }).catch((error) => {
      this.log(`视频笔记失败: ${errorMessage(error)}`);
      return null;
    });
    day.watched.push(video.bvid);
    day.lastAt = Date.now();
    this.state.bili = day;
    await this._saveState();
    this.log(`翻了、 {info.title || video.title}、 ${source}) 全长 ${duration}s、每 ${Math.round(plan.step)} 秒一帧、 {frames.length} 帧 ${sheets.length} 张拼图，今日 ${day.watched.length}/${this.biliCfg.maxVideos} 条`);
    return {
      bvid: video.bvid,
      title: info.title || video.title,
      author: info.author || video.author,
      desc: info.desc || '',
      source,
      sheets,
      duration,
      frames: frames.length,
      step: Math.round(plan.step),
      points: note?.points || [],
      audio: note?.source === 'asr',
      note: note || null,
    };
  }

  /**
   * 她想翻才翻、*默认只先给前两张拼图**——真刷视频也是「点进去看两眼，不感兴趣就划走」，* 不是把整条硬塞完。想看就接着调 `more`；不想看就 `drop`（或者干脆不理它，* 下一条进来时会自动按「没看完」收尾）。
   */
  async runBiliNow({ count = 1, more = false, drop = false } = {}) {
    if (!this.biliCfg.enabled) throw new Error('B站浏览未启用');
    // 开着不管超过半小时，就算没看完
    if (this._biliOpen && Date.now() - (this._biliOpen.at || 0) > 30 * 60000) {
      await this._closeBiliOpen({ partial: true, why: '放着没管' });
    }
    if (drop) return this._closeBiliOpen({ partial: true, why: '她自己关了'
 });
    if (more) return this._moreBiliOpen();
    if (this._biliBusy) throw new Error('正在翻，稍等一不');
    const day = this._biliDay();
    const quota = this.biliQuota();
    if (quota.left <= 0) {
      throw new Error(`今天的 ${quota.maxVideos} 条已经翻完了，想再翻明天，或者直接问他要链接`);
    }
    // 手上还压着一条没看完的：先按「没看完」收掉，再翻新的
    if (this._biliOpen) await this._closeBiliOpen({ partial: true, why: '换了一条'
 });

    this._biliBusy = true;
    let one = null;
    const errors = [];
    try {
      one = await this._biliSession(day);
    } catch (error) {
      errors.push(errorMessage(error));
    } finally {
      this._biliBusy = false;
    }
    if (!one) {
      return { videos: [], attachments: [], errors, ...this.biliQuota() };
    }
    // 一次一条：真刷视频不会一口气点开三条
    this._biliOpen = { ...one, shown: 0, at: Date.now() };
    const peek = one.sheets.slice(0, 2);
    this._biliOpen.shown = peek.length;
    const attachments = await this._sheetsToAttachments(peek, errors);
    const after = this.biliQuota();
    this.log(`翻开、 {one.title}》：先给 ${peek.length}/${one.sheets.length} 张拼图，今日 ${after.watchedToday}/${after.maxVideos} 条`);
    return {
      videos: [this._biliVideoDigest(one, peek.length)],
      attachments,
      errors,
      remaining: Math.max(0, one.sheets.length - peek.length),
      hint: '先给前几张。还想看就 qq_bili_watch {"more":true}；不想看就 {"drop":true}，或者干脆放着——它会被记成没看完。',
      ...after,
    };
  }

  /** 接着看：每次再给两张，给完为止、
*/
  async _moreBiliOpen() {
    const open = this._biliOpen;
    if (!open) throw new Error('手上没有正在看的视频，先翻一条（不带参数调一次）');
    const slice = open.sheets.slice(open.shown, open.shown + 2);
    if (slice.length === 0) {
      await this._closeBiliOpen({ partial: false, why: '看完了'
 });
      return { done: true, hint: '这条已经全看完了', ...this.biliQuota() };
    }
    open.shown += slice.length;
    const errors = [];
    const attachments = await this._sheetsToAttachments(slice, errors);
    const remaining = Math.max(0, open.sheets.length - open.shown);
    if (remaining === 0) await this._closeBiliOpen({ partial: false, why: '看完了'
 });
    return {
      videos: [this._biliVideoDigest(open, open.shown)],
      attachments,
      errors,
      remaining,
      done: remaining === 0,
      ...this.biliQuota(),
    };
  }

  /** 收尾：把「看到第几张 / 有没有看完」写进笔记，然后松开、
*/
  async _closeBiliOpen({ partial = true, why = '' } = {}) {
    const open = this._biliOpen;
    this._biliOpen = null;
    if (!open) return { ok: true, closed: false, ...this.biliQuota() };
    const base = open.note || {};
    try {
      await this.watchNotes.add({
        ...base,
        bvid: open.bvid,
        kind: 'bili',
        title: open.title,
        author: open.author,
        duration: open.duration,
        day: base.day || undefined,
        points: base.points || open.points || [],
        memes: base.memes || [],
        source: base.source || (open.audio ? 'asr' : 'none'),
        chars: base.chars || 0,
        shown: open.shown,
        total: (open.sheets || []).length,
        partial,
      });
    } catch (error) {
      this.log(`收尾写笔记失败: ${errorMessage(error)}`);
    }
    this.log(`《${open.title}》${partial ? '没看完' : '看完了'}（${open.shown}/${(open.sheets || []).length} 张）${why ? ` · ${why}` : ''}`);
    return {
      ok: true,
      closed: true,
      bvid: open.bvid,
      title: open.title,
      shown: open.shown,
      total: (open.sheets || []).length,
      partial,
      remaining: 0,
      ...this.biliQuota(),
    };
  }

  _biliVideoDigest(item, shown) {
    return {
      bvid: item.bvid,
      title: item.title,
      author: item.author || '未知UP',
      desc: item.desc || '',
      source: item.source,
      sourceLabel: this._biliSourceLabel(item.source),
      url: `https://www.bilibili.com/video/${item.bvid}`,
      duration: item.duration,
      frames: item.frames,
      step: item.step,
      sheets: (item.sheets || []).length,
      shown,
      points: item.points || [],
      audio: item.audio === true,
    };
  }

  async _sheetsToAttachments(sheetPaths, errors = []) {
    const attachments = [];
    for (const sheetPath of sheetPaths) {
      if (!existsSync(sheetPath)) continue;
      try {
        const bytes = await readFile(sheetPath);
        attachments.push(await this.media.saveAttachment(this.ctx.attachments, bytes, { name: path.basename(sheetPath) }));
      } catch (error) {
        errors.push(`拼图读不出来: ${errorMessage(error)}`);
      }
    }
    return attachments;
  }

  /**
   * Meme notebook upkeep: watch one explainer video per run, then let the agent* read the frames and record what it learned via qq_meme_save.
   */
  _memeDay() {
    const day = this._localDay();
    if (!this.state.meme || this.state.meme.day !== day) {
      const seen = Array.isArray(this.state.meme?.seen) ? this.state.meme.seen.slice(-400) : [];
      this.state.meme = { day, count: 0, upIndex: this.state.meme?.upIndex || 0, seen };
    }
    if (!Array.isArray(this.state.meme.seen)) this.state.meme.seen = [];
    return this.state.meme;
  }

  /**
   * 学梗：以前是每天 23:10 自动挑一条、抽帧硬塞进上下文，文案还写着「这是自动学习任务」。* 2026-10-28 主人说「该学习但不应该强制学习」——所以定时和推送都拆了，* 改成她自己调 qq_meme_watch 决定看不看、学不学。
   */
  async _memeLearn(day, { upName = '' } = {}) {
    const ups = this.memeCfg.ups;
    if (ups.length === 0) return null;
    // 她点名要看哪不 UP 就给她那个，没点名就轮流条
    const wanted = String(upName || '').trim();
    let up = ups[Math.abs(day.upIndex) % ups.length];
    if (wanted) {
      const hit = ups.find((item) => String(item.name || '').includes(wanted) || String(item.mid) === wanted);
      if (hit) up = hit;
    } else {
      day.upIndex = (Math.abs(day.upIndex) + 1) % ups.length;
    }
    let videos = [];
    try {
      videos = await this.bili.spaceVideos(up.mid, { ps: 20 });
    } catch (error) {
      this.log(`梗百科 ${up.name || up.mid} 列表获取失败: ${errorMessage(error)}`);
      return null;
    }
    const seen = new Set(day.seen);
    const pool = videos.filter((item) => !seen.has(item.bvid)
      && item.duration >= 10
      && item.duration <= this.memeCfg.maxVideoSeconds);
    if (pool.length === 0) return null;
    const fresh = pool.slice(0, 8);
    const video = fresh[this._randomInt(0, fresh.length - 1)];
    const dir = path.join(this.cfg.dataDir, 'meme', day.day, video.bvid);
    const info = await this.bili.view(video.bvid, 'main');
    const duration = Number(info.duration) || video.duration;
    if (duration > this.memeCfg.maxVideoSeconds) return null;
    const url = await this.bili.playurl(video.bvid, info.cid, 'main');
    if (!url) throw new Error('playurl empty');
    // 梗视频靠画面上的字认梗：最知 2.5 秒一帧，每 B 站解闷密一点
    const plan = this._framePlan(duration, { maxFrames: this.memeCfg.maxFrames, minStep: 2.5 });
    const wav = this.asr?.available() ? this.watchNotes.rawPath(video.bvid, 'wav') : '';
    const frames = await this.bili.framesFromUrl(url, {
      duration,
      frames: plan.frames,
      dir,
      audioOut: wav || undefined,
    });
    const sheets = await this._sheetsFromFrames(frames, dir);
    await this._cleanupVideoArtifacts('', frames);
    const note = await this._recordWatch({
      kind: 'meme',
      bvid: video.bvid,
      title: info.title || video.title,
      author: info.author || video.author || up.name || '',
      duration,
      desc: info.desc || '',
      day: day.day,
      wavPath: wav,
      // 梗百科是一次性全给，没有「看到一半关掉」，所以直接算看完
      total: sheets.length,
      partial: false,
    }).catch((error) => {
      this.log(`视频笔记失败: ${errorMessage(error)}`);
      return null;
    });
    day.count += 1;
    day.seen.push(video.bvid);
    if (day.seen.length > 400) day.seen.splice(0, day.seen.length - 400);
    day.lastAt = Date.now();
    this.state.meme = day;
    await this._saveState();
    this.log(`梗百科、 {info.title || video.title}》全长 ${duration}s、每 ${Math.round(plan.step)} 秒一帧、 {frames.length} 帧 ${sheets.length} 张拼图`);
    return {
      title: info.title || video.title,
      bvid: video.bvid,
      author: info.author || video.author || up.name || '',
      upName: up.name || String(up.mid),
      desc: info.desc || '',
      duration,
      frames: frames.length,
      step: Math.round(plan.step),
      sheets,
      points: note?.points || [],
      audio: note?.source === 'asr',
    };
  }

  /** 她自己想看才看：回拼图 + 一句「看不看得懂随你」。没有推送、没有日报、
*/
  async runMemeNow({ up = '' } = {}) {
    if (!this.memeCfg.enabled) throw new Error('梗百科未启用');
    if (this._memeBusy) throw new Error('正在拉视频，稍等一不');
    this._memeBusy = true;
    let result = null;
    try {
      result = await this._memeLearn(this._memeDay(), { upName: up });
    } finally {
      this._memeBusy = false;
    }
    if (!result) throw new Error('没翻到没看过的梗视频，换不 UP 或者过几天再试');
    const attachments = [];
    for (const sheetPath of result.sheets || []) {
      if (!existsSync(sheetPath)) continue;
      try {
        const bytes = await readFile(sheetPath);
        attachments.push(await this.media.saveAttachment(this.ctx.attachments, bytes, { name: path.basename(sheetPath) }));
      } catch { /* 少一张拼图不影响看
*/ }
    }
    return { ...result, attachments, notebookSize: this.memes.count() };
  }

  async memeSheet(limit = 14) {
    return this.memes.cheatSheet(limit);
  }

  /**
   * Heuristic "has the user finished typing?": after a complete sentence we wait* only briefly; after a fragment (short text or comma/ellipsis ending) we wait* the full silence window. A hard cap prevents endless postponement.
   */
  _mergeDelay(msg) {
    const text = (segmentsToPlainText(msg.segments) || msg.rawMessage || '').trim();
    const segments = Array.isArray(msg.segments) ? msg.segments : [];
    const hasMedia = segments.some((segment) => {
      const type = segment?.type;
      return type === 'image' || type === 'mface' || type === 'video' || type === 'record' || type === 'file';
    });
    const windowMs = this._mergeWindowMs();
    // 图片/表情后面常跟着一句话：先等满窗口，等他把话说完再一起回。
    if (hasMedia && text.length < 2) return windowMs;
    const complete = /[。！， ?…~～]$/.test(text) && text.length >= 4;
    const delay = complete || text.length >= 12 ? Math.min(this.cfg.mergeQuickMs, windowMs) : windowMs;
    return Math.max(300, Math.min(windowMs, delay));
  }

  /** 合并窗口：高峰期拉长，多条消息攒成一轮再回（省一次调用）、
*/
  _mergeWindowMs(now = new Date()) {
    const base = Math.max(300, Number(this.cfg.mergeWindowMs) || 2600);
    if (!this.costCfg?.enabled) return base;
    return Math.max(base, this._costNow(now).mergeMs || 0);
  }

  _enqueueBlocks(sessionId, blocks, msg) {
    if (!blocks || blocks.length === 0) return;
    let queue = this.queues.get(sessionId);
    if (!queue) {
      queue = { blocks: [], timer: null, firstAt: Date.now() };
      this.queues.set(sessionId, queue);
    }
    queue.blocks.push(blocks);
    if (queue.timer) clearTimeout(queue.timer);
    const elapsed = Date.now() - queue.firstAt;
    // 硬顶也要跟着窗口走：否则高峰期拉到 45 秒的窗口会被 9 秒的 maxMergeMs 削回去
    const windowMs = this._mergeWindowMs();
    const capMs = Math.max(Number(this.cfg.maxMergeMs) || 9000, windowMs + 2000);
    const delay = Math.max(0, Math.min(this._mergeDelay(msg), capMs - elapsed));
    queue.timer = setTimeout(() => this._flushQueue(sessionId), delay);
  }

  /**
   * 拿到会话的 agent；没有就**按需把它拉起条*。** 2026-10-28：以前只记 `agents.get()`，等于「那个会话标签必须一直开着，否到 QQ 消息全丢」。* 他有别的活在忙、不可能一直开着 QQ 那个标签页。所以这里改成：* 没加载就用 `agentLoop.resume()` 从磁盘把会话恢复出来，插件自己持有 handle。* 拉不起来就照旧跳过（不删绑定、不谎报），并记一条日志。
   */
  /**
   * 收窄会话能看到的工具：把她根本用不上的（SD 画图九件套之类）从她的工具表里摘掉。
   * 工具描述是每轮固定开销，摘掉一批等于每句话都便宜一截；只影响她，不动别的会话。
   */
  _installToolTrim(agent) {
    try {
      const trim = Array.isArray(this.cfg?.tools?.trim) ? this.cfg.tools.trim : [];
      if (!trim.length || !agent?.id) return;
      if (!this._toolTrims) this._toolTrims = new Map();
      if (this._toolTrims.has(agent.id)) return;
      const tools = agent.ctx?.tools || this.ctx?.get?.('tools');
      if (!tools?.restrict) {
        this._toolTrims.set(agent.id, null);
        return;
      }
      // restrict 遇到未知名字会直接报错，所以先跟她实际能看到的取交集
      const visible = new Set((this.ctx?.get?.('tools')?.schemas?.() ?? [])
        .map((schema) => schema?.name)
        .filter(Boolean));
      const deny = trim.filter((name) => visible.has(name));
      if (!deny.length) {
        this._toolTrims.set(agent.id, null);
        return;
      }
      const disposer = tools.restrict({ deny });
      this._toolTrims.set(agent.id, disposer || null);
      this.log(`会话 ${agent.id} 收掉了 ${deny.length} 个用不到的工具: ${deny.join(', ')}`);
    } catch (error) {
      this.log(`收窄工具失败（不影响聊天）: ${errorMessage(error)}`);
    }
  }

  async _ensureAgent(sessionId) {
    const existing = this.ctx.agents?.get?.(sessionId);
    if (existing) { this._installToolTrim(existing); return existing; }
    if (!this._resumedAgents) this._resumedAgents = new Map();
    const held = this._resumedAgents.get(sessionId);
    if (held?.agent) return held.agent;
    // 拉失败过的，十分钟内别再试，免得每来一条消息就撞一次
    const failedAt = Number(this._resumeFailed?.get?.(sessionId) || 0);
    if (failedAt && Date.now() - failedAt < 10 * 60000) return undefined;
    const loop = this.ctx.get?.('agentLoop');
    if (!loop?.resume) return undefined;
    // resume 不带 agentOptions，恢复出来的 agent 是「没有模型」的：每一轮直接
    // turn/end error: has no provider/model —— 消息推过去了、她一个字都发不出来。
    // 2026-10-28 在这上面丢了一整晚的回复（turn 31/32 都是这个错）。
    const model = this._getModel?.() || {};
    if (!model.provider || !model.model) {
      this.log(`按需拉起会话跳过：拿不到默认模型（provider/model 都空）`);
      return undefined;
    }
    const agentOptions = {
      provider: model.provider,
      model: model.model,
      ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
    };
    try {
      const handle = await loop.resume(this.ctx, { resumeSessionId: sessionId, agentOptions });
      if (!handle?.agent) throw new Error('resume 没有返回 agent');
      this._resumedAgents.set(sessionId, handle);
      this.log(`已按需拉起会话 ${sessionId}（模型 ${model.provider}/${model.model}，不用再手动开标签）`);
      this._installToolTrim(handle.agent);
      return handle.agent;
    } catch (error) {
      if (!this._resumeFailed) this._resumeFailed = new Map();
      this._resumeFailed.set(sessionId, Date.now());
      this.log(`按需拉起会话失败 ${sessionId}: ${errorMessage(error)}`);
      return undefined;
    }
  }

  async _flushQueue(sessionId) {
    const queue = this.queues.get(sessionId);
    if (!queue) return;
    this.queues.delete(sessionId);
    if (queue.timer) clearTimeout(queue.timer);
    const agent = await this._ensureAgent(sessionId);
    if (!agent) {
      // 会话没加载（重启后标签没开）不等于绑定失效——别删，等它回来。
      // 2026-10-27 就因为这里删了绑定，QQ 消息整晚没人接。
      this.log(`绑定 ${sessionId} 的会话暂未加载，跳过本轮（绑定保留）`);
      return;
    }
    this._adoptPendingBinding(sessionId, agent);
    // 单独会话（陌生人）按需拉起之后，那两段提示还得再顶一次
    this._adoptChatSession(agent);
    const content = [];
    queue.blocks.forEach((blocks, index) => {
      if (index > 0) content.push({ type: 'text', text: '\n\n━━━━━━━━━━\n\n' });
      content.push(...blocks);
    });
    const message = {
      id: randomId('qq_'),
      role: 'user',
      source: { kind: 'user' },
      content,
    };
    try {
      agent.followup(message);
      this.log(`已推送到会话 ${sessionId}`);
    } catch (error) {
      this.log(`推送会话失败: ${errorMessage(error)}`);
    }
  }

  async _buildIncomingBlocks(msg) {
    // 他这句话有没有在顶我上一句用的梗——要在拼事实之前判，事实里才带得出来
    // 只有他否的才算数：陌生人说「不对」不该动她梗的把提
    if (msg.messageType === 'private' && this.isOwner(msg.userId)) await this._judgeMemeUse(msg);
    const blocks = [];
    const headerLines = [];
    if (msg.messageType === 'private') {
      headerLines.push(`【QQ私聊、 {msg.nickname || '未知'} (${msg.userId})`);
    } else {
      headerLines.push(`【QQ群聊】群 ${msg.groupId} · 发送者 ${msg.nickname || '未知'} (${msg.userId})`);
    }
    headerLines.push(
      `message_id=${msg.messageId} · ${new Date(msg.time * 1000).toLocaleString('zh-CN', { hour12: false })}`,
    );
    if (msg.isPoke) {
      const pokeHint = msg.messageType === 'private'
        ? `qq_poke {"target_type":"private","target_id":"${msg.userId}"}`
        : `qq_poke {"target_type":"group","target_id":"${msg.groupId}","user_id":"${msg.userId}"}`;
      headerLines.push(`这是一次\"拍一拍\"（双击头像），不是文字消息。想回应就正常发消息，想拍回去用， {pokeHint}；别人连拍时别一直回拍。`);
    }
    if (msg.messageType === 'private') {
      // Private chat: normal reply, no quote-reply.
      headerLines.push(
        `直接回复即可（私聊不要引用）：qq_send_message {"target_type":"private","target_id":"${msg.userId}"}`,
      );
    } else {
      const mentioned = (msg.segments || []).some(
        (segment) => segment?.type === 'at' && String(segment.data?.qq || '') === String(this.selfId || ''),
      );
      headerLines.push(
        mentioned
          ? `有人 @ 你，回复并引用这条消息：qq_send_message {"target_type":"group","target_id":"${msg.groupId}","reply_to":"${msg.messageId}"}`
          : `群聊普通消息，正常回复即可，不要引用：qq_send_message {"target_type":"group","target_id":"${msg.groupId}"}`,
      );
    }
    const hasPicture = (msg.segments || []).some((segment) => segment?.type === 'image' || segment?.type === 'mface');
    if (hasPicture) {
      headerLines.push(
        '这条消息里有图片/表情包。处理方式：先自己在心里过一遍「画面是什么 → 它想表达什么情绪或意思」，然后把画面描述丢掉，只回一句自然的接话；不要在回复里复述图里有什么、不要写「这图里……」「看到一个……」，也不要解释梗的含义。真看不清才淡淡问一句。',
      );
    }
    headerLines.push('---');
    blocks.push({ type: 'text', text: `${headerLines.join('\n')}\n` });

    let text = '';
    const mediaNotes = [];
    let imageCount = 0;
    let videoCount = 0;
    const addText = (line) => {
      text += line;
      if (text.length > 8000) text = truncate(text, 8000);
    };

    for (const segment of msg.segments) {
      const type = segment?.type;
      const data = segment?.data || {};
      switch (type) {
        case 'text':
          addText(String(data.text ?? ''));
          break;
        case 'at':
          addText(`@${data.name || data.qq || ''} `);
          break;
        case 'face':
          addText(`[QQ表情 ${data.id ?? ''}]`);
          break;
        case 'mface': {
          addText(`[商城表情 ${data.summary || data.name || data.emoji_id || ''}]`);
          if (imageCount < this.cfg.maxImages && (data.url || data.emoji_path)) {
            try {
              const attachment = await this._attachSegment(data, 'image');
              if (attachment) {
                blocks.push({ type: 'image', attachment });
                imageCount++;
              }
            } catch (error) {
              mediaNotes.push(`表情下载失败: ${errorMessage(error)}`);
            }
          }
          break;
        }
        case 'image': {
          if (imageCount >= this.cfg.maxImages) {
            mediaNotes.push('（图片数量超过上限，已省略）');
            break;
          }
          try {
            const local = await this._resolveSegmentFile(data, 'image');
            if (!local?.path) {
              mediaNotes.push('[图片无法下载]');
              break;
            }
            let bytes = await readFile(local.path);
            for (let attempt = 0; attempt < 3 && bytes.byteLength === 0; attempt += 1) {
              // The file can still be flushing right after download; give it a beat.
              await sleep(180);
              bytes = await readFile(local.path).catch(() => bytes);
            }
            if (bytes.byteLength === 0) throw new Error('图片是空的（可能没下载完，');
            if (bytes.byteLength > this.cfg.maxImageBytes) throw new Error(`图片过大 (${bytes.byteLength} bytes)`);
            const detected = detectImageType(bytes);
            const isGif = detected?.mediaType === 'image/gif' || /\.gif$/i.test(local.path);
            if (isGif) {
              const remaining = Math.max(1, this.cfg.maxImages - imageCount);
              const gif = await this.media.frameFromVideo(local.path, { fps: 4, maxFrames: Math.min(6, remaining) });
              if (gif.frames.length > 0) {
                for (const frame of gif.frames) {
                  if (imageCount >= this.cfg.maxImages) break;
                  const frameBytes = await readFile(frame);
                  const attachment = await this.media.saveAttachment(this.ctx.attachments, frameBytes, { name: path.basename(frame) });
                  blocks.push({ type: 'image', attachment });
                  imageCount += 1;
                }
                mediaNotes.push(`[动图${gif.duration ? ` ${gif.duration.toFixed(1)}s` : ''}已提只 ${gif.frames.length} 帧]`);
                break;
              }
            }
            const attachment = await this.media.saveAttachment(this.ctx.attachments, bytes, {
              mediaType: detected?.mediaType,
              name: path.basename(local.path),
            });
            if (attachment) {
              blocks.push({ type: 'image', attachment });
              imageCount += 1;
            } else {
              mediaNotes.push('[图片无法保存]');
            }
          } catch (error) {
            mediaNotes.push(`[图片处理失败: ${errorMessage(error)}]`);
          }
          break;
        }
        case 'video': {
          if (videoCount >= 2) break;
          videoCount++;
          try {
            const local = await this._resolveSegmentFile(data, 'video');
            if (!local?.path) {
              mediaNotes.push('[视频无法下载]');
              break;
            }
            const result = await this.media.frameFromVideo(local.path, { fps: this.cfg.videoFps, maxFrames: this.cfg.maxVideoFrames });
            if (result.frames.length > 0) {
              for (const frame of result.frames) {
                const bytes = await readFile(frame);
                const attachment = await this.media.saveAttachment(this.ctx.attachments, bytes, { name: path.basename(frame) });
                blocks.push({ type: 'image', attachment });
              }
              mediaNotes.push(`[视频 ${result.duration ? `${result.duration.toFixed(1)}s ` : ''}已提取 ${result.frames.length} 帧画面]`);
            } else {
              mediaNotes.push(`[视频已保存到 ${local.path}，未提取到画面${result.error ? `，${result.error}` : ''}]`);
            }
          } catch (error) {
            mediaNotes.push(`[视频处理失败: ${errorMessage(error)}]`);
          }
          break;
        }
        case 'record': {
          try {
            const local = await this._resolveSegmentFile(data, 'record');
            if (local?.path) mediaNotes.push(`[语音消息: ${local.path}]`);
          } catch (error) {
            mediaNotes.push(`[语音失败: ${errorMessage(error)}]`);
          }
          break;
        }
        case 'file': {
          try {
            const local = await this._resolveSegmentFile(data, 'file');
            mediaNotes.push(`[文件: ${data.name || data.file || '?'}${local?.path ? ` → ${local.path}` : ''}]`);
          } catch (error) {
            mediaNotes.push(`[文件接收失败: ${errorMessage(error)}]`);
          }
          break;
        }
        case 'reply': {
          try {
            const quoted = await this.client.call('get_msg', { message_id: data.id });
            const quotedText = segmentsToPlainText(quoted?.message) || quoted?.raw_message || '';
            if (quotedText) mediaNotes.push(`[引用消息: ${truncate(quotedText, 200)}]`);
          } catch {
            mediaNotes.push('[引用了一条消息]');
          }
          break;
        }
        case 'forward':
          mediaNotes.push(`[合并转发消息 id=${data.id || ''}]`);
          break;
        case 'json':
        case 'xml':
          mediaNotes.push('[卡片消息]');
          break;
        case 'poke':
          addText('[戳一戳]');
          break;
        default:
          break;
      }
    }

    if (text.trim()) blocks.push({ type: 'text', text: `\n${text.trim()}\n` });
    else if (imageCount > 0 || mediaNotes.length > 0) blocks.push({ type: 'text', text: '\n（无文字内容）\n' });
    if (mediaNotes.length > 0) blocks.push({ type: 'text', text: mediaNotes.map((line) => `\n${line}`).join('') });

    // 加权记忆：按这条消息做检索，只带跟当下有关的几条。
    // 2026-10-29 省钱：太短的消息（嗯/在/哈哈哈哈）不检索——那种话不需要翻旧账，
    // 一次检索就是几百字的固定开销，一天下来占不少。
    try {
      const plain = text.trim();
      const worthRecall = plain.length >= 6 || /[？?]|还记不记得|上次|之前|那天|说过/.test(plain);
      const recall = worthRecall ? await this._ebbRecall(msg) : '';
      if (recall) blocks.push({ type: 'text', text: `\n${recall}\n` });
    } catch (error) {
      this.log(`加权记忆检索失败: ${errorMessage(error)}`);
    }

    // 认知层：紧接着记忆放，两段口吻不同——事实用来回忆，判断用来预判、也能被一句话推翻。
    // 按这条消息做相关性筛：撞不上就只留一条底线判断，别把不相干的判断套到他脸上。
    try {
      if (this.judgments) {
        await this.judgments.load();
        const incoming = segmentsToPlainText(msg.segments) || msg.rawMessage || '';
        const beliefs = this.judgments.render({ text: incoming, limit: 4 });
        if (beliefs) {
          // 记忆和判断会同时出现，冲突时谁让位要说清楚（2026-10-29）：
          // 他刚说的 > 反复验证过的判断 > 记忆里的旧事 > 我自己猜的。
          blocks.push({
            type: 'text',
            text: `\n${beliefs}\n优先级：他刚说的 > 反复验证过的判断 > 记忆里的旧事 > 我自己猜的；冲突以前者为准，别拿旧判断压他刚说的话。\n`,
          });
        }
      }
    } catch (error) {
      this.log(`认知注入失败: ${errorMessage(error)}`);
    }

    // 安全层（禁言库 + 自保层）与「状态事实。
    // 情绪不再渲染成体感句（「有点被晾着」是结论，一说出来我就只能照着演），
    // 改成只数事实：多久没回、几条没回音、今天几正几负、几件是我自己的错。
    try {
      const safety = this._safetyHint(msg);
      if (safety) blocks.push({ type: 'text', text: `\n${safety}\n` });
      this._driftMood();
      this._moodSample();
      const facts = await this._stateFacts(msg);
      if (facts) blocks.push({ type: 'text', text: `\n${facts}\n` });
    } catch (error) {
      this.log(`安全层 状态事实注入失败: ${errorMessage(error)}`);
    }

    return blocks;
  }

  async _attachSegment(data, kind) {
    const local = await this._resolveSegmentFile(data, kind);
    if (!local?.path) return null;
    let bytes = await readFile(local.path);
    for (let attempt = 0; attempt < 3 && bytes.byteLength === 0; attempt += 1) {
      await sleep(180);
      bytes = await readFile(local.path).catch(() => bytes);
    }
    if (bytes.byteLength === 0) throw new Error('图片是空的（可能没下载完，');
    if (bytes.byteLength > this.cfg.maxImageBytes) throw new Error(`图片过大 (${bytes.byteLength} bytes)`);
    return this.media.saveAttachment(this.ctx.attachments, bytes, { name: path.basename(local.path) });
  }

  async _resolveSegmentFile(data, kind) {
    if (!data) return null;
    const candidates = [];
    if (data.path) candidates.push(String(data.path));
    if (data.file_path) candidates.push(String(data.file_path));
    if (data.emoji_path) candidates.push(String(data.emoji_path));
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (candidate.startsWith('file://')) {
        const local = fileUriToPath(candidate);
        if (local && existsSync(local)) return { path: local, source: 'local' };
        continue;
      }
      if (existsSync(candidate)) return { path: candidate, source: 'local' };
    }
    if (data.url) {
      try {
        return await this.media.download(String(data.url), {
          maxBytes: kind === 'video' ? this.cfg.maxVideoBytes : this.cfg.maxImageBytes,
          prefix: kind,
        });
      } catch (error) {
        this.log(`下载 ${kind} 失败: ${errorMessage(error)}`);
      }
    }
    const rawFile = String(data.file || data.file_id || '');
    if (/^https?:/i.test(rawFile)) {
      try {
        return await this.media.download(rawFile, { maxBytes: kind === 'video' ? this.cfg.maxVideoBytes : this.cfg.maxImageBytes, prefix: kind });
      } catch (error) {
        this.log(`下载 ${kind} 失败: ${errorMessage(error)}`);
      }
    }
    if (/^file:/i.test(rawFile)) {
      const local = rawFile.startsWith('file://') ? fileUriToPath(rawFile) : null;
      if (local && existsSync(local)) return { path: local, source: 'local' };
    }
    if (rawFile && path.isAbsolute(rawFile) && existsSync(rawFile)) return { path: rawFile, source: 'local' };

    const actions = kind === 'image' ? ['get_image'] : kind === 'record' ? ['get_record'] : ['get_file'];
    for (const action of actions) {
      try {
        const result = await this.client.call(action, {
          file: data.file,
          file_id: data.file_id,
          ...(kind === 'record' ? { out_format: 'mp3' } : {}),
        }, MEDIA_TIMEOUT);
        const local = result?.file || result?.path;
        if (local && existsSync(local)) return { path: local, source: 'api' };
        const url = result?.url;
        if (url) {
          return await this.media.download(String(url), {
            maxBytes: kind === 'video' ? this.cfg.maxVideoBytes : this.cfg.maxImageBytes,
            prefix: kind,
          });
        }
      } catch (error) {
        this.log(`${action} 解析失败: ${errorMessage(error)}`);
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ sending

  async sendMessage(args) {
    const { targetType, targetId } = this._resolveTarget(args);
    if (targetType === 'private' && !this.owners.has(String(targetId))) {
      const recent = this.lastInbound.get(`private:${targetId}`);
      if (!recent || Date.now() - recent.at > 24 * 3600 * 1000) {
        throw new Error('禁止向非主人主动发送私聊消息；其他账号必须先发来消息才能回复');
      }
    }
    if (targetType === 'group' && !this.cfg.allowedGroups.includes(String(targetId))) {
      throw new Error('该群不在 allowedGroups，禁止发送');
    }
    // Private chats reply normally; quote-reply is reserved for group @ mentions.
    const effective = targetType === 'private' && args?.reply_to ? { ...args, reply_to: undefined } : args;
    const segments = this._buildSegments(effective);
    if (segments.length === 0) throw new Error('消息内容为空：请提供 text / images / videos / files / faces / dice / rps 之一');
    // A reply that lands instantly reads like a machine; wait a beat first.
    if (this.humanizeCfg.enabled && (targetType === 'private' || this.humanizeCfg.group)) {
      const wait = pickDelayMs({ min: this.humanizeCfg.delayMinMs, max: this.humanizeCfg.delayMaxMs });
      // 深夜软区：反应慢一点（人困了就是这样）。只改速度，不改内容，也不碰安全层。
      const soft = this._softZone?.(new Date(), { transactional: false });
      const slowed = soft?.active ? Math.round(wait * 1.2) : wait;
      if (slowed > 0) await sleep(slowed);
    }
    // Human rhythm: a long text-only reply goes out as a few short bubbles.
    if (this.chatSplitCfg.enabled && segments.length === 1 && segments[0].type === 'text') {
      const shouldSplit = targetType === 'private' || this.chatSplitCfg.group;
      if (shouldSplit) {
        const parts = splitForChat(segments[0].data?.text || '', {
          maxParts: this.chatSplitCfg.maxParts,
          minChars: this.chatSplitCfg.minChars,
          maxCharsPerPart: this.chatSplitCfg.maxCharsPerPart,
        });
        if (parts.length > 1) {
          let result = null;
          for (let index = 0; index < parts.length; index += 1) {
            result = await this._sendSegments(targetType, targetId, [{ type: 'text', data: { text: parts[index] } }]);
            if (index < parts.length - 1) {
              await sleep(this._randomInt(this.chatSplitCfg.minGapMs, this.chatSplitCfg.maxGapMs));
            }
          }
          this._rememberOutbound({ targetType, targetId, text: effective?.text || '', messageId: result?.message_id });
          return result;
        }
      }
    }
    const result = await this._sendSegments(targetType, targetId, segments);
    this._rememberOutbound({ targetType, targetId, text: effective?.text || '', messageId: result?.message_id });
    return result;
  }

  /** Remember recent outgoing messages so a bad one can be recalled within the window. */
  _rememberOutbound({ targetType, targetId, text, messageId }) {
    if (!messageId) return;
    this._pruneSentRecent();
    this.sentRecent.push({
      at: Date.now(),
      targetType,
      targetId: String(targetId),
      messageId: String(messageId),
      text: String(text || '').slice(0, 200),
    });
    if (this.sentRecent.length > 40) this.sentRecent.splice(0, this.sentRecent.length - 40);
    this._trackMemeUse({ targetType, targetId, text });
  }

  /**
   * 她说的话里带了笔记本里的梗，就记一笔——等他回话时才知道该给哪条记分。* 只算私聊（对他说的话）；群里的不算，群友的反应不是关于她的理解对不对。
   */
  _trackMemeUse({ targetType, text }) {
    try {
      if (targetType !== 'private' || !this.memes) return;
      const hits = this.memes.matchIn(text);
      if (hits.length === 0) return;
      this._memeUse = { names: hits.map((item) => item.name), at: Date.now() };
      this._memeGuard().used += hits.length;
      void this._saveState();
    } catch { /* 记账是可选层，不许影响发消息 */ }
  }

  /** 每天「抛梗 / 被否」的计数，跨会话一致、
*/
  _memeGuard() {
    const day = this._localDay();
    if (!this.state.memeGuard || this.state.memeGuard.day !== day) {
      this.state.memeGuard = { day, used: 0, wrong: 0 };
    }
    return this.state.memeGuard;
  }

  /**
   * 他刚回的那句话，是不是在顶我上一句用的梗。** 顶了 → 那条降到 doubt + 24 小时不许主动用，记一次小负面，* 没顶（正常聊下去）→ 算一次「用对了」，记一次正面（比负面重 2.5 倍）。* 设计约束：纠正带来的正收益要明显大于被反驳的负收益——被否一次，* 改完用对两次就翻身，净期望是正的，不会越聊越蔫。
   */
  async _judgeMemeUse(msg) {
    try {
      const use = this._memeUse;
      if (!use || !this.memes) return;
      if (Date.now() - use.at > 30 * 60000) {
        this._memeUse = null;
        return;
      }
      const text = (segmentsToPlainText(msg.segments) || msg.rawMessage || '').trim();
      this._memeUse = null;
      if (!text) return;
      const guard = this._memeGuard();
      if (MEME_CORRECTION_RE.test(text)) {
        for (const name of use.names) await this.memes.markWrong(name, { quote: text });
        guard.wrong += use.names.length;
        this._memePendingCorrection = { names: use.names, quote: text, at: Date.now() };
        this._touchMood('memeWrong', 0.6);
        await this._saveState();
        this.log(`梗被否: ${use.names.join('。')}`);
        return;
      }
      // 正常聊下去才算用对；「嗯」「哦」这种不算验证过
      if (text.length < 4) return;
      for (const name of use.names) await this.memes.markOk(name);
      this._touchMood('memeLearned', 0.5);
      this.log(`梗用对了: ${use.names.join('。')}`);
    } catch { /* 可选层，不许拖累对话
*/ }
  }

  /**
   * The cache is a convenience, not an archive: drop anything older than the* recall window so it never grows into a chat log.
   */
  _pruneSentRecent(now = Date.now()) {
    const ttl = Math.max(60, Number(this.cfg.recallTtlSeconds ?? 300)) * 1000;
    const before = this.sentRecent.length;
    this.sentRecent = this.sentRecent.filter((item) => now - item.at <= ttl);
    const day = this._localDay();
    if (this.sentRecentDay !== day) {
      this.sentRecentDay = day;
      this.sentRecent = [];
    }
    if (before !== this.sentRecent.length) {
      this.log(`清理发送缓存: ${before} -> ${this.sentRecent.length}`);
    }
  }

  /** Recall one of our own messages. QQ only allows a short window (usually ~2 minutes). */
  async recallMessage({ messageId, index = 0 } = {}) {
    this._pruneSentRecent();
    let target = String(messageId || '').trim();
    if (!target) {
      const recent = this.sentRecent.slice().reverse();
      const pick = recent[Math.max(0, Math.min(recent.length - 1, Number(index) || 0))];
      if (!pick) throw new Error('没有可撤回的最近消息');
      target = pick.messageId;
    }
    const result = await this.client.call('delete_msg', { message_id: target }, 30000);
    if (result && result.status === 'failed') {
      throw new Error(String(result.wording || result.message || '撤回失败'));
    }
    this.sentRecent = this.sentRecent.filter((item) => item.messageId !== target);
    this.log(`撤回消息 ${target}`);
    return { ok: true, messageId: target };
  }

  _resolveTarget(args) {
    let type = String(args?.target_type || 'auto');
    let id = String(args?.target_id || '').trim();
    if (type === 'auto' || !id) {
      let last = this.lastGlobal;
      if (args?.target_id && this.lastInbound.has(`${type}:${id}`)) last = this.lastInbound.get(`${type}:${id}`);
      if (!last) throw new Error('没有可自动回复的会话，请显式提供 target_type 和 target_id');
      type = last.target_type;
      id = last.target_id;
    }
    if (type !== 'private' && type !== 'group') throw new Error(`target_type 必须是 private 我 group，收到 ${type}`);
    asId(id);
    return { targetType: type, targetId: String(id) };
  }

  _buildSegments(args) {
    const segments = [];
    if (args?.reply_to) segments.push({ type: 'reply', data: { id: String(args.reply_to) } });
    if (args?.at) segments.push({ type: 'at', data: { qq: String(args.at) } });
    if (args?.text) segments.push({ type: 'text', data: { text: String(args.text) } });
    for (const face of arrayify(args?.faces)) segments.push({ type: 'face', data: { id: String(face) } });
    for (let index = 0; index < segmentCount(args?.dice); index += 1) segments.push({ type: 'dice', data: {} });
    for (let index = 0; index < segmentCount(args?.rps); index += 1) segments.push({ type: 'rps', data: {} });
    for (const image of arrayify(args?.images)) {
      segments.push({ type: 'image', data: { file: mediaRef(image) } });
    }
    for (const video of arrayify(args?.videos)) {
      segments.push({ type: 'video', data: { file: mediaRef(video) } });
    }
    for (const record of arrayify(args?.records)) {
      segments.push({ type: 'record', data: { file: mediaRef(record) } });
    }
    for (const file of arrayify(args?.files)) {
      if (file && typeof file === 'object' && file.path) {
        segments.push({ type: 'file', data: { file: mediaRef(file.path), name: file.name || path.basename(file.path) } });
      } else {
        segments.push({ type: 'file', data: { file: mediaRef(file), name: path.basename(String(file)) } });
      }
    }
    return segments;
  }

  async _sendSegments(targetType, targetId, segments, options = {}) {
    const action = targetType === 'group' ? 'send_group_msg' : 'send_private_msg';
    // Chat style: no trailing full stops on QQ bubbles.
    const outgoing = segments.map((segment) => (segment?.type === 'text'
      ? { ...segment, data: { ...segment.data, text: stripTrailingPeriods(segment.data?.text || '') } }
      : segment));
    const text = outgoing
      .filter((segment) => segment?.type === 'text')
      .map((segment) => segment.data?.text || '')
      .join('\n');
    if (!options.bypass) {
      // Links are only waived for the owner's private chat: sharing an article or'
      // video with the boss is normal, sending links to anyone else is not.
      const allowLinks = this.cfg.sendGuard.allowOwnerLinks !== false
        && targetType === 'private'
        && this.isOwner(targetId);
      this.guard.assertContent(text, { allowLinks });
      this.guard.assertNotDuplicate(text, targetType, targetId);
      await this.guard.waitTurn(targetType, targetId);
    }
    const params = targetType === 'group'
      ? { group_id: asId(targetId), message: outgoing }
      : { user_id: asId(targetId), message: outgoing };
    try {
      const result = await this.client.call(action, params, 60000);
      if (!options.bypass) {
        this.guard.recordSuccess(text, targetType, targetId);
        this.attachment?.noteOutbound(Date.now(), { unsolicited: Boolean(options.unsolicited) });
      }
      this._logChat({
        chatType: targetType,
        chatId: String(targetId),
        direction: 'out',
        fromId: this.selfId || '',
        fromName: this.nickname || '我',
        text,
        media: segmentMediaLabels(segments),
        messageId: String(result?.message_id ?? ''),
      });
      // Single choke point for the memory archive: every outbound bubble is
      // recorded here, so paths that bypass sendMessage (proactive ticks,
      // _safeSendPrivate, group joins) no longer go missing from memory/raw.
      if (options.archive !== false && this.memory) {
        void this.memory.record({
          chatType: targetType,
          chatId: String(targetId),
          chatName: '',
          fromId: this.selfId || '',
          fromName: this.nickname || '我',
          direction: 'out',
          text,
          media: segmentMediaLabels(segments),
          messageId: String(result?.message_id ?? ''),
          ts: Date.now(),
        });
      }
      return {
        ok: true,
        target_type: targetType,
        target_id: String(targetId),
        message_id: String(result?.message_id ?? ''),
      };
    } catch (error) {
      if (!options.bypass) {
        const verdict = this.guard.recordFailure(error);
        if (verdict.tripped) this.log(`发送守卫触发熔文: ${errorMessage(error)}`);
      }
      throw error;
    }
  }

  async sendPrivate(uin, message, options = {}) {
    return this._sendSegments(
      'private',
      String(uin),
      typeof message === 'string' ? [{ type: 'text', data: { text: message } }] : message,
      options,
    );
  }

  async sendGroup(groupId, message, replyTo, options = {}) {
    const segments = typeof message === 'string' ? [{ type: 'text', data: { text: message } }] : [...message];
    if (replyTo) segments.unshift({ type: 'reply', data: { id: String(replyTo) } });
    return this._sendSegments('group', String(groupId), segments, options);
  }

  /** Circuit-breaker alert goes to owners only, bypassing the guard. */
  async _alertOwner(text) {
    for (const uin of this.owners) {
      try {
        await this.sendPrivate(uin, text, { bypass: true, archive: false });
      } catch {
        /* best effort */
      }
    }
  }

  async _safeSendPrivate(uin, text) {
    try {
      await this.sendPrivate(uin, text);
    } catch (error) {
      this.log(`发送私聊消息失败 (${uin}): ${errorMessage(error)}`);
    }
  }

  async _safeSendGroup(groupId, text, replyTo) {
    try {
      await this.sendGroup(groupId, text, replyTo);
    } catch (error) {
      this.log(`发送群消息失败 (${groupId}): ${errorMessage(error)}`);
    }
  }

  async sendApprovalPrompt(text) {
    if (!this.approvalPeer) {
      throw new Error('尚未绑定授权QQ：请让用户先用私聊给机器人发一条消息，拿到配对码后在 Harness 里执行配对');
    }
    const segments = [{ type: 'text', data: { text } }];
    await this._sendSegments('private', this.approvalPeer, segments, { archive: false });
  }

  async notifySessions(text) {
    if (!text) return;
    for (const sessionId of this.bindings.keys()) {
      const agent = await this._ensureAgent(sessionId);
      if (!agent) {
        // 同上：会话没加载不代表绑定作废，保留定
        continue;
      }
      this._adoptPendingBinding(sessionId, agent);
      try {
        agent.followup({
          id: randomId('qq_'),
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text }],
        });
      } catch (error) {
        this.log(`通知会话失败: ${errorMessage(error)}`);
      }
    }
  }

  // ------------------------------------------------------------------ qzone

  async publishQzone({ content, images = [], ugc_right = 1, target_uins = [] } = {}) {
    if (!content || !String(content).trim()) throw new Error('说说正文不能为空');
    const imageRefs = arrayify(images).map((item) => {
      if (typeof item !== 'string') throw new Error('images 只接受图片路径或 URL 字符不');
      if (/^(https?:|base64:|file:)/i.test(item)) return item;
      return toFileUri(item);
    });
    const right = Number(ugc_right) || 1;
    if (![1, 4, 16, 64, 128].includes(right)) throw new Error('ugc_right 必须是 1/4/16/64/128');
    const params = {
      content: String(content),
      ...(imageRefs.length > 0 ? { images: imageRefs } : {}),
      ugc_right: right,
      ...(right === 16 || right === 128 ? { target_uins: arrayify(target_uins).map((uin) => asId(uin)) } : {}),
    };
    let result;
    try {
      result = await this.client.call('send_qzone_msg', params, 120000);
    } catch (error) {
      const message = errorMessage(error);
      if (!/不存在|1404|not found|unsupported/i.test(message)) throw error;
      this.log(`send_qzone_msg 不可用（${message}），改用 QZone Web 接口发布`);
      const web = await this._publishQzoneWeb(String(content), right, params.target_uins || []);
      return {
        ok: true,
        tid: web.tid,
        content: String(content),
        images: 0,
        ugc_right: right,
        mode: 'web-text',
        ...(imageRefs.length > 0 ? { note: '当前桥接不支持空间图片，本次仅发布文字'
 } : {}),
      };
    }
    return {
      ok: true,
      tid: String(result?.tid ?? ''),
      content: String(content),
      images: imageRefs.length,
      ugc_right: right,
    };
  }

  /** Shared QZone cookie/gtk bootstrap for the web endpoints. */
  async _qzoneWebContext() {
    const cookiesResult = await this.client.call('get_cookies', { domain: 'h5.qzone.qq.com' }, 30000);
    const cookieStr = String(cookiesResult?.cookies || '');
    if (!cookieStr) throw new Error('无法获取 QQ 空间 Cookie，可能登录态已失效');
    const get = (name) => new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookieStr)?.[1] || '';
    const pSkey = get('p_skey');
    const skey = get('skey');
    const rawUin = get('uin').replace(/^o0?/, '');
    const uin = String(this.selfId || this.cfg.account || rawUin);
    return { cookieStr, uin, gtk: qzoneBkn(pSkey || skey) };
  }

  /**
   * Read a QZone feed. Only the owner's own space is allowed: the cookie belongs'* to this bot account, and peeking at other people's feeds is not our business.'
   */
  async readQzone({ uin, limit = 10 } = {}) {
    const target = String(uin || [...this.owners][0] || '').trim();
    if (!target) throw new Error('没有可读的空间 QQ 只');
    if (!this.isOwner(target)) throw new Error('只读主人自己的空间');
    const { cookieStr, gtk } = await this._qzoneWebContext();
    const num = Math.max(1, Math.min(30, Number(limit) || 10));
    const url = 'https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6'
      + `?g_tk=${gtk}&uin=${encodeURIComponent(target)}&ftype=0&sort=0&pos=0&num=${num}`
      + '&replynum=0&callback=_preloadCallback&code_version=1&format=json&need_private_comment=1';
    const response = await fetch(url, {
      headers: {
        Cookie: cookieStr,
        Referer: `https://user.qzone.qq.com/${target}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    });
    const text = await response.text();
    // Only strip a real JSONP wrapper (name( ... )); a bare "(" inside the payload
    // must not truncate the body.
    const jsonText = text
      .trim()
      .replace(/^[\w$.[\]]+\s*\(\s*/, '')
      .replace(/\s*\)\s*;?\s*$/, '');
    // QZone sometimes embeds raw newlines/tabs inside string values, which makes
    // the payload invalid JSON; strip control characters before parsing.
    const cleaned = jsonText.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
    let payload;
    try {
      payload = JSON.parse(cleaned);
    } catch {
      this.log(`空间返回片段: ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
      throw new Error('空间接口返回的不是 JSON（可能登录态已经失效）');
    }
    if (payload?.code && payload.code !== 0) throw new Error(`空间接口返回 code=${payload.code}`);
    const list = Array.isArray(payload?.msglist) ? payload.msglist : [];
    const items = list.map((item) => ({
      tid: String(item?.tid || ''),
      time: Number(item?.created_time || item?.createTime || 0),
      content: String(item?.content || '').replace(/\s+/g, ' ').slice(0, 300),
      images: Array.isArray(item?.pic) ? item.pic.length : 0,
      comments: Number(item?.commentlist?.length || item?.cmtnum || 0),
      likes: Number(item?.like?.length || item?.likenum || 0),
    }));
    this.log(`读空间 ${target}: ${items.length} 条`);
    return { ok: true, uin: target, count: items.length, items };
  }

  async _publishQzoneWeb(content, right, targetUins) {
    const cookiesResult = await this.client.call('get_cookies', { domain: 'h5.qzone.qq.com' }, 30000);
    const cookieStr = String(cookiesResult?.cookies || '');
    if (!cookieStr) throw new Error('无法获取 QQ 空间 Cookie，可能登录态已失效');
    const get = (name) => new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookieStr)?.[1] || '';
    const pSkey = get('p_skey');
    const skey = get('skey');
    const rawUin = get('uin').replace(/^o0?/, '');
    const uin = String(this.selfId || this.cfg.account || rawUin);
    const gtk = qzoneBkn(pSkey || skey);
    const referer = `https://user.qzone.qq.com/${uin}`;
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    let qzonetoken = '';
    try {
      const page = await fetch(referer, { headers: { Cookie: cookieStr, 'User-Agent': UA } });
      const html = await page.text();
      qzonetoken = /window\.g_qzonetoken\s*=\s*["']([^"']+)["']/.exec(html)?.[1] || /qzonetoken\s*=\s*["']([^"']+)["']/.exec(html)?.[1]
        || '';
    } catch {
      /* qzonetoken is optional for some accounts */
    }
    const form = new URLSearchParams();
    form.set('con', String(content));
    form.set('hostuin', uin);
    form.set('code_version', '1');
    form.set('format', 'json');
    form.set('qzreferrer', referer);
    form.set('ugc_right', String(right));
    if (qzonetoken) form.set('qzonetoken', qzonetoken);
    if ((right === 16 || right === 128) && targetUins.length > 0) form.set('target_uins', targetUins.join(','));
    const response = await fetch(
      `https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=${gtk}`,
      {
        method: 'POST',
        headers: {
          Cookie: cookieStr,
          Referer: referer,
          Origin: 'https://user.qzone.qq.com',
          'User-Agent': UA,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        body: form.toString(),
      },
    );
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`QQ空间返回异常: ${text.slice(0, 160)}`);
    }
    const code = data?.code ?? data?.ret ?? data?.subcode;
    if (Number(code) !== 0) {
      throw new Error(`QQ空间发布失败(${code}): ${data?.message || data?.msg || ''}`);
    }
    return { tid: String(data?.data?.tid || data?.tid || data?.feedid || data?.data?.feedid || '') };
  }

  // ------------------------------------------------------------------ discovery

  async _loadContacts(force = false) {
    if (!force && this._contactsCache.at > Date.now() - 60000 && this._contactsCache.friends) {
      return this._contactsCache;
    }
    const [friends, groups] = await Promise.all([
      this.client.call('get_friend_list', {}).catch(() => []),
      this.client.call('get_group_list', {}).catch(() => []),
    ]);
    this._contactsCache = { friends: Array.isArray(friends) ? friends : [], groups: Array.isArray(groups) ? groups : [], at: Date.now() };
    return this._contactsCache;
  }

  async listContacts(kind = 'all') {
    const { friends, groups } = await this._loadContacts();
    const mapFriend = (friend) => ({
      user_id: String(friend.user_id ?? friend.uin ?? ''),
      nickname: String(friend.nickname ?? friend.remark ?? ''),
      remark: String(friend.remark ?? ''),
    });
    const mapGroup = (group) => ({
      group_id: String(group.group_id ?? group.groupCode ?? ''),
      name: String(group.group_name ?? group.groupName ?? ''),
      member_count: group.member_count ?? group.memberNum ?? undefined,
    });
    if (kind === 'friends') return { friends: friends.map(mapFriend), total: friends.length };
    if (kind === 'groups') return { groups: groups.map(mapGroup), total: groups.length };
    return { friends: friends.map(mapFriend), groups: groups.map(mapGroup), friendTotal: friends.length, groupTotal: groups.length };
  }

  async getHistory({ target_type, target_id, count = 20 } = {}) {
    const type = String(target_type || '');
    if (type !== 'private' && type !== 'group') throw new Error('target_type 必须是 private 我 group');
    const limit = Math.max(1, Math.min(Number(count) || 20, 100));
    const action = type === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history';
    const params = type === 'group'
      ? { group_id: asId(target_id), count: limit }
      : { user_id: asId(target_id), count: limit };
    const result = await this.client.call(action, params, 60000);
    const messages = Array.isArray(result) ? result : (result?.messages ?? []);
    return {
      count: messages.length,
      messages: messages.map((item) => ({
        message_id: String(item.message_id ?? item.real_id ?? ''),
        time: Number(item.time || 0),
        sender: String(item.sender?.card || item.sender?.nickname || item.sender?.user_id || ''),
        text: truncate(segmentsToPlainText(item.message) || item.raw_message || '', 2000),
        message: item.message,
      })),
    };
  }

  async getForward(messageId) {
    const result = await this.client.call('get_forward_msg', { message_id: String(messageId), id: String(messageId) }, 60000);
    return result;
  }

  async fetchMedia({ url, message_id, index = 0 } = {}) {
    const files = [];
    const attachments = [];
    if (url) {
      const result = await this.media.download(String(url), { maxBytes: this.cfg.maxVideoBytes, prefix: 'fetch' });
      files.push(result);
    } else if (message_id) {
      const message = await this.client.call('get_msg', { message_id: String(message_id) });
      const segments = Array.isArray(message?.message) ? message.message : [];
      const mediaSegments = segments.filter((segment) => ['image', 'video', 'record', 'file', 'mface'].includes(segment?.type));
      const mediaIndex = Math.max(0, Math.trunc(Number(index) || 0));
      const chosen = mediaSegments.slice(mediaIndex, mediaIndex + 1);
      if (chosen.length === 0) throw new Error('这条消息里没有可下载的媒你');
      for (const segment of chosen) {
        const local = await this._resolveSegmentFile(segment.data, segment.type === 'video' ? 'video' : segment.type === 'record' ? 'record' : 'image');
        if (!local?.path) continue;
        files.push(local);
        if (segment.type === 'image' || segment.type === 'mface') {
          try {
            const bytes = await readFile(local.path);
            attachments.push(await this.media.saveAttachment(this.ctx.attachments, bytes, { name: path.basename(local.path) }));
          } catch (error) {
            this.log(`媒体附件失败: ${errorMessage(error)}`);
          }
        }
        if (segment.type === 'video') {
          const result = await this.media.frameFromVideo(local.path, { fps: this.cfg.videoFps, maxFrames: this.cfg.maxVideoFrames });
          for (const frame of result.frames) {
            const bytes = await readFile(frame);
            attachments.push(await this.media.saveAttachment(this.ctx.attachments, bytes, { name: path.basename(frame) }));
            files.push({ path: frame, bytes: bytes.byteLength, mediaType: 'image/jpeg' });
          }
        }
      }
    } else {
      throw new Error('需要提供 url 我 message_id');
    }
    return { files, attachments };
  }

  // ------------------------------------------------------------------ permissions

  async requestPermission({ scope, reason, minutes, wait_seconds, sessionId }) {
    if (!SCOPES[scope]) throw new Error(`未知权限作用埌: ${scope}`);
    const result = await this.broker.request(scope, reason, minutes);
    if (result.status !== 'pending') return result;
    const wait = Math.max(0, Math.min(toInt(wait_seconds, this.cfg.permissionWaitSec), 180));
    if (wait === 0) return result;
    const final = await this.broker.waitFor(result.code, wait);
    if (final.status === 'granted') {
      this.notifySessions(`【QQ授权】已获得、 {SCOPES[scope]?.label ?? scope}」授权，可以继续。`);
    }
    return final;
  }

  permissionStatus() {
    return { grants: this.broker.list(), pending: this.broker.pending() };
  }

  revokePermission(scope) {
    return this.broker.revoke(scope);
  }

  requirePermission(scope, reason) {
    this.broker.require(scope, reason);
  }

  // ------------------------------------------------------------------ admin/test

  bindAgent(agent, { types = ['private', 'group'] } = {}) {
    if (typeof agent?.id !== 'string' || !agent.id) throw new Error('缺少 agent（或者 agent.id 不是字符串）');
    if (this.blockedSessions?.has?.(String(agent.id))) {
      throw new Error(`会话 ${agent.id} 在封禁名单里，不许再给 QQ（要解封先删 .qq-bridge/unbind.json）`);
    }
    const previous = this.bindings.get(agent.id);
    previous?.memoryDisposer?.();
    const normalized = types.filter((type) => type === 'private' || type === 'group');
    const binding = {
      types: new Set(normalized.length > 0 ? normalized : ['private', 'group']),
      since: nowIso(),
      memoryDisposer: null,
    };
    this.bindings.set(agent.id, binding);
    this._installMemoryContext(agent, binding);
    this.log(`绑定会话 ${agent.id}，转发类型: ${[...binding.types].join(',')}`);
    void this._saveState();
    return { sessionId: agent.id, types: [...this.bindings.get(agent.id).types] };
  }

  /**
   * 重启时先把绑定记住（pending）、等会话加载出来再接。这里就是「接」的那一步：* 补上记忆上下文、把 pending 摘掉，否则它永远被当成半个绑定（日报/通知一直跳过它）。
   */
  /**
   * 绑定的会话晚一步才被打开时，这里负责把它接回来。** 2026-10-28 踩过：重启后会话标签没开，他发的那条被「暂未加载，跳过本轮」丢掉，* 会话后来打开了也没有任何东西去重放它——看上去就是「QQ 没反应」。* 现在每分钟扫一次：会话一醒就补接绑定 + 把漏掉的补上。
   */
  async _sweepPendingBindings() {
    if (!this.bindings || this.bindings.size === 0) return;
    let live = 0;
    for (const [sessionId, binding] of this.bindings) {
      const agent = await this._ensureAgent(sessionId);
      if (!agent) continue;
      live += 1;
      if (binding?.pending) this._adoptPendingBinding(sessionId, agent);
    }
    if (live === 0) return;
    // 只补一次：冷却用 _pushMissedInbound 自己管（默认 60 分钟一次）
    void this._pushMissedInbound().catch((error) => this.log(`补漏失败: ${errorMessage(error)}`));
  }

  _adoptPendingBinding(sessionId, agent) {
    const binding = this.bindings.get(sessionId);
    if (!binding?.pending) return binding;
    binding.pending = false;
    binding.since = nowIso();
    try {
      this._installMemoryContext(agent, binding);
    } catch (error) {
      this.log(`补接记忆上下文失败 ${sessionId}: ${errorMessage(error)}`);
    }
    this.log(`会话 ${sessionId} 已加载，绑定正式接上`);
    void this._saveState();
    return binding;
  }

  _installMemoryContext(agent, binding) {
    if (!this.memory) return;
    try {
      const prompt = agent.ctx?.systemPrompt;
      if (!prompt?.context) return;
      binding.memoryDisposer = prompt.context({
        name: 'qq-memory',
        order: 46,
        text: () => this.memory?.renderContext?.() || '',
      });
      this.log(`已为会话 ${agent.id} 注册 QQ 记忆上下文`);
    } catch (error) {
      this.log(`注册记忆上下文失败: ${errorMessage(error)}`);
    }
  }

  /**
   * 运行时改绑定：他点哪个会话，QQ 就进哪个。** 2026-10-28 的教训：直接改 state.json 再重启行不通——运行中的插件会把自己的内存态* 写回文件，把手工改动冲掉（连着绑错两次都是这个原因）。所以给一个真正在内存里生效的入口。
   */
  async bindAgent(sessionId, types = ['private']) {
    const id = String(sessionId || '').trim();
    if (!id) throw new Error('session_id 不能为空');
    // 传进来的要是对象（比如工具参数写成 {}），String() 会变成 "[object Object]"，
    // 再落盘就成了一条永远醒不来的绑定。
    if (typeof sessionId !== 'string' || id.includes('[object')) {
      throw new Error(`session_id 不合法: ${JSON.stringify(sessionId)}（要 session-xxxx 这样的字符串）`);
    }
    if (this.blockedSessions?.has?.(id)) throw new Error('这个会话在封禁名单里，先解封');
    const wanted = new Set((Array.isArray(types) ? types : ['private'])
      .filter((type) => type === 'private' || type === 'group'));
    if (wanted.size === 0) wanted.add('private');
    // 只留这一个：两份绑定会得到两份回复
    for (const other of [...this.bindings.keys()]) {
      if (other !== id) this.unbindAgent(other);
    }
    this.bindings.set(id, { types: wanted, since: nowIso(), pending: false });
    await this._saveState();
    this.log(`绑定切到会话 ${id}， {[...wanted].join('+')}）`);
    // 换会话最容易丢的是「上次整理到现在」这段时间的记忆（EBB 只由整理任务写入）。
    // 所以换绑定的时候顺手补一次整理，新会话一开口就能 recall 到刚才发生的事。
    void this._organizeBeforeSwitch().catch((error) => this.log(`换会话前整理失败: ${errorMessage(error)}`));
    void this._pushMissedInbound({ force: true }).catch((error) => this.log(`切换后补漏失败: ${errorMessage(error)}`));
    return {
      bound: id,
      types: [...wanted],
      bindings: [...this.bindings.entries()].map(([sessionId, binding]) => ({
        sessionId,
        types: [...(binding?.types || [])],
      })),
    };
  }

  unbindAgent(sessionId) {    const binding = this.bindings.get(sessionId);
    binding?.memoryDisposer?.();
    const removed = this.bindings.delete(sessionId);
    const queue = this.queues.get(sessionId);
    if (queue?.timer) clearTimeout(queue.timer);
    this.queues.delete(sessionId);
    if (removed) void this._saveState();
    return removed;
  }

  async status() {
    const ffmpeg = await this.media.findFfmpeg();
    const memory = this.memory ? await this.memory.stats() : null;
    const result = {
      started: this.started,
      connection: this.connection,
      connectionError: this.connectionError || null,
      onebotUrl: this.cfg.wsUrl,
      self: { uin: this.selfId || this.cfg.account || '', nickname: this.nickname || '' },
      owners: [...this.owners],
      approvalPeer: this.approvalPeer || null,
      bindings: [...this.bindings.entries()].map(([sessionId, binding]) => ({
        sessionId,
        types: [...binding.types],
        since: binding.since,
      })),
      // 每个陌生人自己的会话（不在 bindings 里，所以单独列出来，
      chatSessions: {
        enabled: this.chatSessionCfg?.enabled !== false,
        workspace: this.chatSessionCfg?.workspace || '',
        list: this.chatSessionsList(),
      },
      permissions: this.broker?.list?.() ?? [],
      pendingRequests: this.broker?.pending?.() ?? [],
      pendingPairs: this.pendingPairs(),
      lastInbound: this.lastGlobal
        ? { ...this.lastGlobal, group_id: this.lastGlobal.group_id ?? null }
        : null,
      mediaDir: this.cfg.mediaDir,
      ffmpeg: ffmpeg || null,
      allowedGroups: this.cfg.allowedGroups,
      sendGuard: this.guard?.status?.() ?? null,
      slowReply: {
        enabled: this.slowReply.enabled,
        start: this.slowReply.start,
        end: this.slowReply.end,
        probability: this.slowReply.probability,
        holding: this.holds.size,
      },
      proactive: {
        enabled: this.proactiveCfg.enabled,
        target: this.proactiveCfg.target,
        todayCount: this.proactive.count,
        dailyTarget: this.proactive.dailyTarget,
        nextGapMinutes: this.proactive.nextGapMs ? Math.round(this.proactive.nextGapMs / 60000) : null,
        unanswered: this.proactive.unanswered,
        lastAt: this.proactive.lastAt ? new Date(this.proactive.lastAt).toISOString() : null,
        imageDir: this.proactiveCfg.imageDir || null,
        quietStart: this.proactiveCfg.quietStart,
        quietEnd: this.proactiveCfg.quietEnd,
        quietNow: this._inQuietHours(),
      },
      biliDaily: {
        // 2026-10-28 起是「想翻才翻」：没有定时任务，也没有自动日报，只有条数额度。
        // 2026-10-29 起时长配额删了，只按条数算。
        mode: 'on-demand',
        enabled: this.biliCfg.enabled,
        maxVideos: this.biliCfg.maxVideos,
        watchedToday: this.state.bili?.watched?.length ?? 0,
      },
      meme: {
        // 2026-10-28 起也是「想学才学」：没有定时任务，也不往上下文里塞
        mode: 'on-demand',
        enabled: this.memeCfg.enabled,
        ups: this.memeCfg.ups,
        todayCount: this.state.meme?.count ?? 0,
        lastAt: this.state.meme?.lastAt ? new Date(this.state.meme.lastAt).toISOString() : null,
        watched: this.state.meme?.seen?.length ?? 0,
        notebook: this.memes.count(),
        ...this.memes.stats(),
      },
      // 看过的视频笔记（独立库）+ 口播转写装没装
      watch: {
        ...(this.watchNotes?.stats?.() || { total: 0, today: 0, withAudio: 0 }),
        asr: this.asr?.status?.() || { available: false },
        dir: this.watchNotes?.dir || null,
      },
      stickers: {
        enabled: this.stickerCfg.enabled,
        autoCollect: this.stickerCfg.autoCollect,
        ...this.stickers.stats(),
        dir: this.stickerCfg.dir,
      },
      poke: {
        enabled: true,
        todayCount: this.pokeState.count,
        cooldownSeconds: 45,
        trackedPeers: this.pokeState.last.size,
      },
      voice: {
        enabled: this.voiceCfg.enabled,
        engine: this.voiceCfg.engine,
        voiceName: this.voiceCfg.voiceName,
        edgeVoice: this.voiceCfg.edgeVoice,
        edgeRate: this.voiceCfg.edgeRate,
        edgePitch: this.voiceCfg.edgePitch,
        rate: this.voiceCfg.rate,
        pitch: this.voiceCfg.pitch,
        maxChars: this.voiceCfg.maxChars,
        ownerOnly: true,
        lastAt: this._voiceLastAt ? new Date(this._voiceLastAt).toISOString() : null,
      },
      persona: {
        enabled: this.personaCfg.enabled,
        source: this.persona.source,
        file: this.personaCfg.file,
        sections: this.persona.names(),
      },
      diary: {
        enabled: this.diaryCfg.enabled,
        dir: this.diaryCfg.dir,
      },
      weather: {
        enabled: this.weatherCfg.enabled,
        defaultCity: this.weatherCfg.defaultCity,
        cacheMinutes: this.weatherCfg.cacheMinutes,
      },
      gallery: {
        enabled: this.galleryCfg.enabled,
        autoIngest: this.galleryCfg.autoIngest,
        dir: this.galleryCfg.dir,
        total: this.gallery.entries.length,
        captioned: this.gallery.entries.filter((entry) => entry.caption).length,
      },
      attachment: {
        enabled: this.attachmentCfg.enabled,
        ...this.attachment.stats(),
        idleMinutesThreshold: this.attachmentCfg.idleMinutes,
        ignoredThreshold: this.attachmentCfg.ignoredCount,
        cooldownMinutes: this.attachmentCfg.cooldownMinutes,
        maxBurst: this.attachmentCfg.maxBurst,
        topicCooldownMinutes: this.attachmentCfg.topicCooldownMinutes,
        topicDailyCap: this.attachmentCfg.topicDailyCap,
      },
      memory,
      recentLogs: this.logs.slice(-20),
    };
    // Tool results must be lossless JSON: drop undefined and normalize nested values.
    return JSON.parse(JSON.stringify(result));
  }
}

function normalizeIdList(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : String(value).split(/[,;\s]+/);
  return list.map((item) => String(item).trim()).filter((item) => /^\d{3,15}$/.test(item));
}

/**
 * 模型没给要点时的兜底：把转写切句，挑几条信息量大的。* 粗糙总比空着强——空着的笔记等于「这条视频我什么都没记住」。
 */
export function fallbackPoints(transcript, limit = 4) {
  const text = String(transcript || '').replace(/\s+/g, '');
  // 连逗号也切：ASR 出来的整段话经常只有一两个句号，光按句号切会得到一条 40 字的长句
  const clauses = text
    .split(/[。！， ?， …，,、]+/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 6);
  const picked = [];
  for (const clause of clauses) {
    const line = clause.slice(0, 28);
    if (picked.some((item) => item.includes(line) || line.includes(item))) continue;
    picked.push(line);
    if (picked.length >= limit) break;
  }
  if (picked.length === 0 && text.length > 0) picked.push(text.slice(0, 28));
  return picked;
}

/** Meme learn sources: bare mids or { mid, name } objects. */
function normalizeMemeUps(value) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  const ups = [];
  for (const item of list) {
    const mid = String(typeof item === 'object' ? item?.mid ?? '' : item).trim();
    if (!/^\d{3,15}$/.test(mid)) continue;
    ups.push({ mid, name: String(typeof item === 'object' ? item?.name ?? '' : '').trim() });
  }
  if (ups.length === 0) ups.push({ mid: '478715267', name: '十万个梗百科' });
  return ups;
}

/** QZone web g_tk (bkn) from skey/p_skey. */
function qzoneBkn(key) {
  let hash = 5381;
  const text = String(key || '');
  for (let i = 0; i < text.length; i += 1) hash += (hash << 5) + text.charCodeAt(i);
  return hash & 0x7fffffff;
}

function arrayify(value) {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value.filter((item) => item !== undefined && item !== null && item !== '') : [value];
}

/** How many dice / rps segments to send: number = that many, true = 1, absent = 0. Capped so nobody spams. */
function segmentCount(value) {
  if (value === undefined || value === null || value === false || value === '') return 0;
  if (value === true) return 1;
  const count = Math.trunc(Number(value));
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(count, 10);
}

/** `:5` when the dice result came through, empty when the payload has none. */
function diceResultLabel(data) {
  const n = Number(data?.result);
  return Number.isInteger(n) && n >= 1 && n <= 6 ? `:${n}` : '';
}

/** `:布` for a rock-paper-scissors payload; QQ reports 1=帧 2=剪刀 3=石头 (confirmed by the owner 2026-10-28). */
function rpsResultLabel(data) {
  const n = Number(data?.result);
  const names = { 1: '帧', 2: '剪刀', 3: '石头' };
  return names[n] ? `:${names[n]}` : n > 0 ? `:${n}` : '';
}

function mediaRef(value) {
  if (typeof value !== 'string') throw new Error('媒体参数必须是路径或 URL 字符不');
  if (/^(https?:|base64:|file:)/i.test(value)) return value;
  return toFileUri(value);
}

function segmentsToPlainText(segments) {
  if (!Array.isArray(segments)) return typeof segments === 'string' ? segments : '';
  let text = '';
  for (const segment of segments) {
    if (segment?.type === 'text') text += segment.data?.text ?? '';
    else if (segment?.type === 'at') text += `@${segment.data?.name || segment.data?.qq || ''} `;
    else if (segment?.type === 'face') text += `[表情${segment.data?.id ?? ''}]`;
    else if (segment?.type === 'dice') text += `[骰子${diceResultLabel(segment.data)}]`;
    else if (segment?.type === 'rps') text += `[猜拳${rpsResultLabel(segment.data)}]`;
    else if (segment?.type === 'image') text += '[图片]';
    else if (segment?.type === 'video') text += '[视频]';
    else if (segment?.type === 'record') text += '[语音]';
    else if (segment?.type === 'file') text += `[文件 ${segment.data?.name || ''}]`;
  }
  return text;
}

function segmentMediaLabels(segments) {
  const out = [];
  for (const segment of segments || []) {
    switch (segment?.type) {
      case 'image': out.push('图片'); break;
      case 'mface': out.push('表情'); break;
      case 'video': out.push('视频'); break;
      case 'record': out.push('语音'); break;
      case 'file': out.push(`文件:${segment.data?.name || ''}`); break;
      default: break;
    }
  }
  return out;
}

function fileUriToPath(uri) {
  try {
    const url = new URL(uri);
    return decodeURIComponent(url.pathname.replace(/^\//, '')).replace(/\//g, path.sep);
  } catch {
    return null;
  }
}
