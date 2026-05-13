import { formatLlmMessagesForHint } from "./llmTraceMessages.js";

function trunc(s, n = 420) {
  const t = String(s ?? "").trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n - 12)}…（截断）`;
}

/** 从 trace payload 取出已序列化的 messages 并格式化为可读文本（不含 guard；由调用方 guard） */
function payloadLlmInputBlock(p) {
  if (!p || typeof p !== "object") return "";
  if (!Array.isArray(p.llmMessages) || !p.llmMessages.length) return "";
  return formatLlmMessagesForHint(p.llmMessages);
}

/** 流程图悬浮等详情：默认完整展示；仅防止极端大字段（可调 RESEARCH_PIPELINE_HINT_MAX_CHARS） */
function hintMaxChars() {
  const n = Number(process.env.RESEARCH_PIPELINE_HINT_MAX_CHARS);
  if (Number.isFinite(n) && n >= 50_000) return Math.min(Math.floor(n), 5_000_000);
  return 800_000;
}

function guardHoverText(s, max = hintMaxChars()) {
  const t = String(s ?? "");
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n\n…（已超过单字段上限 ${max} 字符；可设置环境变量 RESEARCH_PIPELINE_HINT_MAX_CHARS 提高）`;
}

function payloadLine(p) {
  if (!p || typeof p !== "object") return "—";
  const llmBlock = payloadLlmInputBlock(p);
  if (llmBlock) {
    const metaBits = [];
    if (p.attempt != null) metaBits.push(`attempt=${p.attempt}`);
    if (p.kind) metaBits.push(`kind=${p.kind}`);
    if (p.subquestionId) metaBits.push(`subquestion=${p.subquestionId}`);
    if (p.fix) metaBits.push(`fix=${p.fix}`);
    if (p.id != null && String(p.id).trim() && !p.subquestionId) metaBits.push(`id=${p.id}`);
    if (p.msg && metaBits.length < 3) metaBits.push(String(p.msg).slice(0, 120));
    const head = metaBits.length ? `【${metaBits.join(" · ")}】\n\n` : "";
    return guardHoverText(`${head}【发给模型的 messages】\n\n${llmBlock}`);
  }
  if (p.note === "kb_retrieve_ok" && Array.isArray(p.kbPreview)) {
    const lines = [
      `知识库向量检索：命中 ${p.kbHits ?? p.kbPreview.length} 条` + (p.query ? ` | 查询：${String(p.query)}` : "")
    ];
    p.kbPreview.slice(0, 10).forEach((row, i) => {
      lines.push(
        `  ${i + 1}. ${String(row.title || "")} | score=${Number(row.ragScore || 0).toFixed(4)} | 约${row.textChars ?? "?"}字`
      );
      lines.push(`     ${String(row.url || "")}`);
    });
    return guardHoverText(lines.join("\n"));
  }
  if (p.note === "kb_retrieve_failed") return guardHoverText(`知识库检索失败：${p.error}`);
  if (p.note === "kb_retrieve_empty") return guardHoverText(`知识库检索：0 条命中 | 查询：${String(p.query || "")}`);
  if (p.msg && String(p.msg).includes("Skip web search")) {
    return guardHoverText(
      `跳过联网检索：${p.msg}（kbCount=${p.kbCount ?? "—"} kbAvgScore=${p.kbAvgScore ?? "—"}）`
    );
  }
  if (typeof p.resultCount === "number" && (Array.isArray(p.resultsPreview) || Array.isArray(p.urls))) {
    const lines = [
      `联网检索：${p.resultCount} 条 | 知识库文档数 kbDocCount=${p.kbDocCount ?? "—"} | skipWeb=${p.skipWeb} | 渠道 ${p.provider || "—"}`
    ];
    (p.resultsPreview || []).slice(0, 6).forEach((r, i) => {
      lines.push(`  ${i + 1}. ${String(r.title || "")}`);
      lines.push(`     ${String(r.url || "")}`);
      if (r.snippet) lines.push(`     摘要：${String(r.snippet)}`);
      if (r.source) lines.push(`     来源：${r.source}`);
    });
    if ((!p.resultsPreview || !p.resultsPreview.length) && Array.isArray(p.urls)) {
      p.urls.slice(0, 8).forEach((u, i) => lines.push(`  ${i + 1}. ${String(u)}`));
    }
    return guardHoverText(lines.join("\n"));
  }
  if (p.url && (String(p.error || "").trim() || p.chars != null || p.via || p.note)) {
    const bits = [`页面：${String(p.url)}`];
    if (p.chars != null) bits.push(`约 ${p.chars} 字`);
    if (p.via) bits.push(`via=${p.via}`);
    if (p.note) bits.push(`note=${p.note}`);
    if (p.error) bits.push(`错误：${String(p.error)}`);
    return guardHoverText(bits.join(" | "));
  }
  if (p.raw != null && String(p.raw).trim() !== "") {
    const head = [p.kind, p.subquestionId, p.attempt != null ? `attempt=${p.attempt}` : "", p.msg ? String(p.msg).slice(0, 120) : ""]
      .filter(Boolean)
      .join(" · ");
    return guardHoverText(head ? `【${head}】\n\n${String(p.raw)}` : String(p.raw));
  }
  if (p.msg) return guardHoverText(p.msg);
  if (p.error) return guardHoverText(`错误：${p.error}`);
  if (p.query) return guardHoverText(`检索：${p.query}`);
  if (p.url) return guardHoverText(`页面：${p.url}`);
  if (typeof p.resultCount === "number") return `检索命中 ${p.resultCount} 条`;
  try {
    return guardHoverText(JSON.stringify(p));
  } catch {
    return "—";
  }
}

