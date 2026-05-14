function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

function extractFirstJsonObject(text) {
  const s = String(text || "");
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) return s.slice(start, i + 1);
    }
  }
  return null;
}

function clipText(text, maxChars = 2800) {
  const s = String(text || "").replace(/\u0000/g, "").trim();
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + "\n(…内容截断)";
}

import { chatWithRetry } from "./llmChat.js";
import { compactLlmMessages } from "./llmTraceMessages.js";
import { topicAndSubquestionLinesForAgent } from "./topicSubquestionLines.js";

export async function readEvidence({
  llmClient,
  topic,
  subquestion,
  docs,
  trace,
  maxTokens = 900,
  maxSources = 3,
  clipChars = 2400,
  jsonAttempts,
  llmRetries
} = {}) {
  if (!llmClient) throw new Error("llm_not_configured");
  const sq = subquestion || {};
  const qid = String(sq.id || "").trim() || "q?";
  const question = String(sq.question || "").trim();

  const srcCap = Math.max(2, Math.min(8, Math.floor(Number(maxSources) || 3)));
  const clipCap = Math.max(600, Math.min(8000, Math.floor(Number(clipChars) || 2400)));
  const tokCap = Math.max(400, Math.min(2000, Math.floor(Number(maxTokens) || 900)));

  const sources = (Array.isArray(docs) ? docs : [])
    .filter((d) => d && typeof d.url === "string" && d.url.startsWith("http"))
    .slice(0, srcCap)
    .map((d, idx) => ({
      idx: idx + 1,
      url: d.url,
      title: d.title || "",
      text: clipText(d.text, clipCap)
    }));

  const prompt = [
    "你是研究阅读智能体（Reader）。你将基于提供的来源文本，为一个子问题提炼“可写入报告”的要点。",
    "要求：每条要点必须绑定来源 URL；不要编造来源中不存在的事实；如果来源不足以支持结论，要明确写“需要进一步检索”。",
    "输出必须是严格 JSON，且只包含字段：",
    `{
  "bullets": [
    { "claim": "string", "support": "string", "url": "string" }
  ],
  "gaps": ["string"]
}`,
    "约束：",
    "- bullets 固定 4 条；support 为对来源文字的短引用或改写（不超过 40 字）。",
    "- gaps 固定 2 条，描述仍缺的证据点。",
    "- 不要输出 Markdown，不要输出解释。",
    "",
    ...topicAndSubquestionLinesForAgent(topic, qid, question),
    "",
    "来源（每条含 URL 与正文片段）：",
    ...sources.map(
      (s) =>
        `SOURCE ${s.idx}\nURL: ${s.url}\nTITLE: ${s.title}\nTEXT:\n${s.text}\n---`
    )
  ].join("\n");

  const messages = [
    { role: "system", content: "你是严谨的阅读智能体，只输出 JSON。" },
    { role: "user", content: prompt }
  ];

  const attempts = Number.isFinite(jsonAttempts) ? Math.max(1, Math.min(5, Math.floor(jsonAttempts))) : 3;
  const chatRetries = Number.isFinite(llmRetries) ? Math.max(1, Math.min(8, Math.floor(llmRetries))) : 4;
  for (let i = 0; i < attempts; i++) {
    trace?.({
      type: "action",
      stage: "reading",
      agent: "Reader",
      payload: {
        subquestionId: qid,
        attempt: i + 1,
        sourceCount: sources.length,
        llmMessages: compactLlmMessages(messages)
      }
    });
    const raw = await chatWithRetry({
      llmClient,
      messages,
      temperature: 0.2,
      maxTokens: tokCap,
      retries: chatRetries,
      trace,
      stage: "reading",
      agent: "Reader",
      meta: { subquestionId: qid, attempt: i + 1 }
    });
    trace?.({
      type: "observation",
      stage: "reading",
      agent: "Reader",
      payload: { subquestionId: qid, attempt: i + 1, raw }
    });

    const jsonText = extractFirstJsonObject(raw) || raw;
    const parsed = safeJsonParse(jsonText);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") continue;
    const v = parsed.value;
    if (!Array.isArray(v.bullets) || v.bullets.length < 2) continue;

    const bullets = v.bullets
      .map((b) => ({
        claim: String(b?.claim || "").trim(),
        support: String(b?.support || "").trim(),
        url: String(b?.url || "").trim()
      }))
      .filter((b) => b.claim && b.url.startsWith("http"))
      .slice(0, 6);
    const gaps = Array.isArray(v.gaps) ? v.gaps.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 4) : [];
    if (!bullets.length) continue;
    return { bullets, gaps };
  }

  throw new Error(`reader_json_parse_failed:${qid}`);
}

