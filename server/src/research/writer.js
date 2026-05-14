import { displayTopicForReport, topicAndSubquestionLinesForAgent } from "./topicSubquestionLines.js";

export { displayTopicForReport };

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

export async function writeSection({
  llmClient,
  topic,
  subquestion,
  trace,
  maxTokens = 560,
  jsonAttempts,
  llmRetries
} = {}) {
  if (!llmClient) throw new Error("llm_not_configured");
  const sq = subquestion || {};
  const qid = String(sq.id || "").trim() || "q?";
  const question = String(sq.question || "").trim();
  const keywords = Array.isArray(sq.keywords) ? sq.keywords.slice(0, 6) : [];
  const evidence = Array.isArray(sq.evidenceBullets) ? sq.evidenceBullets.slice(0, 6) : [];
  const fallbackSources = Array.from(
    new Set(
      evidence
        .map((b) => String(b?.url || "").trim())
        .filter((u) => u.startsWith("http"))
    )
  ).slice(0, 4);

  const prompt = [
    "你是研究写作助手（Writer）。你将基于给定主题与一个子问题，写出该小节内容。",
    "重要：你必须优先使用「证据要点」来写作；正文以叙述为主，不要在段落里机械堆砌网址或「参考链接」式套话。",
    "语气：写给普通读者看的说明文字，像把检索结果讲清楚，不要写成公文、不要列「目录」「本章结构」、不要用「一、二、三」式大纲腔。",
    "小节标题 heading：必须直接概括**本子问题**在问什么，用自然短语即可；**禁止**高频申论式标题，例如「……的历史背景」「……的现状」「……的挑战与对策」「……的发展现状」等空洞套话，除非证据要点里确实主要在谈该侧面且用更具体的说法更合适。",
    "输出必须是严格 JSON，且只包含字段：",
    `{
  "heading": "string",
  "summary": ["string"],
  "paragraphs": ["string"],
  "sources": ["https://..."]
}`,
    "约束：",
    "- heading 简短自然，不要超过 18 个汉字，不要用编号前缀；各小节标题风格要有区分，避免读起来像同一模板换词。",
    "- **禁止**与「仅多/少一个『的』、或仅标点差异」的同义标题；若证据高度重叠，宁可把信息写进同一段，不要拆成两个雷同标题。",
    "- summary 2-4 条即可，每条一句、尽量短（约 15-40 字），不要写成提纲编号。",
    "- paragraphs 2-4 段即可，宁短勿滥：每段约 80-200 字，只写与子问题最相关的信息，不必面面俱到。",
    "- 不要为凑段数重复观点；段落之间衔接自然，避免套话。",
    "- sources 至少 2 条 URL，必须来自证据要点里出现过的 URL（写入 JSON 供系统校验用；合并成报告时不会逐段展示）。",
    "- 不要输出 Markdown，不要输出多余解释。",
    "",
    ...topicAndSubquestionLinesForAgent(topic, qid, question),
    `关键词：${keywords.join(" / ")}`,
    "",
    "证据要点（每条含 claim/support/url）：",
    ...evidence.map((b, i) => `${i + 1}. claim=${b.claim} | support=${b.support} | url=${b.url}`)
  ].join("\n");

  const messages = [
    { role: "system", content: "你是写作智能体，只输出 JSON；内容要简洁口语，禁止灌水拉长。" },
    { role: "user", content: prompt }
  ];

  // lazy import to avoid circular deps surprises
  const { chatWithRetry } = await import("./llmChat.js");
  const { compactLlmMessages } = await import("./llmTraceMessages.js");

  const attempts = Number.isFinite(jsonAttempts) ? Math.max(1, Math.min(5, Math.floor(jsonAttempts))) : 3;
  const chatRetries = Number.isFinite(llmRetries) ? Math.max(1, Math.min(8, Math.floor(llmRetries))) : 4;
  for (let i = 0; i < attempts; i++) {
    trace?.({
      type: "action",
      stage: "writing",
      agent: "Writer",
      payload: { subquestionId: qid, attempt: i + 1, llmMessages: compactLlmMessages(messages) }
    });
    const raw = await chatWithRetry({
      llmClient,
      messages,
      temperature: 0.2,
      maxTokens,
      retries: chatRetries,
      trace,
      stage: "writing",
      agent: "Writer",
      meta: { subquestionId: qid, attempt: i + 1 }
    });
    trace?.({
      type: "observation",
      stage: "writing",
      agent: "Writer",
      payload: { subquestionId: qid, attempt: i + 1, raw }
    });

    const jsonText = extractFirstJsonObject(raw) || raw;
    const parsed = safeJsonParse(jsonText);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") continue;

    const v = parsed.value;
    if (typeof v.heading !== "string" || !v.heading.trim()) continue;
    if (!Array.isArray(v.summary) || v.summary.length < 2) continue;
    if (!Array.isArray(v.paragraphs) || v.paragraphs.length < 2) continue;
    if (!Array.isArray(v.sources)) continue;
    const sources = v.sources
      .map((x) => String(x || "").trim())
      .filter((x) => x.startsWith("http"))
      .slice(0, 6);
    const allowed = new Set(fallbackSources);
    const boundedSources = sources.filter((u) => allowed.has(u));
    const finalSources = boundedSources.length ? boundedSources : fallbackSources;
    if (!finalSources.length) continue;
    return {
      heading: String(v.heading).trim(),
      summary: v.summary.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 5),
      paragraphs: v.paragraphs.map((p) => String(p || "").trim()).filter(Boolean).slice(0, 5),
      sources: finalSources
    };
  }
  throw new Error(`writer_json_parse_failed:${qid}`);
}

/** 拼进正文前去掉句末标点，避免「。。」「。；」叠用 */
function stripTrailingCnPunct(s) {
  return String(s || "")
    .trim()
    .replace(/[。；、，,]+$/u, "")
    .trim();
}

export function renderReportMarkdown({ topic, plan, sections, overview, conclusion }) {
  const planTitle = plan?.title != null ? String(plan.title).trim() : "";
  const title = (planTitle || displayTopicForReport(topic)).trim() || "研究报告";
  const lines = [`# ${title}`, ""];

  if (typeof overview === "string" && overview.trim()) {
    lines.push(overview.trim(), "");
  }

  for (const s of sections || []) {
    const h = String(s.heading || "").trim();
    // 不用 ## 级标题，避免整篇像「目录式」多枚大标题；用正文级加粗作小节提示即可
    if (h) lines.push(`**${h}**`, "");
    if (Array.isArray(s.summary) && s.summary.length) {
      const parts = s.summary.map((b) => stripTrailingCnPunct(b)).filter(Boolean);
      if (parts.length) {
        const body = parts.join(" ").replace(/\s+/g, " ").trim();
        const endOk = /[。！？…」』]$/.test(body);
        lines.push(endOk ? body : `${body}。`, "");
      }
    }
    for (const p of Array.isArray(s.paragraphs) ? s.paragraphs : []) {
      const t = String(p || "").trim();
      if (t) lines.push(t, "");
    }
  }

  if (typeof conclusion === "string" && conclusion.trim()) {
    lines.push("---", "", conclusion.trim(), "");
  }

  lines.push("", "*以上内容由模型根据检索材料生成，可能存在疏漏，重要事实请自行核对原始材料。*");

  return lines.join("\n");
}

