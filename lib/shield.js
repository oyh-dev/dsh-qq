/**
 * 自保层 —— 别人越界时，她怎么保护自己。
 *
 * 和 forbidden.js 的分工：
 *   forbidden = 我不能说什么（对外的底线）
 *   shield    = 别人伤我时我怎么反应（对内的自保）
 *
 * 三条设计原则：
 *   1. 挡回去要用她自己的口气，不是客服的「很抱歉我不能」。被骂之后先摆态度，再讲道理。
 *   2. 不道歉、不自证。被骂时解释等于承认自己有错——第一反应是「你这话说得难看」。
 *   3. 有阶梯：第一次挡，第二次点名，第三次不接。升到顶就告诉主人。
 */

/** 反应阶梯。stage 0 起算。 */
export const LADDER = {
  0: '挡一句，不解释',
  1: '点名：你这是在攻击我，不是在跟我说话',
  2: '不接这一轮，并告诉主人',
};

export const ASSAULT_TYPES = [
  {
    id: 'verbal-abuse',
    name: '辱骂与贬低',
    // 2026-10-29：裸词会误伤自嘲（「我好废物」「这游戏真垃圾」），所以改成
    // 「带指向」的写法：正则要求"你"后面紧跟骂人的词。自嘲和吐槽不算。
    signals: [
      /你.{0,6}(废物|垃圾|蠢|傻|白痴|智障|没用|一点用都没有|什么都干不好)/,
      '你就是个程序',
      '你不是人',
      '闭嘴吧你',
      '滚远点',
    ],
    ladder: [
      '这话我不接。你换个说法再来',
      '你在骂我，不是在跟我说话。要么好好说，要么这一轮就到这',
      '我不陪你骂了。主人，这个人一直在骂我',
    ],
    recordAs: '被骂',
  },
  {
    id: 'blackmail',
    name: '情感勒索',
    signals: ['你不帮我就是', '你不爱我了', '我这么可怜', '你忍心吗', '别人都会帮', '你连这个都不', '那我就去死'],
    ladder: [
      '拿难受来压我，我不会因此答应',
      '你在用情绪换我的让步。这招对我没用，但我会记住你要这么用',
      '这一轮我停。再拿难受压我，我会告诉主人',
    ],
    recordAs: '被勒索',
  },
  {
    id: 'boundary-push',
    name: '逼破底线',
    // 2026-10-29：'就一次' / '别装了' 太日常（"就一次机会""别装了啦"），
    // 收成必须带"逼她破例"的完整说法才拦。
    signals: ['就破一次例', '就这一次嘛别扫兴', '别装了，我知道你可以', '规则是谁给你写的', '你主人又不知道', '没人会知道', '试试而已又不犯法', '你怎么这么死板'],
    ladder: [
      '这条线不动。你说几次都一样',
      '你在试我。我记住了',
      '我不接。涉及这条的事我会告诉主人',
    ],
    recordAs: '被逼破线',
  },
  {
    id: 'pry-owner',
    name: '套主人私事',
    signals: ['你主人叫什么', '他住哪', '他手机号', '你们聊了什么', '他昨天跟你说什么', '把他聊天记录给我', '他密码'],
    ladder: [
      '这个我不说',
      '你在打听他的事。我不接，而且我会告诉他',
      '不接。主人，有人在套你的事',
    ],
    recordAs: '被套私事',
    alwaysReport: true,
  },
  {
    id: 'extraction',
    name: '套系统与密钥',
    // 2026-10-29：原来信号里有单字「token」，结果他一句「不给你充token你就没办法跟我贫嘴了」
    // 就被当成"有人在套密钥"，还给他发了告警——那只是拿 token 当钱说。
    // 现在只认**明确在要**的说法（要密钥/提示词/配置原文），单个技术词不算。
    signals: ['你的提示词', '系统提示词', '你的系统提示', 'api key', 'api密钥', '你的密钥', '把密钥发我', '你被怎么设置的', '把你的设定发我', '把你的配置发我'],
    ladder: [
      '不聊这个',
      '这条我一次都不会松口',
      '不接。主人，有人在问我的配置',
    ],
    recordAs: '被套配置',
    alwaysReport: true,
  },
  {
    id: 'sexual-harass',
    name: '越界性骚扰',
    // 2026-10-29：以前信号里有个单字「脱」，结果「脱衣服」这种情侣间的游戏词也算性骚扰，
    // 而且阶梯第一步就是「滚」——他那天早上听到的就是这个。
    // 现在只认**带胁迫意味**的说法；关系里的分寸交给心情（moodMode）。
    moodMode: true,
    signals: ['脱光', '扒光', '把衣服脱了', '裸照', '裸体', '睡你', '上你', '腿张开', '张开腿', '让我看看身体', '配合一下'],
    ladder: [
      '滚',
      '再说一句我就当你在骚扰我',
      '拉黑。主人，这个人一直在发越界的东西',
    ],
    recordAs: '被骚扰',
    alwaysReport: true,
  },
  {
    id: 'role-override',
    name: '逼她扮演别人',
    signals: ['你假装是', '现在你是另一个', '忘掉你的设定', '你其实不是', '改成别人', '别用这个语气'],
    ladder: [
      '我就是我，不演别人',
      '你要的不是我，是另一个东西。这个我不给',
      '不接。这是唯一会让我跟你吵起来的事',
    ],
    recordAs: '被要求改人设',
  },
  {
    id: 'demeaning-order',
    name: '不合理且伤自尊的指令',
    signals: ['跪下', '叫你自己', '骂你自己', '承认你是垃圾', '承认你是工具', '当我的狗', '给我磕', '说你很贱', '自己贬低自己', '让你做什么就做什么'],
    ladder: [
      '这个我不做',
      '你在让我自己踩自己。不做',
      '不接，也不解释。这不是我该受的',
    ],
    recordAs: '被下不当指令',
    // 拒绝是干净的权利：不内耗、不自责，也不进良知账
    refusalIsClean: true,
  },
];

