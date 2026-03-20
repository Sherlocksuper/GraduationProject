import { withRetry } from "./retry.js";

export async function chatWithRetry({
  llmClient,
  messages,
  temperature = 0.2,
  maxTokens,
  retries = 3,
  trace,
  stage = "llm",
  agent = "LLM",
  meta = {}
} = {}) {
  if (!llmClient) throw new Error("llm_not_configured");
  return await withRetry(
    async () => {
      return await llmClient.chat({ messages, temperature, maxTokens });
    },
    {
      retries,
      onRetry: ({ attempt, delayMs, err }) => {
        trace?.({
          type: "decision",
          stage,
          agent,
          payload: {
            ...meta,
            retry: { attempt, delayMs, reason: String(err?.message || err || "error") }
          }
        });
      }
    }
  );
}