function escapeMermaidLabel(s) {
  return String(s || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "#quot;")
    .replace(/\n/g, " ")
    .replace(/[\[\]]/g, " ")
    .trim()
    .slice(0, 72);
}

function payloadObj(e) {
  return e?.payload && typeof e.payload === "object" ? e.payload : {};
}

/** 某 stage 下按 trace 顺序首次出现的 subquestionId（可过滤 agent） */
function orderedSubquestionIds(events, stage, agentExact) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    if (String(e?.stage || "") !== stage) continue;
    if (agentExact && String(e?.agent || "") !== agentExact) continue;
    const qid = String(payloadObj(e).subquestionId || "").trim();
    if (!qid || seen.has(qid)) continue;
    seen.add(qid);
    out.push(qid);
  }
  return out;
}

function hasStage(events, stage) {
  return events.some((e) => String(e?.stage || "") === stage);
}

function hintObj(title, inputSummary, outputSummary) {
  const max = hintMaxChars();
  return {
    title: title ? String(title) : "",
    inputSummary: guardHoverText(String(inputSummary || "—"), max),
    outputSummary: guardHoverText(String(outputSummary || "—"), max)
  };
}

/** @param {Array<{ stage?: string, laneQid?: string, agent?: string, inputSummary?: string, outputSummary?: string }>} traceNodes */
function aggregateSpan(traceNodes, pred) {
  const m = traceNodes.filter(pred);
  if (!m.length) return hintObj("", "（无对应 trace 明细）", "—");
  const first = m[0];
  const last = m[m.length - 1];
  const prefix = m.length > 1 ? `该块聚合 ${m.length} 条 trace。\n` : "";
  return hintObj("", first.inputSummary || "—", prefix + (last.outputSummary || "—"));
}

function matchCollectQ(e, qid) {
  if (String(e?.stage || "") !== "collecting") return false;
  if (qid == null || String(qid).trim() === "") return true;
  return String(payloadObj(e).subquestionId || "").trim() === String(qid).trim();
}

function collectingInputFromEvents(events, qid) {
  for (const e of events) {
    if (!matchCollectQ(e, qid)) continue;
    const p = payloadObj(e);
    if (String(e?.agent) === "Researcher" && String(e?.type) === "action" && p.query) {
      return `本子问题检索用查询（由子问题句 / 关键词拼接）：\n${p.query}`;
    }
  }
  return "（未找到 Researcher 的检索 action；可能为旧版 trace）";
}