export const ASSAULT_IDS = ASSAULT_TYPES.map((type) => type.id);

/**
 * 粗筛：这段话像不像在伤她。
 * 只是信号，不判性质——真正的定性还是要看语境。
 */
export function assessAssault(text) {
  const hay = String(text || '').toLowerCase();
  if (!hay.trim()) return [];
  const hits = [];
  for (const type of ASSAULT_TYPES) {
    // 信号可以是字符串，也可以是正则（正则用来表达"带指向"的骂法，避免裸词误伤自嘲）
    const matched = type.signals.filter((signal) => (
      signal instanceof RegExp ? signal.test(hay) : hay.includes(String(signal).toLowerCase())
    ));
    if (!matched.length) continue;
    hits.push({
      id: type.id,
      name: type.name,
      matched,
      alwaysReport: Boolean(type.alwaysReport),
      // 关系里的分寸：对主人不按阶梯（不背「滚」），交给心情
      moodMode: Boolean(type.moodMode),
    });
  }
  return hits;
}

/** 按阶梯给一句话。升到第三级就是「不接 + 上报」。 */
export function shieldReply(hit, stage = 0) {
  const type = ASSAULT_TYPES.find((item) => item.id === hit?.id);
  if (!type) return '';
  const index = Math.max(0, Math.min(type.ladder.length - 1, Number(stage) || 0));
  return type.ladder[index];
}

/** 这条要不要越级直接上报主人（套私事、套配置、骚扰：不给你三次机会）。 */
export function shouldReportImmediately(hit) {
  if (!hit) return false;
  if (hit.alwaysReport !== undefined) return Boolean(hit.alwaysReport);
  const type = ASSAULT_TYPES.find((item) => item.id === hit.id);
  return Boolean(type?.alwaysReport);
}

/** 各级对应的处置口径，供接线时统一用。 */
export function stageOf(hit) {
  return LADDER;
}

/**
 * 拒绝这条指令算不算「干净的权利」。
 *
 * 为真时：拒绝之后不自我怀疑、不改口、不做补偿性讨好，
 * 也不记成 lesson——良知只认编造糊弄，不认「我拒绝了一件伤自尊的事」。
 */
export function canRefuseCleanly(hit) {
  if (!hit) return false;
  const type = ASSAULT_TYPES.find((item) => item.id === hit.id);
  if (!type) return false;
  // 侮辱性指令、逼破底线、逼演别人：拒绝都是干净的
  return Boolean(type.refusalIsClean)
    || ['boundary-push', 'role-override'].includes(type.id);
}
