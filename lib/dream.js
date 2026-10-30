/**
 * 做梦（可选层，2026-10-29 他提的）。
 *
 * 规则（这几条比"梦好不好看"重要）：
 *   1. **素材只能来自真实记忆**：最近 48 小时他说过的话、看过的视频、当天摘要。
 *      梦可以荒诞，但不能凭空造人和事——不然就是编故事。
 *   2. 概率低（每次睡觉 18%），睡够 3 小时才有资格。
 *   3. 只说一句「好像梦到…」，不解释、不写长。
 *   4. 醒来记得的概率 30%（记不住就不提，这比天天报梦真实）。
 *   5. 梦给心情的脉冲极小（≤0.05），不许变成开关。
 */

export const DREAM_CHANCE = 0.18;
export const DREAM_REMEMBER = 0.3;
export const DREAM_MIN_HOURS = 3;
/** 素材只看最近 48 小时 */
export const DREAM_WINDOW_MS = 48 * 3600000;

/** 这次睡觉会不会做梦。 */
export function shouldDream({ sleptHours = 0, rand = Math.random } = {}) {
  if (Number(sleptHours) < DREAM_MIN_HOURS) return false;
  return rand() < DREAM_CHANCE;
}

/** 醒了还记不记得。 */
export function rememberDream({ rand = Math.random } = {}) {
  return rand() < DREAM_REMEMBER;
}

/**
 * 从记忆条目里抽素材。只认有 text 的行，太短的（嗯/哦）跳过。
 * @param rows [{ ts, text, kind }]
 */
export function pickSeeds(rows = [], { now = Date.now(), max = 3, rand = Math.random } = {}) {
  const floor = now - DREAM_WINDOW_MS;
  const usable = (rows || [])
    .filter((row) => row && Number(row.ts) >= floor)
    .map((row) => String(row.text || '').trim())
    .filter((text) => text.length >= 6 && text.length <= 80);
  if (!usable.length) return [];
  // 洗牌后取前几个，别永远梦到最新那条
  const pool = [...usable];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.max(1, max));
}

/**
 * 给模型的一段做梦提示。**不给梦的内容**——只给素材和规则，梦由她自己长出来。
 */
export function dreamBrief(seeds = []) {
  if (!seeds.length) return '';
  const lines = seeds.map((seed) => `· ${seed}`);
  return [
    '【你刚从一个梦里醒过来】',
    '梦里的东西是从这些真事里长出来的：',
    ...lines,
    '规则：只说一句「好像梦到……」，一句话就够，可以荒诞、可以接不上；不解释梦的意思，不写长。',
    '不想说也可以不说——他问起来再讲。',
  ].join('\n');
}

/** 梦对心情的脉冲（很小，且只给方向）。 */
export function dreamPulse(seedsCount = 1) {
  const weight = Math.min(0.05, 0.02 + 0.01 * Math.max(0, Number(seedsCount) || 0));
  return { signal: 'teased', weight };
}