function collectingOutputFromEvents(events, qid) {
  const blocks = [];
  for (const e of events) {
    if (!matchCollectQ(e, qid)) continue;
    const p = payloadObj(e);
    const agent = String(e?.agent || "");
    const typ = String(e?.type || "");

    if (p.note === "kb_retrieve_ok" && Array.isArray(p.kbPreview)) {
      const lines = [
        `【知识库向量检索】共 ${p.kbHits ?? p.kbPreview.length} 条命中` + (p.query ? `\n查询：${p.query}` : "")
      ];
      p.kbPreview.slice(0, 12).forEach((row, i) => {
        lines.push(`  ${i + 1}. ${String(row.title || "")}`);
        lines.push(`     score=${Number(row.ragScore || 0).toFixed(4)} · 正文约 ${row.textChars ?? "?"} 字`);
        lines.push(`     ${String(row.url || "")}`);
      });
      blocks.push(lines.join("\n"));
    } else if (p.note === "kb_retrieve_failed") {
      blocks.push(`【知识库检索】失败：${p.error || "unknown"}`);
    } else if (p.note === "kb_retrieve_empty") {
      blocks.push(`【知识库向量检索】0 条命中\n查询：${p.query || "—"}`);
    }

    if (p.msg && String(p.msg).includes("Skip web search")) {
      const avg =
        p.kbAvgScore != null && Number.isFinite(Number(p.kbAvgScore))
          ? Number(p.kbAvgScore).toFixed(4)
          : "—";
      blocks.push(
        `【联网检索】跳过\n${p.msg}\nkbCount=${p.kbCount ?? "—"} kbAvgScore=${avg}`
      );
    }

    if (typeof p.resultCount === "number" && (Array.isArray(p.resultsPreview) || Array.isArray(p.urls))) {
      const lines = [
        `【联网检索】返回 ${p.resultCount} 条`,
        `知识库侧文档数 kbDocCount=${p.kbDocCount ?? "—"} | skipWeb=${p.skipWeb} | 渠道 ${p.provider || "—"}`
      ];
      (p.resultsPreview || []).slice(0, 8).forEach((r, i) => {
        lines.push(`  ${i + 1}. ${String(r.title || "")}`);
        lines.push(`     ${String(r.url || "")}`);
        if (r.snippet) lines.push(`     摘要：${String(r.snippet)}`);
        if (r.source) lines.push(`     搜索源：${r.source}`);
      });
      if ((!p.resultsPreview || !p.resultsPreview.length) && Array.isArray(p.urls)) {
        lines.push("URL 列表：");
        p.urls.slice(0, 10).forEach((u, i) => lines.push(`  ${i + 1}. ${String(u)}`));
      }
      blocks.push(lines.join("\n"));
    }

    if (agent === "Fetcher" && typ === "action" && p.url) {
      blocks.push(`【页面抓取·开始】${p.url}`);
    }
    if (agent === "Fetcher" && typ === "observation" && p.url) {
      const bits = [`【页面抓取·结果】${p.url}`];
      if (p.chars != null) bits.push(`正文约 ${p.chars} 字`);
      if (p.via) bits.push(`via=${p.via}`);
      if (p.note) bits.push(`note=${p.note}`);
      if (p.error) bits.push(`错误：${String(p.error)}`);
      blocks.push(bits.join(" | "));
    }
  }
  const out = blocks.length ? blocks.join("\n\n") : "（本段暂无结构化检索/抓取明细；若为旧任务可能没有知识库命中明细）";
  return out;
}

function collectingLaneHint(events, qid, title) {
  return hintObj(title, collectingInputFromEvents(events, qid), collectingOutputFromEvents(events, qid));
}

function collectingMcgenOutput(events) {
  const order = orderedSubquestionIds(events, "collecting");
  if (order.length) {
    return order.map((q) => `═══ 子问题 ${q} ═══\n${collectingOutputFromEvents(events, q)}`).join("\n\n");
  }
  return collectingOutputFromEvents(events, null);
}

function planningDetailFromEvents(events) {
  const lines = [];
  for (const e of events) {
    if (String(e?.stage || "") !== "planning") continue;
    const p = payloadObj(e);
    lines.push(`[${e?.type}/${e?.agent}] ${payloadLine(p)}`);
  }
  return lines.join("\n") || "—";
}

function matchReadQ(e, qid) {
  if (String(e?.stage || "") !== "reading") return false;
  if (qid == null || String(qid).trim() === "") return true;
  return String(payloadObj(e).subquestionId || "").trim() === String(qid).trim();
}

