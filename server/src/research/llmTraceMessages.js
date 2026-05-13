/** 将 chat 的 messages 压成可 JSON 序列化、便于写入 research trace 的结构 */

export function compactLlmMessages(messages) {
  if (!Array.isArray(messages)) return null;
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    out.push({
      role: String(m.role ?? ""),
      content: String(m.content ?? "")
    });
  }
  return out.length ? out : null;
}

/** 流程图悬浮层等纯文本展示 */
export function formatLlmMessagesForHint(messages) {
  const arr = compactLlmMessages(messages);
  if (!arr) return "";
  return arr
    .map((m) => {
      const r = (m.role || "message").toUpperCase();
      return `[${r}]\n${m.content}`;
    })
    .join("\n\n────────\n\n");
}
