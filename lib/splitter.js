/** Chat style: drop trailing full stops ("。"), keep ?/! and ellipsis. */
export function stripTrailingPeriods(text) {
  let value = String(text ?? '');
  // Only strip at the very end, and only after real content.
  value = value.replace(/[。]+$/u, '').trimEnd();
  return value;
}

/**
 * Split a chat reply into a few short bubbles, the way a person types.
 *
 * The goal is rhythm, not grammar: keep complete thoughts, prefer paragraph
 * breaks, then sentence breaks, and only fall back to commas when a single
 * sentence is huge.
 */
export function splitForChat(text, { maxParts = 3, minChars = 12, maxCharsPerPart = 90 } = {}) {
  const value = String(text ?? '').trim();
  if (!value) return [];
  const limit = Math.max(1, Math.min(5, Number(maxParts) || 3));
  if (limit === 1) return [value];

  const blocks = hardSplit(value, maxCharsPerPart);
  // A short single paragraph stays one bubble; separate paragraphs always split,
  // however short, because that is how people type in chat.
  if (blocks.length === 1 && value.length <= minChars) return [value];
  if (blocks.length <= 1) return blocks.length === 1 ? blocks : [value];
  if (blocks.length <= limit) return blocks;

  // Merge the smallest neighbours until we are inside the part budget, so a
  // 6-line answer becomes 3 readable bubbles instead of 6 fragments.
  const merged = [...blocks];
  while (merged.length > limit) {
    let bestIndex = 0;
    let bestSize = Infinity;
    for (let index = 0; index < merged.length - 1; index += 1) {
      const size = merged[index].length + merged[index + 1].length;
      if (size < bestSize) {
        bestSize = size;
        bestIndex = index;
      }
    }
    merged.splice(bestIndex, 2, `${merged[bestIndex]} ${merged[bestIndex + 1]}`.replace(/\s+/g, ' ').trim());
  }
  return merged.filter(Boolean);
}

function hardSplit(text, maxCharsPerPart) {
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const pieces = [];
  for (const paragraph of paragraphs) {
    const lines = paragraph.split(/\n/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.length <= maxCharsPerPart) {
        pieces.push(line);
        continue;
      }
      // Long sentence: cut on Chinese/ASCII sentence punctuation first.
      const sentences = line.split(/(?<=[。！？!?…])/).map((part) => part.trim()).filter(Boolean);
      let buffer = '';
      for (const sentence of sentences) {
        if (buffer && buffer.length + sentence.length > maxCharsPerPart) {
          pieces.push(buffer);
          buffer = '';
        }
        buffer += sentence;
      }
      if (buffer) pieces.push(buffer);
    }
  }
  return pieces;
}