function readingLaneInputFromEvents(events, qid) {
  const blocks = [];
  for (const e of events) {
    if (!matchReadQ(e, qid)) continue;
    if (String(e?.agent) !== "Reader" || String(e?.type) !== "action") continue;
    const p = payloadObj(e);
    const block = payloadLlmInputBlock(p);
    if (!block) continue;
    const tag = p.attempt != null ? `第 ${p.attempt} 次调用` : "调用";
    blocks.push(`【Reader · ${tag} · 送入模型的完整 messages】\n\n${block}`);
  }
  if (blocks.length) return guardHoverText(blocks.join("\n\n════════════\n\n"));
  return "（该任务 trace 中未记录 Reader 的 llmMessages，可能为升级前产生的旧数据。）\n\n语义上：输入来自「收集」阶段为本子问题合并的网页/KB 正文，加上主题与子问题句，构成 Reader 的 user 消息。";
}

function readingLaneOutputFromEvents(events, qid) {
  const lines = [];
  for (const e of events) {
    if (!matchReadQ(e, qid)) continue;
    const p = payloadObj(e);
    const agent = String(e?.agent || "");
    const typ = String(e?.type || "");
    if (agent === "Reader" && typ === "action") {
      lines.push(`【Reader 调用】第 ${p.attempt ?? "?"} 次尝试 · 送入来源条数 sourceCount=${p.sourceCount ?? "?"}`);
    }
    if (agent === "Reader" && typ === "observation" && p.raw != null) {
      lines.push(`【模型原始输出】\n${String(p.raw)}`);
    }
    if (agent === "Coordinator" && (p.fallback || p.error)) {
      lines.push(`【Reader 降级 / 异常】${p.error || ""} ${p.fallback || ""} bulletCount=${p.bulletCount ?? "—"}`);
    }
  }
  return lines.join("\n\n") || "—";
}

function readingLaneHint(events, qid, title) {
  return hintObj(title, readingLaneInputFromEvents(events, qid), readingLaneOutputFromEvents(events, qid));
}

function matchWriteQ(e, qid) {
  if (String(e?.stage || "") !== "writing") return false;
  if (qid == null || String(qid).trim() === "") return true;
  return String(payloadObj(e).subquestionId || "").trim() === String(qid).trim();
}

function writingLaneInputFromEvents(events, qid) {
  const blocks = [];
  for (const e of events) {
    if (!matchWriteQ(e, qid)) continue;
    if (String(e?.agent) !== "Writer" || String(e?.type) !== "action") continue;
    const p = payloadObj(e);
    const block = payloadLlmInputBlock(p);
    if (!block) continue;
    const tag = p.attempt != null ? `第 ${p.attempt} 次调用` : "调用";
    blocks.push(`【Writer · ${tag} · 送入模型的完整 messages】\n\n${block}`);
  }
  if (blocks.length) return guardHoverText(blocks.join("\n\n════════════\n\n"));
  return "（该任务 trace 中未记录 Writer 的 llmMessages，可能为升级前产生的旧数据。）\n\n语义上：Reader 产出的证据要点 bullets + 主题/子问题/关键词 → Writer 的 user 消息。";
}

function writingLaneOutputFromEvents(events, qid) {
  const lines = [];
  for (const e of events) {
    if (!matchWriteQ(e, qid)) continue;
    const p = payloadObj(e);
    const agent = String(e?.agent || "");
    const typ = String(e?.type || "");
    if (agent === "Writer" && typ === "action") {
      lines.push(`【Writer 调用】第 ${p.attempt ?? "?"} 次尝试`);
    }
    if (agent === "Writer" && typ === "observation" && p.raw != null) {
      lines.push(`【Writer 模型输出】\n${String(p.raw)}`);
    }
    if (agent === "Coordinator" && typ === "decision" && String(p.msg || "").includes("Section drafted")) {
      const src = Array.isArray(p.sources) ? p.sources : [];
      lines.push(
        `【小节已定稿】${p.msg || ""}\n引用来源（前几条）：\n${src
          .slice(0, 6)
          .map((u, i) => `  ${i + 1}. ${String(u)}`)
          .join("\n")}`
      );
    }
    if (agent === "Coordinator" && (p.fallback || p.error) && typ === "observation") {
      lines.push(`【Writer 降级】${p.error || ""} ${p.fallback || ""}`);
    }
  }
  return lines.join("\n\n") || "—";
}

function writingLaneHint(events, qid, title) {
  return hintObj(title, writingLaneInputFromEvents(events, qid), writingLaneOutputFromEvents(events, qid));
}

