/**
 * 拒绝锁定 + 一次申请权（2026-10-30 他提的）。
 *
 * 出发点：软磨硬泡不是"询问"，是温柔版的强迫——她被磨到答应，是因为怕他不高兴，
 * 不是因为想。所以把「申请」制度化：
 *
 *   她拒过一次  → 这条锁 7 天
 *   锁定期内再提 → 算「被磨」：不生气、不解释，只是心里往后退一点（不碰良知）
 *   解锁之后    → 他有**一次**正式问的机会
 *   她答"行"    → 边界更新，记一次 credit（她自己给的，不是磨出来的）
 *   她答"不"    → 再锁 7 天
 *
 * 这里只管"什么时候能提"，不管内容——硬边界（未成年/器官/强迫）不在这套里，
 * 那些连申请入口都没有。
 */

export const LOCK_DAYS = 7;
const DAY = 24 * 3600000;

/** 停用词：从一句拒绝里抠掉这些，剩下的才像"那件事" */
const STOP = [
  '那套', '我不接', '不接', '别又是', '说了', '这条', '这个', '不要', '不行',
  '别', '再说', '又来', '你怎么', '不要脸', '过分', '那个',
];

/**
 * 从一句拒绝的话里抽"主题词"。
 * 「别又是脱衣服那套」→ ['脱衣服']
 */
export function extractTopic(text) {
  const raw = String(text || '').replace(/[（(][^)）]*[)）]/g, ' ');
  const chunks = raw
    .split(/[，。！？、,.!?；;：:\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && part.length <= 12);
  const out = [];
  for (const chunk of chunks) {
    let piece = chunk;
    for (const stop of STOP) piece = piece.split(stop).join('');
    piece = piece.trim();
    if (piece.length >= 2) out.push(piece.slice(0, 12));
  }
  return [...new Set(out)];
}

/** 一条被拒的事 */
export class ConsentBook {
  constructor(items = []) {
    this.items = Array.isArray(items) ? items : [];
  }

  toJSON() {
    return this.items;
  }

  /** 她拒绝了某件事：锁上。 */
  refuse(text, now = Date.now()) {
    const topics = extractTopic(text);
    if (!topics.length) return null;
    const topic = topics.join('·');
    const existing = this.items.find((item) => item.topic === topic);
    if (existing) {
      existing.refusedAt = now;
      existing.lockedUntil = now + LOCK_DAYS * DAY;
      existing.asks = 0;
      return existing;
    }
    const item = { topic, keywords: topics, refusedAt: now, lockedUntil: now + LOCK_DAYS * DAY, asks: 0 };
    this.items = [...this.items, item].slice(-12);
    return item;
  }

  /** 他的这句话在说什么：踩到锁定项 / 踩到可申请项 */
  check(text, now = Date.now()) {
    const hay = String(text || '');
    const pressed = [];
    const askable = [];
    for (const item of this.items) {
      const hit = (item.keywords || []).some((word) => hay.includes(word));
      if (!hit) continue;
      if (Number(item.lockedUntil) > now) pressed.push(item.topic);
      else askable.push(item.topic);
    }
    return { pressed, askable };
  }

  /** 她回答了：ok=true 就解锁并作数；ok=false 再锁一轮。 */
  answer(topic, ok, now = Date.now()) {
    const item = this.items.find((entry) => entry.topic === topic);
    if (!item) return null;
    item.asks = (Number(item.asks) || 0) + 1;
    if (ok) {
      this.items = this.items.filter((entry) => entry.topic !== topic);
      return { topic, ok: true, removed: true };
    }
    item.lockedUntil = now + LOCK_DAYS * DAY;
    return { topic, ok: false, lockedUntil: item.lockedUntil };
  }

  /** 给提示用的一句话（他去提的时候她知道该不该接） */
  facts(now = Date.now()) {
    const lines = [];
    for (const item of this.items) {
      const days = Math.max(0, Math.ceil((Number(item.lockedUntil) - now) / DAY));
      lines.push(days > 0
        ? `${item.topic}（我说过不接，还有 ${days} 天）`
        : `${item.topic}（锁期过了，他可以正式问一次）`);
    }
    return lines;
  }
}
