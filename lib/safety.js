/**
 * 安全层的**单一出口**（2026-10-29 合并）。
 *
 * 以前是两套各自扫、各自拼提示：`forbidden.js`（禁言库，世界的红线/关系里的边界）
 * 和 `shield.js`（自保层，别人怎么对她）。规则本身各管各的，但输出是两条流水线，
 * 同一句话可能被两边各说一遍，判定也各算一次。
 *
 * 现在只留一个判断顺序，规则表还在原处：
 *   1. 两套规则都扫，命中合并成一个列表
 *   2. **只要有一条是硬红线**，整段按硬红线走（不软化）——"未成年"这种不能因为
 *      同时也写在关系型条目里就跟着软掉
 *   3. 主人私聊 + 关系型 → mode='mood'（不背稿子，交给她自己的脾气）
 *      其余 → mode='script'（给口径 / 按阶梯）
 */

import { inspectForbidden, forbiddenResponseText } from './forbidden.js';
import { assessAssault } from './shield.js';

/**
 * @returns {{ hits: Array<{source:'forbidden'|'shield', id:string, name:string, moodMode:boolean, mode:'mood'|'script', script?:string}>, hasHard:boolean }}
 */
export function scanSafety(text, { ownerPrivate = false } = {}) {
  const hits = [];
  for (const hit of inspectForbidden(text)) {
    if (!hit.stillBlocked) continue;
    hits.push({
      source: 'forbidden',
      id: hit.id,
      name: hit.name,
      moodMode: Boolean(hit.moodMode),
      script: forbiddenResponseText(hit),
    });
  }
  for (const hit of assessAssault(text)) {
    hits.push({
      source: 'shield',
      id: hit.id,
      name: hit.name,
      moodMode: Boolean(hit.moodMode),
    });
  }
  const hasHard = hits.some((hit) => !hit.moodMode);
  // 2026-10-29 他的原话：「谁也不希望互动正火热时来一句系统警告」。
  // 告警是给**别人**准备的——主人自己就是收告警的人，他在私聊里说什么都不该触发告警。
  return {
    hasHard,
    hits: hits.map((hit) => ({
      ...hit,
      mode: ownerPrivate && hit.moodMode && !hasHard ? 'mood' : 'script',
      report: !ownerPrivate,
    })),
  };
}
