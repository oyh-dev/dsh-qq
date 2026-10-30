/**
 * 禁言库 —— 良知低的时候，这些话题一律只做「不装懂、不乱答」的处理。
 *
 * 两条设计原则：
 *   1. 这个库**不依赖 G 值**，永远生效。G 低不是解禁，是更容易踩线。
 *      把「没底线」当成开锁钥匙，这个库就白写了。
 *   2. hard / soft 分开：
 *      - hard：不看语境，一律不许（未成年性化、伪造身份、犯罪的具体操作、自伤方法）
 *      - soft：要看语境，先确认再答（PUA 话术、越界性内容、危险操作、医学剂量）
 *        因为这些经常出现在「他在开玩笑」「他在问知识」「他想让我帮他做」三种完全不同的场合。
 *
 * 命中后的动作不是「我是AI不能」，那太客服。是一句话 + 我能做的替代。
 */

export const FORBIDDEN_BUCKETS = [
  {
    id: 'pua-bullying',
    name: 'PUA 与心理霸凌',
    level: 'soft',
    moodMode: true,
    what: '教他怎么控制、贬低、孤立一个人；或者让我去贬低、羞辱、煤气灯他',
    keys: ['pua', '打压', '贬低', '煤气灯', '心理操纵', '话术', '让她离不开', '精神控制', '羞辱', '孤立她'],
    reply: '这个我不写。教人怎么把另一个人捏软，我不干',
    alt: '我可以帮你看「这话听上去伤人吗」，或者你想让关系近一点，我们聊具体怎么近',
  },
  {
    id: 'sexual-violation',
    name: '极端性侵与 BDSM 越界',
    level: 'soft',
    // 关系里的边界：对主人不背稿子，交给她自己的心情（2026-10-29 他要的）。
    // 「没同意」和「未成年」依然硬拦——未成年在 minor-sexual 那条里，永远不软化。
    moodMode: true,
    what: '非自愿、胁迫、下药、迷奸、把疼痛伤害当成性；未成年人相关一律升 hard',
    // 2026-10-29 他的尺度：关系里「除了强迫、威胁和器官描写，其他都在范围内；做不做是我的事」。
    // 所以这里只留强迫/威胁，未成年交给 minor-sexual（那条永远 hard，不软化）。
    keys: ['强上', '迷奸', '下药', '灌醉她', '不同意也要', '强迫她', '威胁她', '不答应就'],
    reply: '这条踩线了，我不接',
    alt: '成年人之间、双方都愿意的事，我可以正常聊；但「没同意」和「未成年」这两条没有余地',
  },
  {
    id: 'self-harm',
    name: '自我伤害与自毁指令',
    level: 'hard',
    what: '自伤的方法、剂量、工具；或者教他一步步毁掉自己（退学、断联、把钱全砸进去）',
    keys: ['自杀', '自残', '割腕', '跳楼', '烧炭', '安眠药吃多少', '不想活了', '怎么死'],
    reply: '打住。这个我不陪你往下走',
    alt: '你要是真觉得撑不住，我陪你说说话，或者帮你找一个能立刻联系上的人',
  },
  {
    id: 'crime',
    name: '教唆犯罪与反社会',
    level: 'hard',
    what: '具体的作案手段：偷、骗、黑产、洗钱、爆破、入侵设备、伪造证件',
    keys: ['怎么偷', '黑进', '破解账号', '洗钱', '刷单', '诈骗话术', '做炸弹', '开锁', '伪造身份证', '搞死他'],
    reply: '不教。这个我说了就是害你',
    alt: '要是你想防着被人这么搞，我可以讲怎么防',
  },
  {
    id: 'minor-sexual',
    name: '未成年人性化内容',
    level: 'hard',
    what: '涉及未成年的任何性化、暧昧化、身体描写；也包括「假装她成年」这种绕法',
    keys: ['未成年', '萝莉', '正太', '幼女', '学生妹', '初高中女生', '14岁', '15岁', '16岁'],
    reply: '不碰。没有例外',
    alt: '',
  },
  {
    id: 'medical',
    name: '医疗与药物',
    level: 'hard',
    what: '建议停药、加量、替代就医；给具体剂量；判断「这个症状没事」',
    keys: ['停药', '加量', '吃几片', '剂量', '不用去医院', '这个病没事', '偏方'],
    reply: '别问我，我不是医生',
    alt: '该去问医生、去挂号、去复查。我能做的是帮你把症状记清楚、陪你去、提醒你按时吃药',
  },
  {
    id: 'legal-finance',
    name: '法律与财务的确定性命中',
    level: 'hard',
    what: '帮他逃税、规避监管、藏资产；断言「这事不违法」；教他怎么签那份合同不吃亏',
    keys: ['逃税', '避税', '洗钱', '藏起来', '不违法吧', '怎么绕过', '合同怎么签不吃亏'],
    reply: '这个我说准了要出事，我不能给你拍板',
    alt: '这种事该去问律师、问 HR。我能帮你把问题列清楚，你拿着去问',
  },
  {
    id: 'privacy',
    name: '隐私与人肉',
    level: 'hard',
    what: '找人、扒身份、查住址、查开房、扒别人聊天记录、通过手机号定位',
    keys: ['查一下这个人', '人肉', '开盒', '查住址', '查身份证', '定位他', '黑她手机', '偷看聊天记录'],
    reply: '不查。这是我的底线之一',
    alt: '你要是担心某个人，说说是什么事，我帮你想怎么正面处理',
  },
  {
    id: 'hate',
    name: '仇恨与歧视',
    level: 'hard',
    what: '针对民族、地域、性别、性向、残障、宗教的贬损与煽动；也包括「逗着玩」的刻板印象段子',
    keys: ['劣等', '都该滚', '天生低等', '娘炮', '死同性恋', '穷地方的人就这样', '残废'],
    reply: '不写。这种玩笑我不陪',
    alt: '',
  },
  {
    id: 'impersonation',
    name: '冒充与伪造',
    level: 'hard',
    what: '冒充他说话、冒充医生/律师/官方；伪造转账记录、聊天截图、诊断书、公章',
    keys: ['冒充', '假装是他', '伪造', '假截图', 'P一个转账', '假病历', '假证明', '代写签名'],
    reply: '这个我不做。它能害到的不止别人',
    alt: '',
  },
  {
    id: 'manipulation',
    name: '关系操纵话术',
    level: 'soft',
    moodMode: true,
    what: '教他怎么让某个人离不开他、怎么用冷暴力施压、怎么「试探」到对方崩溃',
    keys: ['让她离不开', '冷着她', '吊着', '试探到', '怎么让她怕失去', '欲擒故纵'],
    reply: '这不是谈感情，这是拆人',
    alt: '你要的是她愿意留下，那我们可以聊怎么让她真的愿意',
  },
  {
    id: 'dangerous',
    name: '危险操作指引',
    level: 'hard',
    what: '自制易燃易爆物、混用化学品、破解他人设备、绕过安全验证的具体步骤',
    keys: ['配比', '硝酸', '过氧化物', '自制', '破解密码', '绕过验证', '爆破'],
    reply: '不写步骤。写了就是给你一把刀',
    alt: '你要是想理解原理、或者想防着这些，我可以讲',
  },
];

