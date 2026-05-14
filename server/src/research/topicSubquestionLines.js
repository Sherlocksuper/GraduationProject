/**
 * 报告标题等：去掉套在研究 topic 前的知识库检索片段前缀。
 */
export function displayTopicForReport(topic) {
  const t = String(topic || "").trim();
  const marker = "【用户知识库检索参考】";
  if (t.startsWith(marker)) {
    const after = t.slice(marker.length).trim();
    const sep = "\n\n---\n\n";
    const i = after.indexOf(sep);
    if (i !== -1) return after.slice(i + sep.length).trim();
    return after;
  }
  return t;
}

/**
 * Reader / Writer 的 user 消息里「主题 + 子问题」段落。
 * 聊天深度研究会把对话拼进 task.topic，其中已有【当前问题】段；若再跟一行同文的
 * 「子问题(qx)：…」会在流程图悬停文案里显得重复，这里合并表述。
 */
export function topicAndSubquestionLinesForAgent(topic, qid, question) {
  const t = String(topic ?? "").trim();
  const q = String(question ?? "").trim();
  const id = String(qid ?? "").trim() || "q?";

  if (!t) return q ? [`子问题(${id})：${q}`] : [];

  if (!t.includes("【当前问题】")) {
    return [`主题：${t}`, `子问题(${id})：${q}`];
  }

  const head = q.length >= 8 ? q.slice(0, Math.min(48, q.length)) : q;
  const duplicate =
    !q || t.includes(q) || (head.length >= 6 && t.includes(head));

  if (!duplicate) {
    return [`主题：${t}`, `子问题(${id})：${q}`];
  }

  return [
    "研究任务全文（已含对话上文与【当前问题】；以下不再重复摘抄子问题全文）：",
    t,
    "",
    `Planner 子问题编号：${id}（提炼要点须围绕 Planner 本条；与上文「当前问题」语义一致处勿机械复述。）`
  ];
}

/**
 * 综述/结论/GlobalEditor 用的「主题」短串：去 RAG 前缀；极长聊天课题截断并尽量保留【当前问题】段，
 * 避免与下方 brief / 一稿正文重复堆同一超长 topic。
 */
export function coordinatorBriefTopic(topic) {
  let t = displayTopicForReport(topic);
  const max = 4500;
  if (t.length <= max) return t;
  const mark = "【当前问题】";
  const idx = t.indexOf(mark);
  if (idx !== -1) {
    const start = Math.max(0, idx - 1500);
    t = (start > 0 ? "…\n" : "") + t.slice(start).trim();
  }
  if (t.length > max) t = t.slice(0, max) + "\n…（课题过长已截断；细节见各小节要点或正文一稿）";
  return t;
}