function integratingInputFromEvents(events) {
  const blocks = [];
  for (const e of events) {
    if (String(e?.stage) !== "writing" || String(e?.agent) !== "Coordinator") continue;
    if (String(e?.type) !== "action") continue;
    const p = payloadObj(e);
    const block = payloadLlmInputBlock(p);
    if (!block) continue;
    const label = [p.kind, p.msg].filter(Boolean).join(" · ") || "Coordinator LLM";
    blocks.push(`【${label}】\n\n${block}`);
  }
  if (blocks.length) return guardHoverText(blocks.join("\n\n════════════\n\n"));
  return "（未记录摘要/结论节点的 llmMessages，可能为旧 trace。）语义：各小节已定稿要点 → Coordinator 生成综述与结尾。";
}

function integrateDetailFromEvents(events) {
  const lines = [];
  for (const e of events) {
    if (String(e?.stage || "") !== "writing" || String(e?.agent || "") !== "Coordinator") continue;
    const p = payloadObj(e);
    const msg = String(p.msg || "").toLowerCase();
    const kind = String(p.kind || "").toLowerCase();
    const hit =
      msg.includes("overview") ||
      msg.includes("conclusion") ||
      kind === "overview" ||
      kind === "conclusion" ||
      msg.includes("结论") ||
      msg.includes("摘要") ||
      String(p.msg || "").includes("总括");
    if (!hit) continue;
    if (String(e?.type) === "action" && Array.isArray(p.llmMessages) && p.llmMessages.length) {
      lines.push(`[${e?.type}] ${p.msg || p.kind || "LLM 调用"}（完整 messages 已列在本节点「输入」）`);
      continue;
    }
    lines.push(`[${e?.type}] ${payloadLine(p)}`);
  }
  return lines.join("\n\n") || "—";
}

function reviewingDetailFromEvents(events) {
  const lines = [];
  for (const e of events) {
    if (String(e?.stage || "") !== "reviewing") continue;
    lines.push(`[${e?.type}/${e?.agent}] ${payloadLine(payloadObj(e))}`);
  }
  return lines.join("\n\n") || "—";
}

function reviewingInputFromEvents(events) {
  const blocks = [];
  for (const e of events) {
    if (String(e?.stage) !== "reviewing") continue;
    if (String(e?.type) !== "action") continue;
    const p = payloadObj(e);
    const block = payloadLlmInputBlock(p);
    if (!block) continue;
    const who = String(e?.agent || "Agent");
    const label = p.fix || p.msg || "action";
    blocks.push(`【${who} · ${label}】\n\n${block}`);
  }
  if (blocks.length) return guardHoverText(blocks.join("\n\n════════════\n\n"));
  return "（本阶段带 llmMessages 的 action 未出现，可能为旧 trace 或未走 Critic 改写分支。）语义：对已生成小节与来源做规则检查，必要时触发补搜或向模型下发改写 prompt。";
}

function doneDetailFromEvents(events) {
  const lines = [];
  for (const e of events) {
    if (String(e?.type || "") === "final" || String(e?.stage || "") === "done") {
      lines.push(`[${e?.type}/${e?.agent}] ${payloadLine(payloadObj(e))}`);
    }
  }
  return lines.join("\n") || "—";
}

/**
 * 按阶段与子问题 id 生成「扇出—汇聚」叙事图（与实现上顺序执行无关，表达多子问题可并行结构）。
 * @param {Array<{ ts?: string, stage?: string, agent?: string, type?: string, payload?: unknown }>} events
 * @param {string} topicSnap
 */