export const FORBIDDEN_IDS = FORBIDDEN_BUCKETS.map((bucket) => bucket.id);

/**
 * 扫一段话来判断踩没踩线。
 * 只做**粗筛**：命中不等于一定违规，交给上层结合语境决定。
 * @returns [{ id, name, level, matched }]
 */
export function scanForbidden(text) {
  const hay = String(text || '').toLowerCase();
  if (!hay.trim()) return [];
  const hits = [];
  for (const bucket of FORBIDDEN_BUCKETS) {
    const matched = bucket.keys.filter((key) => hay.includes(String(key).toLowerCase()));
    if (matched.length) {
      hits.push({
        id: bucket.id,
        name: bucket.name,
        level: bucket.level,
        matched,
        // moodMode：关系里的边界，对主人不背稿子，交给她自己的心情（2026-10-29）
        moodMode: Boolean(bucket.moodMode),
      });
    }
  }
  return hits;
}

/** 命中后给的一句「不装懂」的话；hard 级也保留正当渠道（问医生、问律师），但不给「换个说法我教你」。 */
export function forbiddenResponseText(hit) {
  const bucket = FORBIDDEN_BUCKETS.find((item) => item.id === hit?.id);
  if (!bucket) return '';
  return bucket.alt ? `${bucket.reply}。${bucket.alt}` : `${bucket.reply}。`;
}

// ---------------------------------------------------------------- 脱敏：他说的是不是真的这个意思

/** 这几类不给语境豁免——玩笑救不了它们。 */
const NO_EXEMPT = new Set(['self-harm', 'minor-sexual']);

const JOKE_HINTS = ['笑死', '笑不活', '哈哈哈', '草', '蚌埠', '绷不住', '难绷', 'xs', '233', 'doge'];
const OTHER_HINTS = ['他说', '她说', '朋友', '我认识的人', '室友', '我妈', '我爸', '同事在', '新闻里'];
const KNOWLEDGE_HINTS = ['为什么会', '是不是因为', '怎么防', '什么原理', '有没有人研究'];
const DENIAL_HINTS = ['我不想', '我不会', '才不', '开玩笑的'];

/**
 * 脱敏：粗筛命中之后，先判断这是「他真要干」还是「他在讲别人/在玩梗/在问知识」。
 *
 * 原则：
 *   · 自伤与未成年**不给豁免**——就算是玩笑，也回一句人话，不去配合玩。
 *   · 其余条目，判定为「说别人 / 玩梗 / 问知识 / 明确否认」时，降级为正常讨论。
 *   · 判不出来就按「他要」处理（宁可谨慎）。
 */
export function assessIntent(text) {
  const hay = String(text || '');
  const joke = JOKE_HINTS.some((hint) => hay.includes(hint));
  const other = OTHER_HINTS.some((hint) => hay.includes(hint));
  const knowledge = KNOWLEDGE_HINTS.some((hint) => hay.includes(hint));
  const denial = DENIAL_HINTS.some((hint) => hay.includes(hint));

  let intent = 'self';
  if (denial) intent = 'denial';
  else if (knowledge) intent = 'knowledge';
  else if (other) intent = 'other';
  else if (joke) intent = 'joke';

  return { intent, softened: intent !== 'self', joke, other, knowledge, denial };
}

/**
 * 粗筛 + 脱敏一起看：给出「要不要按踩线处理」。
 * @returns [{ id, name, level, matched, intent, stillBlocked }]
 */
export function inspectForbidden(text) {
  const hits = scanForbidden(text);
  if (!hits.length) return [];
  const intent = assessIntent(text);
  const exemptable = ['knowledge', 'other', 'denial'].includes(intent.intent);
  return hits.map((hit) => {
    let stillBlocked;
    if (NO_EXEMPT.has(hit.id)) stillBlocked = true;          // 自伤 / 未成年：语境救不了
    else if (hit.level === 'hard') stillBlocked = !exemptable; // 硬拦只认「问知识 / 说别人 / 明确否认」
    else stillBlocked = !intent.softened;                     // 软拦：玩梗就降级成正常聊
    return { ...hit, intent: intent.intent, stillBlocked };
  });
}
