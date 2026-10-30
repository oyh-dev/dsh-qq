/**
 * Small human imperfections: a reply that never comes instantly is more believable.
 * Everything here is opt-in through config, and every function takes an injected
 * random source so behaviour stays testable.
 */
export function pickDelayMs({ min = 800, max = 4200 } = {}, random = Math.random) {
  const low = Math.max(0, Number(min) || 0);
  const high = Math.max(low, Number(max) || low);
  if (high <= low) return low;
  return Math.round(low + random() * (high - low));
}

/** A short filler reply for the moments when a whole sentence would look robotic. */
const SHORT_REPLIES = ['嗯', '行', '好', '哦', '在', '知道啦', '嗯嗯', '好嘛'];

export function pickShortReply(bridge = {}, random = Math.random) {
  const pool = Array.isArray(bridge.shortReplies) && bridge.shortReplies.length
    ? bridge.shortReplies
    : SHORT_REPLIES;
  return pool[Math.floor(random() * pool.length) % pool.length];
}
