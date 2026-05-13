/**
 * 将 chat/completions 的 messages 压到「估算输入 token」预算内，避免 8k 等模型返回
 * "exceeded model token limit"。估算偏保守（多裁一点），不引入 tiktoken 依赖。
 *
 * 裁减顺序：先丢掉 system 之后最旧的多轮历史；仍超则缩短 system（通常含大块 RAG）。
 */

const DEFAULT_CONTEXT_WINDOW = 8192;
const DEFAULT_MAX_COMPLETION = 2048;
const DEFAULT_OVERHEAD = 280;

function roughMsgTokens(m, charsPerToken) {
  const s = String(m?.content ?? "");
  return Math.ceil(s.length / charsPerToken) + 4;
}

function sumRough(msgs, charsPerToken) {
  let t = 0;
  for (const m of msgs) t += roughMsgTokens(m, charsPerToken);
  return t;
}

function truncateContent(s, maxChars) {
  const str = String(s);
  if (str.length <= maxChars) return str;
  const head = Math.max(0, Math.floor(maxChars * 0.42));
  const tail = Math.max(0, maxChars - head - 72);
  const omitted = str.length - head - tail;
  return `${str.slice(0, head)}\n\n…（已省略约 ${omitted} 字符）…\n\n${str.slice(str.length - tail)}`;
}

/**
 * @param {Array<{ role: string, content: string }>} messages
 * @param {object} [options]
 * @param {number} [options.maxCompletionTokens] 本次请求 max_tokens，参与预算
 * @param {number} [options.contextWindowTokens] 模型上下文上限，可用环境变量 LLM_CONTEXT_WINDOW
 * @param {number} [options.overheadTokens] 消息结构等余量
 * @param {number} [options.charsPerToken] 估算用：每 token 约多少字符（中英混排偏保守用 2）
 * @returns {Array<{ role: string, content: string }>}
 */
export function fitMessagesToContextBudget(messages, options = {}) {
  const maxCompletion = Math.max(
    1,
    Math.floor(Number(options.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION))
  );
  const window = Math.max(
    4096,
    Math.floor(
      Number(options.contextWindowTokens) ||
        Number(process.env.LLM_CONTEXT_WINDOW) ||
        DEFAULT_CONTEXT_WINDOW
    )
  );
  const overhead = Math.max(
    64,
    Math.floor(Number(options.overheadTokens ?? DEFAULT_OVERHEAD))
  );
  const charsPerToken = Math.max(
    1.2,
    Number(options.charsPerToken) ||
      Number(process.env.CHAT_ROUGH_CHARS_PER_TOKEN) ||
      2
  );

  let budget = Math.floor(Number(options.inputTokenBudget));
  if (!Number.isFinite(budget) || budget < 256) {
    budget = window - maxCompletion - overhead;
  }
  budget = Math.max(512, budget);

  const list = (Array.isArray(messages) ? messages : []).map((m) => ({
    role: String(m.role || ""),
    content: String(m.content ?? "")
  }));
  if (!list.length) return list;

  if (sumRough(list, charsPerToken) <= budget) return list;

  const out = list.map((m) => ({ ...m }));
  const hasSystem = out[0]?.role === "system";

  let guard = 0;
  while (sumRough(out, charsPerToken) > budget && guard++ < 500) {
    if (hasSystem && out[0]?.role === "system" && out.length >= 3) {
      out.splice(1, 1);
      continue;
    }
    if (hasSystem && out.length === 2) {
      const ts = roughMsgTokens(out[0], charsPerToken);
      const tu = roughMsgTokens(out[1], charsPerToken);
      if (ts >= tu && out[0].content.length > 240) {
        const target = Math.max(200, Math.floor(out[0].content.length * 0.88));
        out[0] = { ...out[0], content: truncateContent(out[0].content, target) };
      } else if (out[1].content.length > 120) {
        const target = Math.max(100, Math.floor(out[1].content.length * 0.88));
        out[1] = { ...out[1], content: truncateContent(out[1].content, target) };
      } else {
        out[0] = { ...out[0], content: out[0].content.slice(0, Math.max(120, out[0].content.length - 600)) };
      }
      continue;
    }
    if (out.length >= 2) {
      out.splice(0, 1);
      continue;
    }
    const roomChars = Math.max(200, Math.floor(budget * charsPerToken) - 8);
    out[0] = { ...out[0], content: truncateContent(out[0].content, roomChars) };
    break;
  }

  let tail = 0;
  while (sumRough(out, charsPerToken) > budget && tail++ < 120) {
    let idx = 0;
    let maxL = 0;
    for (let i = 0; i < out.length; i++) {
      const L = out[i].content.length;
      if (L > maxL) {
        maxL = L;
        idx = i;
      }
    }
    if (maxL < 64) break;
    const target = Math.max(48, Math.floor(maxL * 0.86));
    out[idx] = { ...out[idx], content: truncateContent(out[idx].content, target) };
  }

  if (process.env.CHAT_CONTEXT_TRIM_DEBUG === "1") {
    const after = sumRough(out, charsPerToken);
    process.stderr.write(
      `[llm-context] trimmed messages roughTokens=${after}/${budget} window=${window} maxCompletion=${maxCompletion}\n`
    );
  }

  return out;
}
