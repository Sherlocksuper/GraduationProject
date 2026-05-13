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

import { chatWithRetry } from "./llmChat.js";
import { compactLlmMessages } from "./llmTraceMessages.js";

export async function planTopic({ llmClient, topic, trace, maxTokens = 1200, temperature = 0.2 } = {}) {
  if (!llmClient) {
    throw new Error(
      "LLM is not configured. Set LLM_PROVIDER=kimi|moonshot and provide KIMI_API_KEY (or MOONSHOT_API_KEY)."
    );
  }
  const basePrompt = [
    "你是一个研究规划助手（Planner）。你的任务是把用户的研究主题拆解成可执行的研究计划（Query Plan）。",
    "输出必须是严格 JSON，且只包含如下字段：",
    `{
  "title": "string",
  "subquestions": [
    {
      "id": "q1",
      "question": "string",
      "keywords": ["string"],
      "sourceHints": ["string"],
      "priority": 1
    }
  ],
  "acceptance": ["string"]
}`,
    "约束：",
    "- subquestions 数量由主题复杂度决定，**必须为 1～5 个**：单一事实、单点定义、用户已把问题收得很窄时，**只输出 1 个子问题**，不要硬拆成多条；主题面广、证据明显需要多侧面时再增加到 3～5。**禁止**语义重复的两个子问题（例如仅多一个「的」或标点差异的同义提问）。",
    "- **禁止**「整体与局部」式硬拆：例如一节问「X 的成立时间与代号」、另一节只问「X 的代号」——后者信息已被前者包含，应合并为**一条**子问题；同理「A 与 B」与单独「B」不要拆成两问。",
    "- 子问题要**互不重复、角度不同**，且**紧扣用户给出的主题本身**（可写定义、关键事实、不同侧面、对比、数据、人物/机构特色、评价与争议等），由你根据主题**自行设计**最合适的切分方式。",
    "- **禁止**机械套用固定套路：不要按「历史背景 → 现状 → 成就 → 挑战/对策」这种千篇一律的申论结构来凑问题；除非主题确实明显需要其中某一类，才可自然出现，且措辞要具体，不要空洞套话标题。",
    "- 若主题是人物/学校/公司，可写生平节点、学科与科研、招生与校区、社会舆论等**与主题强相关**的具体问题，而不是四个泛化的「背景/现状」。",
    "- 每个 keywords 只给 3 个，尽量短；如适用，至少包含 1 个英文关键词。",
    "- acceptance 只给 2 条，且每条不超过 18 个汉字。",
    "- priority 1 为最高优先级。",
    "- 输出必须完整闭合（所有引号与括号都闭合）。",
    "- 输出长度要短：尽量控制在 900 字符以内（精简措辞）。",
    "- 不要输出 Markdown，不要输出解释文字。",
    "",
    `用户主题：${String(topic || "").trim()}`
  ];

  const attempts = 3;
  for (let i = 0; i < attempts; i++) {
    const messages = [
      { role: "system", content: "你是一个严谨的规划智能体，只输出 JSON。" },
      {
        role: "user",
        content:
          basePrompt.join("\n") +
          (i === 0 ? "" : "\n\n注意：你上一条输出可能被截断或不完整。本次务必更短，并以 `}` 结束。")
      }
    ];

    trace?.({
      type: "action",
      stage: "planning",
      agent: "Planner",
      payload: { attempt: i + 1, llmMessages: compactLlmMessages(messages) }
    });
    const raw = await chatWithRetry({
      llmClient,
      messages,
      temperature,
      maxTokens,
      retries: 4,
      trace,
      stage: "planning",
      agent: "Planner",
      meta: { attempt: i + 1 }
    });
    trace?.({
      type: "observation",
      stage: "planning",
      agent: "Planner",
      payload: { attempt: i + 1, raw }
    });

    const jsonText = extractFirstJsonObject(raw) || raw;
    const parsed = safeJsonParse(jsonText);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") continue;
    const sqs = parsed.value.subquestions;
    if (!Array.isArray(sqs) || sqs.length < 1 || sqs.length > 5) continue;
    return parsed.value;
  }
  throw new Error("planner_json_parse_failed");
}

