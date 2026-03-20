import { ToolAgent } from "./agents/toolAgent.js";

function toChatMessages(history) {
  const msgs = Array.isArray(history) ? history : [];
  return msgs
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content }));
}

function extractJsonObject(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

function parseToolMarkup(text) {
  const obj = extractJsonObject(text);
  if (obj && typeof obj === "object") {
    const toolRequests = Array.isArray(obj.tool_requests) ? obj.tool_requests : null;
    const final = typeof obj.final === "string" ? obj.final : null;
    if (!toolRequests || final === null) return { toolRequests: [], final: "", ok: false };
    for (const r of toolRequests) {
      if (!r || typeof r !== "object") return { toolRequests: [], final: "", ok: false };
      if (typeof r.name !== "string" || !r.name.trim()) return { toolRequests: [], final: "", ok: false };
      if ("input" in r && (typeof r.input !== "object" || r.input === null || Array.isArray(r.input))) {
        return { toolRequests: [], final: "", ok: false };
      }
    }
    return { toolRequests, final, ok: true };
  }

  const s = String(text || "");
  const toolRequests = [];
  const re = /<tool>([\s\S]*?)<\/tool>/g;
  let match;
  while ((match = re.exec(s))) {
    const inner = match[1];
    const innerObj = extractJsonObject(inner);
    if (innerObj?.name) {
      toolRequests.push({
        name: innerObj.name,
        input: innerObj.input && typeof innerObj.input === "object" ? innerObj.input : {}
      });
    }
  }
  if (toolRequests.length) return { toolRequests, final: "", ok: true };
  return { toolRequests: [], final: s.trim(), ok: false };
}

export class ReactOrchestrator {
  constructor({ toolRegistry, llmClient, maxIters = 6 }) {
    this.toolRegistry = toolRegistry;
    this.llmClient = llmClient || null;
    this.maxIters = maxIters;
    this.toolAgent = new ToolAgent({ toolRegistry });
  }

  buildSystemPrompt() {
    const tools = (this.toolRegistry?.list?.() || []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema
    }));

    return [
      "你是一个基于 ReAct（Reasoning and Acting）架构的问答助手。注意：ReAct 不是前端框架 React。",
      "你可以在需要时请求系统调用工具。可用工具列表如下（JSON）：",
      JSON.stringify(tools),
      "当你需要调用工具时，你必须只输出一个 JSON 对象，格式严格为：",
      '{"tool_requests":[{"name":"tool_name","input":{}}],"final":""}',
      "当你已经可以直接回答时，你必须只输出一个 JSON 对象，格式严格为：",
      '{"tool_requests":[],"final":"你的最终中文回答"}',
      "不要输出 Markdown、代码块、额外字段或解释性文字。"
    ].join("\n");
  }

  async runIterative({ question, history }) {
    const q = String(question || "").trim();
    const baseMessages = toChatMessages(history);

    const messages = [
      { role: "system", content: this.buildSystemPrompt() },
      ...baseMessages,
      { role: "user", content: q }
    ];

    const allSteps = [];
    const allObservations = [];
    const trace = [];

    for (let i = 0; i < this.maxIters; i += 1) {
      let raw = "";
      let parsed = { ok: false, toolRequests: [], final: "" };
      const traceItem = {
        iter: i + 1,
        ok: false,
        attempts: [],
        tool_requests: [],
        final: "",
        steps: [],
        observations: []
      };
      for (let a = 0; a < 3; a += 1) {
        raw = await this.llmClient.chat({ messages, temperature: 0.2 });
        traceItem.attempts.push(raw);
        parsed = parseToolMarkup(raw);
        if (parsed.ok) break;
        messages.push({
          role: "system",
          content:
            "上次输出不符合要求。请严格只输出一个 JSON 对象，且仅包含 tool_requests 与 final 字段；tool_requests 必须是数组，元素必须包含 name 字段，final 必须是字符串。"
        });
      }
      if (!parsed.ok) {
        trace.push(traceItem);
        return {
          answer: raw.trim(),
          plan: { intent: "iterative_parse_failed", steps: allSteps },
          observations: allObservations,
          trace
        };
      }
      traceItem.ok = true;
      traceItem.tool_requests = parsed.toolRequests;
      traceItem.final = parsed.final;

      const toolRequests = Array.isArray(parsed.toolRequests) ? parsed.toolRequests : [];
      if (!toolRequests.length) {
        const final = String(parsed.final || "").trim();
        trace.push(traceItem);
        return {
          answer: final || "（空响应）",
          plan: { intent: "iterative", steps: allSteps },
          observations: allObservations,
          trace
        };
      }

      const steps = toolRequests.map((r) => ({
        type: "tool",
        toolName: r.name,
        input: r.input && typeof r.input === "object" ? r.input : {}
      }));
      allSteps.push(...steps);
      traceItem.steps = steps;

      const observations = await this.toolAgent.runSteps(steps);
      allObservations.push(...observations);
      traceItem.observations = observations;
      trace.push(traceItem);

      messages.push({
        role: "system",
        content: `工具执行结果（请作为观察并继续思考）：${JSON.stringify(observations)}`
      });
    }

    return {
      answer: `已达到最大迭代次数（${this.maxIters}），请尝试缩小问题范围或减少工具调用。`,
      plan: { intent: "iterative_max_iters", steps: allSteps },
      observations: allObservations,
      trace
    };
  }

  async run({ question, history }) {
    return this.runIterative({ question, history });
  }
}