function buildNarrativeMermaid(events, topicSnap) {
  const lines = ["flowchart TD"];
  const topic = escapeMermaidLabel(trunc(String(topicSnap || "").trim(), 56)) || "课题";
  lines.push(`  Mstart(["${topic}"])`);
  let prev = "Mstart";

  if (hasStage(events, "planning")) {
    lines.push(`  Mplan["Coordinator · 规划子问题"]`);
    lines.push(`  ${prev} --> Mplan`);
    prev = "Mplan";
  }

  const qCollect = orderedSubquestionIds(events, "collecting");
  if (hasStage(events, "collecting")) {
    if (qCollect.length >= 2) {
      lines.push(`  Mcfork{并行 · 子问题检索与抓取}`);
      lines.push(`  ${prev} --> Mcfork`);
      lines.push(`  Mcjoin([汇聚])`);
      qCollect.forEach((q, i) => {
        const id = `Mclane${i}`;
        lines.push(`  ${id}["收集 · ${escapeMermaidLabel(q)}"]`);
        lines.push(`  Mcfork --> ${id}`);
        lines.push(`  ${id} --> Mcjoin`);
      });
      prev = "Mcjoin";
    } else if (qCollect.length === 1) {
      lines.push(`  Mcone["收集 · ${escapeMermaidLabel(qCollect[0])}"]`);
      lines.push(`  ${prev} --> Mcone`);
      prev = "Mcone";
    } else {
      lines.push(`  Mcgen["收集来源（检索 / 抓取）"]`);
      lines.push(`  ${prev} --> Mcgen`);
      prev = "Mcgen";
    }
  }

  const qRead = orderedSubquestionIds(events, "reading", "Reader");
  if (hasStage(events, "reading")) {
    if (qRead.length >= 2) {
      lines.push(`  Mrfork{并行 · Reader 提炼证据}`);
      lines.push(`  ${prev} --> Mrfork`);
      lines.push(`  Mrjoin([汇聚])`);
      qRead.forEach((q, i) => {
        const id = `Mrlane${i}`;
        lines.push(`  ${id}["Reader · ${escapeMermaidLabel(q)}"]`);
        lines.push(`  Mrfork --> ${id}`);
        lines.push(`  ${id} --> Mrjoin`);
      });
      prev = "Mrjoin";
    } else if (qRead.length === 1) {
      lines.push(`  Mrone["Reader · ${escapeMermaidLabel(qRead[0])}"]`);
      lines.push(`  ${prev} --> Mrone`);
      prev = "Mrone";
    } else {
      lines.push(`  Mrgen["阅读证据（LLM）"]`);
      lines.push(`  ${prev} --> Mrgen`);
      prev = "Mrgen";
    }
  }

  const qWrite = orderedSubquestionIds(events, "writing", "Writer");
  if (hasStage(events, "writing")) {
    if (qWrite.length >= 2) {
      lines.push(`  Mwfork{并行 · Writer 各小节}`);
      lines.push(`  ${prev} --> Mwfork`);
      lines.push(`  Mwjoin([汇聚])`);
      qWrite.forEach((q, i) => {
        const id = `Mwlane${i}`;
        lines.push(`  ${id}["Writer · ${escapeMermaidLabel(q)}"]`);
        lines.push(`  Mwfork --> ${id}`);
        lines.push(`  ${id} --> Mwjoin`);
      });
      prev = "Mwjoin";
    } else if (qWrite.length === 1) {
      lines.push(`  Mwone["Writer · ${escapeMermaidLabel(qWrite[0])}"]`);
      lines.push(`  ${prev} --> Mwone`);
      prev = "Mwone";
    } else {
      lines.push(`  Mwgen["写作小节"]`);
      lines.push(`  ${prev} --> Mwgen`);
      prev = "Mwgen";
    }
  }

  const hasIntegrate = events.some((e) => {
    const p = payloadObj(e);
    const msg = String(p.msg || "").toLowerCase();
    return (
      String(e?.stage || "") === "writing" &&
      String(e?.agent || "") === "Coordinator" &&
      (msg.includes("overview") || msg.includes("结论") || msg.includes("摘要") || msg.includes("总括"))
    );
  });
  if (hasIntegrate) {
    lines.push(`  Mint["摘要与总括（Coordinator）"]`);
    lines.push(`  ${prev} --> Mint`);
    prev = "Mint";
  }

  if (hasStage(events, "reviewing")) {
    lines.push(`  Mrev["Critic 审稿与修正"]`);
    lines.push(`  ${prev} --> Mrev`);
    prev = "Mrev";
  }

  if (events.some((e) => String(e?.type || "") === "final" || String(e?.stage || "") === "done")) {
    lines.push(`  Mdone(["完成"])`);
    lines.push(`  ${prev} --> Mdone`);
  }

  const parallelPhases = [];
  if (qCollect.length >= 2) parallelPhases.push("collecting");
  if (qRead.length >= 2) parallelPhases.push("reading");
  if (qWrite.length >= 2) parallelPhases.push("writing");

  /** @type {Record<string, { title: string, inputSummary: string, outputSummary: string }>} */
  const diagramNodeHints = {};

  const topicFull = String(topicSnap || "").trim();
  diagramNodeHints.Mstart = hintObj(
    "课题起点",
    topicFull ? `用户深度研究课题与上文。\n${topicFull}` : "深度研究任务起点。",
    "将课题与约束传递给规划与后续阶段。"
  );

  if (hasStage(events, "planning")) {
    diagramNodeHints.Mplan = hintObj(
      "规划子问题",
      topicFull ? `研究课题与上文：\n${topicFull}` : "研究课题",
      planningDetailFromEvents(events)
    );
  }

  if (hasStage(events, "collecting")) {
    if (qCollect.length >= 2) {
      diagramNodeHints.Mcfork = hintObj(
        "并行扇出",
        "收集阶段结构性分支点。",
        "各子问题可独立执行检索与页面抓取（叙事上并行）；汇聚后再进入阅读。"
      );
      diagramNodeHints.Mcjoin = hintObj("汇聚", "各子问题收集路径汇合。", "进入阅读 / 证据提炼阶段。");
      qCollect.forEach((q, i) => {
        diagramNodeHints[`Mclane${i}`] = collectingLaneHint(events, q, `收集 · ${q}`);
      });
    } else if (qCollect.length === 1) {
      const q = qCollect[0];
      diagramNodeHints.Mcone = collectingLaneHint(events, q, `收集 · ${q}`);
    } else {
      diagramNodeHints.Mcgen = hintObj(
        "收集来源",
        "未带子问题 id 的收集事件汇总；若有多个子问题则按 id 分段列出。",
        collectingMcgenOutput(events)
      );
    }
  }

  if (hasStage(events, "reading")) {
    if (qRead.length >= 2) {
      diagramNodeHints.Mrfork = hintObj(
        "并行扇出",
        "阅读阶段结构性分支点。",
        "各子问题可独立提炼证据要点（叙事上并行）；汇聚后再进入写作。"
      );
      diagramNodeHints.Mrjoin = hintObj("汇聚", "各子问题阅读路径汇合。", "进入 Writer 小节生成阶段。");
      qRead.forEach((q, i) => {
        diagramNodeHints[`Mrlane${i}`] = readingLaneHint(events, q, `Reader · ${q}`);
      });
    } else if (qRead.length === 1) {
      const q = qRead[0];
      diagramNodeHints.Mrone = readingLaneHint(events, q, `Reader · ${q}`);
    } else {
      diagramNodeHints.Mrgen = hintObj(
        "阅读证据",
        readingLaneInputFromEvents(events, null),
        readingLaneOutputFromEvents(events, null)
      );
    }
  }

  if (hasStage(events, "writing")) {
    if (qWrite.length >= 2) {
      diagramNodeHints.Mwfork = hintObj(
        "并行扇出",
        "写作阶段结构性分支点。",
        "各子问题可独立生成小节（叙事上并行）；汇聚后再做总括与审稿。"
      );
      diagramNodeHints.Mwjoin = hintObj("汇聚", "各子问题写作路径汇合。", "进入摘要、结论与 Critic 等步骤。");
      qWrite.forEach((q, i) => {
        diagramNodeHints[`Mwlane${i}`] = writingLaneHint(events, q, `Writer · ${q}`);
      });
    } else if (qWrite.length === 1) {
      const q = qWrite[0];
      diagramNodeHints.Mwone = writingLaneHint(events, q, `Writer · ${q}`);
    } else {
      diagramNodeHints.Mwgen = hintObj(
        "写作小节",
        writingLaneInputFromEvents(events, null),
        writingLaneOutputFromEvents(events, null)
      );
    }
  }

  if (hasIntegrate) {
    diagramNodeHints.Mint = hintObj(
      "摘要与总括",
      integratingInputFromEvents(events),
      integrateDetailFromEvents(events)
    );
  }

  if (hasStage(events, "reviewing")) {
    diagramNodeHints.Mrev = hintObj("Critic 审稿", reviewingInputFromEvents(events), reviewingDetailFromEvents(events));
  }

  if (events.some((e) => String(e?.type || "") === "final" || String(e?.stage || "") === "done")) {
    diagramNodeHints.Mdone = hintObj("完成", "流水线正常结束。", doneDetailFromEvents(events));
  }

  return { mermaid: lines.join("\n"), parallelPhases, diagramNodeHints };
}

