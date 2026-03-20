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

export async function planTopic({ llmClient, topic, trace }) {
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
    "- subquestions 数量必须为 6 个，覆盖：背景/现状/案例/争议/趋势/风险。",
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

    const raw = await chatWithRetry({
      llmClient,
      messages,
      temperature: 0.2,
      maxTokens: 1200,
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
    if (!Array.isArray(parsed.value.subquestions) || parsed.value.subquestions.length === 0) continue;
    return parsed.value;
  }
  throw new Error("planner_json_parse_failed");
}

