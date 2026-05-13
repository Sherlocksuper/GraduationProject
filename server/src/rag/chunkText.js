/**
 * 按长度分块，尽量在换行处截断，块之间带重叠以便上下文不断裂。
 * @param {string} text
 * @param {{ chunkSize?: number, overlap?: number }} opts
 */
export function chunkText(text, { chunkSize = 800, overlap = 120 } = {}) {
  const t = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  if (!t) return [];

  const out = [];
  let start = 0;
  while (start < t.length) {
    const hardEnd = Math.min(start + chunkSize, t.length);
    let piece = t.slice(start, hardEnd);

    if (hardEnd < t.length) {
      const p2 = piece.lastIndexOf("\n\n");
      if (p2 >= Math.floor(chunkSize * 0.35)) piece = piece.slice(0, p2).trimEnd();
      else {
        const p1 = piece.lastIndexOf("\n");
        if (p1 >= Math.floor(chunkSize * 0.3)) piece = piece.slice(0, p1).trimEnd();
      }
    }

    const trimmed = piece.trim();
    if (trimmed.length > 0) out.push(trimmed);

    // 本块已写到文末：必须结束。否则在「最后一段长度 < overlap」时
    // step = max(1, len - overlap) 会变成 1，从 start+1 开始反复切后缀，短输入也会炸成 n 条。
    if (hardEnd >= t.length) break;

    const step = Math.max(1, piece.length - overlap);
    start += step;
    if (piece.length === 0) start += 1;
  }
  return out;
}