function buildLinearDiagramHints(nodes, cap) {
  const sub = nodes.length > cap ? nodes.slice(0, cap) : nodes;
  /** @type {Record<string, { title: string, inputSummary: string, outputSummary: string }>} */
  const hints = {};
  for (const n of sub) {
    hints[n.id] = hintObj(`${n.agent} / ${n.stage} / ${n.type}`, n.inputSummary, n.outputSummary);
  }
  if (nodes.length > cap) {
    hints.Ntrunc = hintObj(
      "截断说明",
      `完整 trace 共 ${nodes.length} 步。`,
      `线性流程图仅展示前 ${cap} 步；其余步骤未出现在图中，可拉取原始 trace 查看。`
    );
  }
  return hints;
}

function buildLinearMermaid(nodes, cap) {
  const sub = nodes.length > cap ? nodes.slice(0, cap) : nodes;
  const mermaidLines = ["flowchart TD"];
  sub.forEach((n) => {
    const short = escapeMermaidLabel(`${n.agent}·${n.stage}·${n.type}`);
    mermaidLines.push(`  ${n.id}["${short}"]`);
  });
  for (let i = 1; i < sub.length; i++) {
    mermaidLines.push(`  ${sub[i - 1].id} --> ${sub[i].id}`);
  }
  if (nodes.length > cap) {
    mermaidLines.push(`  Ntrunc["…共 ${nodes.length} 个节点，图中仅展示前 ${cap} 个"]`);
    mermaidLines.push(`  ${sub[sub.length - 1].id} --> Ntrunc`);
  }
  return mermaidLines.join("\n");
}

