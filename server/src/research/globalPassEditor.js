import { chatWithRetry } from "./llmChat.js";
import { compactLlmMessages } from "./llmTraceMessages.js";
import { coordinatorBriefTopic } from "./topicSubquestionLines.js";

/**
 * 整稿总编默认开启（与 Critic 之后、写入 report.md 前一致）。
 * 关闭请设：RESEARCH_GLOBAL_PASS=0 | false | off | no | disabled
 */
export function isGlobalPassEnabled() {
  const raw = process.env.RESEARCH_GLOBAL_PASS ?? process.env.RESEARCH_ENABLE_GLOBAL_PASS;
  if (raw === undefined || raw === null || String(raw).trim() === "") return true;
  const s = String(raw).toLowerCase().trim();
  if (s === "0" || s === "false" || s === "off" || s === "no" || s === "disabled" || s === "disable") return false;
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

export function globalPassMaxTokens() {
  const n = Number(process.env.RESEARCH_GLOBAL_PASS_MAX_TOKENS);
  if (Number.isFinite(n) && n >= 1024 && n <= 32000) return Math.floor(n);
  return 12288;
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
    "你是研究报告的「总编」型编辑。你将收到一篇由多节拼接而成的 Markdown 一稿（含 `#` 大标题、可选综述、若干 `**小节标题**` 与段落、结尾结论）。",
    "请从**整篇结构与叙事**通读并修订，必须落实：",
    "1) **合并实质重复的小节**：若两个或多个 `**加粗小节标题**` 在讲同一件事（例如「成立时间与代号」与「代号及含义」、或一节问整体另一节只问其中一部分），必须合并为**一节**，只保留**一个**合适的加粗标题与一套段落，删除另一节标题及其重复正文，不要留「改头换面」的第二遍叙述。",
    "2) **综述 / 正文 / 结论分工**：综述只给主线与阅读预期，不要展开正文已写的细节；结论收束观点，不复述各节已写过的同段事实。",
    "3) **理顺顺序与指代**：全文术语、机构名、代号前后一致；避免相邻段落信息打架。",
    "4) **禁止编造**新事实、新数据、新来源；不添加稿内无法支持的新断言。可删冗余，但勿把可核对要点抹成空洞套话。",
    "5) 输出仍为 Markdown：保留顶层 `#` 标题；小节继续用 `**标题**` 单独一行；除合并重复外不要随意新增很多新小节。",
    "只输出**修订后的完整 Markdown**，不要前言、后记或 markdown 代码围栏。"
  ].join("\n");

  const user = `研究主题：${coordinatorBriefTopic(topic)}\n\n--- 以下为一稿（请通读并输出修订后的完整 Markdown） ---\n\n${md}`;

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
      temperature: 0.18,
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
