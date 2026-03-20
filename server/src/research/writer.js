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

export async function writeSection({ llmClient, topic, subquestion, trace }) {
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
    "重要：你必须优先使用“证据要点”来写作，并在输出中给出来源 URL。",
    "输出必须是严格 JSON，且只包含字段：",
    `{
  "heading": "string",
  "summary": ["string"],
  "paragraphs": ["string"],
  "sources": ["https://..."]
}`,
    "约束：",
    "- heading 简短，不要超过 18 个汉字。",
    "- summary 建议 4-7 条，每条不超过 30 个汉字。",
    "- paragraphs 建议 4-7 段，每段尽量 180-360 汉字（不强制固定字数/段数），写得更“报告化”，避免口号。",
    "- 段落要包含：现状/原因/影响/案例或机制/风险与对策（按子问题取舍）。",
    "- sources 至少 2 条 URL，必须来自证据要点里出现过的 URL。",
    "- 不要输出 Markdown，不要输出多余解释。",
    "",
    `主题：${topic}`,
    `子问题(${qid})：${question}`,
    `关键词：${keywords.join(" / ")}`,
    "",
    "证据要点（每条含 claim/support/url）：",
    ...evidence.map((b, i) => `${i + 1}. claim=${b.claim} | support=${b.support} | url=${b.url}`)
  ].join("\n");

  const messages = [
    { role: "system", content: "你是严谨写作智能体，只输出 JSON。" },
    { role: "user", content: prompt }
  ];

  // lazy import to avoid circular deps surprises
  const { chatWithRetry } = await import("./llmChat.js");

  const attempts = 3;
  for (let i = 0; i < attempts; i++) {
    trace?.({
      type: "action",
      stage: "writing",
      agent: "Writer",
      payload: { subquestionId: qid, attempt: i + 1 }
    });
    const raw = await chatWithRetry({
      llmClient,
      messages,
      temperature: 0.2,
      maxTokens: 900,
      retries: 4,
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
    if (!Array.isArray(v.summary) || v.summary.length < 3) continue;
    if (!Array.isArray(v.paragraphs) || v.paragraphs.length < 3) continue;
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
      summary: v.summary.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 8),
      paragraphs: v.paragraphs.map((p) => String(p || "").trim()).filter(Boolean).slice(0, 10),
      sources: finalSources
    };
  }
  throw new Error(`writer_json_parse_failed:${qid}`);
}

export function renderReportMarkdown({ topic, plan, sections, overview, conclusion }) {
  const title = plan?.title || topic;
  const lines = [
    `# ${title}`,
    "",
    "> 说明：本报告为中期 MVP 自动生成初稿（evidence-based）。当前版本已进行**联网搜索与网页抓取**并在各节末尾给出来源链接；但仍未做严格的多源交叉验证与事实级校验，建议将关键结论进一步核验后再用于正式场景。",
    ""
  ];

  if (typeof overview === "string" && overview.trim()) {
    lines.push("## 摘要", "", overview.trim(), "");
  }

  lines.push("## 目录", "");
  const toc = (sections || []).map((s, idx) => `- ${idx + 1}. ${s.heading}`);
  lines.push(...toc, "", "## 正文", "");

  for (const [idx, s] of (sections || []).entries()) {
    lines.push(`### ${idx + 1}. ${s.heading}`, "");
    if (Array.isArray(s.summary) && s.summary.length) {
      lines.push("要点：");
      for (const b of s.summary) lines.push(`- ${b}`);
      lines.push("");
    }
    for (const p of Array.isArray(s.paragraphs) ? s.paragraphs : []) {
      lines.push(p, "");
    }
    if (Array.isArray(s.sources) && s.sources.length) {
      lines.push("来源：");
      for (const u of s.sources) lines.push(`- ${u}`);
      lines.push("");
    }
  }

  if (typeof conclusion === "string" && conclusion.trim()) {
    lines.push("## 结论", "", conclusion.trim(), "");
  }

  lines.push("## 局限性与下一步", "");
  lines.push(
    "- 本版本已具备联网检索与抓取：后续将加入“多源交叉验证”和更强的信源质量评估（白名单/黑名单/域名权重）。",
    "- 将加入 Critic：自动检查“无证据断言”、冲突观点与一致性，并驱动修订。",
    "- 将加入评测：引用覆盖率、来源多样性、端到端耗时等指标。",
    ""
  );

  return lines.join("\n");
}