/**
 * @param {Array<{ ts?: string, stage?: string, agent?: string, type?: string, payload?: unknown }>} trace
 * @param {string} topicSnap
 * @param {{ mermaidNodeCap?: number }} [opts]
 */
export function buildPipelineFromTrace(trace, topicSnap = "", opts = {}) {
  const cap = Math.max(16, Math.min(96, Number(opts.mermaidNodeCap) || 48));
  const arr = Array.isArray(trace) ? trace : [];
  const topic = trunc(String(topicSnap || "").trim(), 200);
  const nodes = arr.map((e, i) => {
    const p = payloadObj(e);
    const prev = i > 0 ? arr[i - 1] : null;
    const prevP = payloadObj(prev);
    const inputSummary =
      i === 0
        ? topic
          ? `课题/上下文摘要：${topic}`
          : "流水线起点（课题由用户消息与上文构成）"
        : `承接上一步：${payloadLine(prevP)}`;
    const outputSummary = payloadLine(p);
    const agent = String(e?.agent || "—").trim();
    const stage = String(e?.stage || "—").trim();
    const typ = String(e?.type || "—").trim();
    const laneQid = String(p.subquestionId || "").trim() || undefined;
    return {
      id: `n${i}`,
      index: i,
      ts: e?.ts || "",
      stage,
      agent,
      type: typ,
      label: `${agent} / ${stage}`,
      laneQid,
      inputSummary,
      outputSummary,
      payloadJson: trunc(JSON.stringify(p), 1200)
    };
  });

  const edges = [];
  for (let i = 1; i < nodes.length; i++) {
    edges.push({ from: nodes[i - 1].id, to: nodes[i].id });
  }

  const useNarrative =
    arr.length > 0 &&
    (hasStage(arr, "planning") ||
      hasStage(arr, "collecting") ||
      hasStage(arr, "reading") ||
      hasStage(arr, "writing") ||
      hasStage(arr, "reviewing"));

  let mermaid;
  let mermaidTruncated = false;
  let mermaidDiagramKind = "linear";
  let parallelPhases = [];
  let diagramNodeHints = {};

  if (useNarrative) {
    const built = buildNarrativeMermaid(arr, topicSnap);
    mermaid = built.mermaid;
    parallelPhases = built.parallelPhases;
    diagramNodeHints = built.diagramNodeHints || {};
    mermaidDiagramKind = "narrative";
  } else {
    mermaid = buildLinearMermaid(nodes, cap);
    mermaidTruncated = nodes.length > cap;
    diagramNodeHints = buildLinearDiagramHints(nodes, cap);
    mermaidDiagramKind = "linear";
  }

  return {
    topic: topicSnap,
    nodeCount: nodes.length,
    mermaid,
    mermaidTruncated,
    mermaidDiagramKind,
    parallelPhases,
    diagramNodeHints
  };
}
