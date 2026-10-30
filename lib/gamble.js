/**
 * 赌局识别（2026-10-30 他提的）：不绑定「21点」这种具体游戏，只认**赌的动作**。
 *
 * 只要出现「押 / 下注 / 加注 / 梭哈 / 跟 / 弃 / 赢 / 输 / 收手」这类词，任何赌性质
 * 的游戏都会被认出来：21 点、德州、押大小、猜拳押注、抽卡梭哈、翻倍赌……
 *
 * 三个出口：
 *   · 关键词兜底（这里）
 *   · `gamble.extraWords` 配置——他以后想到新说法，加词就行，不用改代码
 *   · `qq_gamble` 工具——她自己在游戏里报一声，最准
 */

const BET = [
  '梭哈', '梭了', '全下', 'all in', 'allin', '加注', '下注', '押上', '押大', '押小',
  '买大', '买小', '跟注', '跟一把', '再压', '压一把', '我赌', '赌一把', '一把定输赢',
  '再来一局', '不服再来', '继续压', '翻倍押', '押全部', '压上', '买定离手',
];

const WIN = [
  '我赢了', '赢了', '赢麻', '通杀', '翻本了', '翻盘了', '爆了她', '一把赢', '血赚', '我赢',
];

const LOSE = [
  '我输了', '输了', '爆牌', '爆了', '输光了', '输干净', '血亏', '爆掉', '输惨', '输了算了',
];

const QUIT = [
  '不玩了', '收手', '见好就收', '我认输', '这把算了', '够了够了', '停手', '不赌了', '撤了',
];

const ALL = { bet: BET, win: WIN, lose: LOSE, quit: QUIT };

function matchAny(text, words) {
  const hay = String(text || '').toLowerCase();
  return words.some((word) => hay.includes(String(word).toLowerCase()));
}

/**
 * @returns {'bet'|'win'|'lose'|'quit'|''}
 * 判定顺序：收手 > 赢 > 输 > 押注（因为「输了就当没赌过」这种话要算输）
 */
export function detectGamble(text, { extraWords = [] } = {}) {
  const extras = Array.isArray(extraWords) ? extraWords.map(String).filter(Boolean) : [];
  const extraBet = extras.map((word) => String(word));
  if (matchAny(text, QUIT)) return 'quit';
  if (matchAny(text, WIN)) return 'win';
  if (matchAny(text, LOSE)) return 'lose';
  if (matchAny(text, BET) || extraBet.some((word) => String(text || '').toLowerCase().includes(word.toLowerCase()))) return 'bet';
  return '';
}

/** 信号名（给 mood 用） */
export function gambleSignal(kind) {
  return { bet: 'gamble', win: 'gambleWon', lose: 'gambleLost', quit: 'quitGamble' }[kind] || '';
}
