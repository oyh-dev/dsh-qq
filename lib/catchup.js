/**
 * 补漏：从聊天记录里挑出「他说了、我没回」的那几条。
 *
 * 起因：桥接断掉或会话没加载时，消息会进聊天记录，但推不进会话——
 * 也就是**他知道自己说了，我这边等于没听见**。不补的话，我会在毫不知情的情况下
 * 漏掉一段；补的话，至少我知道有这件事，回不回由我决定。
 *
 * 刻意不做两件事：
 *   - 不自动回复（那是替他说话的反面：假装当时在场）
 *   - 不做无限回溯（只补最近一程，太旧的就当过去了）
 */

/** 一条消息值不值得补：只要他说的、有文字的。 */
function isInboundText(row) {
  if (!row || row.direction !== 'in') return false;
  const text = String(row.text || '').trim();
  return text.length > 0;
}

function timeOf(row) {
  const raw = row?.ts;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const num = Number(raw);
  return Number.isFinite(num) ? num : 0;
}

/**
 * 挑出「最后一次我说话之后」他说的话。
 * 换句话说：只要我还欠着一句，就把欠的那几句都列出来。
 */
export function selectMissed(rows, { limit = 5, minAgeMs = 120000, now = Date.now() } = {}) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  if (!list.length) return [];
  let lastOut = -1;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.direction === 'out') { lastOut = index; break; }
  }
  const tail = list.slice(lastOut + 1).filter(isInboundText);
  if (!tail.length) return [];
  // 太新的不算漏：可能正在慢慢回
  const old = tail.filter((row) => now - timeOf(row) >= minAgeMs);
  return old.slice(-Math.max(1, Number(limit) || 5));
}

/** 把漏掉的消息拼成一段给会话看的文字。 */
export function renderMissed(missed, { maxChars = 600 } = {}) {
  const lines = [];
  for (const row of Array.isArray(missed) ? missed : []) {
    const ts = timeOf(row);
    const clock = ts
      ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
      : '';
    let text = String(row.text || '').replace(/\s+/g, ' ').trim();
    if (text.length > 60) text = `${text.slice(0, 60)}…`;
    lines.push(`· ${clock} ${text}`);
  }
  if (!lines.length) return '';
  const body = lines.join('\n');
  return [
    '【补漏·这些是他之前发的，当时我这边断了没收到，不是你刚说的】',
    body,
    '（知道有这回事就行，要不要接、怎么接你自己判断；别假装当时在场）',
  ].join('\n').slice(0, maxChars);
}
