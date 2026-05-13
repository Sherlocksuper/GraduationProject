import { chatWithRetry } from "./llmChat.js";
import { compactLlmMessages } from "./llmTraceMessages.js";

/** 开启整稿通读润色：RESEARCH_GLOBAL_PASS=1|true|yes|on */
export function isGlobalPassEnabled() {
  const v = process.env.RESEARCH_GLOBAL_PASS ?? process.env.RESEARCH_ENABLE_GLOBAL_PASS ?? "";
  const s = String(v).toLowerCase().trim();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

export function globalPassMaxTokens() {
  const n = Number(process.env.RESEARCH_GLOBAL_PASS_MAX_TOKENS);
  if (Number.isFinite(n) && n >= 1024 && n <= 32000) return Math.floor(n);
  return 8192;
}

function globalPassMaxInputChars() {
  const n = Number(process.env.RESEARCH_GLOBAL_PASS_MAX_INPUT_CHARS);
  if (Number.isFinite(n) && n >= 20_000 && n <= 500_000) return Math.floor(n);
  return 120_000;
}

function stripOuterCodeFence(s) {
  let t = String(s || "").trim();
  if (!t.startsWith("```")) return t;
  t = t.replace(/^```[a-zA-Z0-9_-]*\n?/, "");
  t = t.replace(/\n?```\s*$/m, "").trim();
  return t;
}

/**
 * 通读整篇 Markdown，从全局叙事做润色（去重、层次、综述/正文/结论分工等）。
 * 失败或输出明显异常时返回原稿。
 */
export async function polishReportMarkdownFull({
  llmClient,
  topic,
  markdown,
  trace,
  maxTokens
} = {}) {
  const md = String(markdown || "").trim();
  if (!md || !llmClient) return md;

  const maxIn = globalPassMaxInputChars();
  if (md.length > maxIn) {
    trace?.({
      type: "decision",
      stage: "reviewing",
      agent: "GlobalEditor",
      payload: {
        msg: "Global pass skipped",
        reason: "markdown_over_max_input_chars",
        maxInputChars: maxIn,
        len: md.length
      }
    });
    return md;
  }

  const system = [
    "你是研究报告的「总编」型编辑。你将收到一篇由多节拼接而成的 Markdown 一稿。",
    "请从**整篇结构与叙事**通读并修订，目标包括：",
    "- 合并或删减**跨节重复**（同一件事不要在综述、正文、结论里各展开一遍）；综述偏「鸟瞰与主线」，正文承载细节，结论收束不重复堆砌。",
    "- **理顺先后与层次**：让读者能顺着一条主线读下来；避免节与节之间跳跃、同义反复或相互打架的表述。",
    "- **统一语气与术语**（机构名、代号、概念前后一致）。",
    "- 可做**轻度删繁就简**，但**禁止编造**新事实、新数据、新来源；不要添加无法从稿内信息推出的断言。",
    "- **保留**稿内已有的可核对要点（时间、代号、名称等若已出现勿随意抹成空洞套话）。",
    "- 维持 Markdown；保留以 `**小节标题**` 单独成行作小节提示的风格；仅在明显重复或误导时才合并/改写小节标题。",
    "只输出**修订后的完整 Markdown**，不要前言、后记或 markdown 代码围栏。"
  ].join("\n");

  const user = `研究主题：${String(topic || "").trim()}\n\n--- 以下为一稿（请通读并输出修订后的完整 Markdown） ---\n\n${md}`;

  const messages = [
    { role: "system", content: system },
    { role: "user", content: user }
  ];

  const tok = Number.isFinite(Number(maxTokens)) ? Number(maxTokens) : globalPassMaxTokens();

  try {
    trace?.({
      type: "action",
      stage: "reviewing",
      agent: "GlobalEditor",
      payload: { msg: "Global narrative polish (full document)", llmMessages: compactLlmMessages(messages) }
    });
    const raw = await chatWithRetry({
      llmClient,
      messages,
      temperature: 0.12,
      maxTokens: tok,
      retries: 2,
      trace,
      stage: "reviewing",
      agent: "GlobalEditor",
      meta: { kind: "global_polish" }
    });
    let out = stripOuterCodeFence(String(raw || "").trim());
    if (out.length < Math.min(200, md.length * 0.25)) {
      trace?.({
        type: "observation",
        stage: "reviewing",
        agent: "GlobalEditor",
        payload: { msg: "Global pass rejected: output too short", outLen: out.length, draftLen: md.length }
      });
      return md;
    }
    if (md.includes("#") && !/^#\s/m.test(out)) {
      trace?.({
        type: "observation",
        stage: "reviewing",
        agent: "GlobalEditor",
        payload: { msg: "Global pass rejected: lost main heading", outLen: out.length }
      });
      return md;
    }
    trace?.({
      type: "observation",
      stage: "reviewing",
      agent: "GlobalEditor",
      payload: { msg: "Global pass applied", raw: out }
    });
    return out;
  } catch (e) {
    trace?.({
      type: "observation",
      stage: "reviewing",
      agent: "GlobalEditor",
      payload: { msg: "Global pass failed", error: String(e?.message || e || "error") }
    });
    return md;
  }
}
