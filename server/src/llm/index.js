import { KimiClient } from "./kimiClient.js";

export function createLLMClientFromEnv() {
  const provider = String(process.env.LLM_PROVIDER || "none").toLowerCase();
  if (provider !== "kimi" && provider !== "moonshot") return null;

  const apiKey = process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY;
  const baseUrl = process.env.KIMI_BASE_URL || process.env.MOONSHOT_BASE_URL;
  const model = process.env.KIMI_MODEL || process.env.MOONSHOT_MODEL;

  const timeoutMs = (() => {
    const v = Number(String(process.env.LLM_CHAT_TIMEOUT_MS ?? "").trim());
    if (!Number.isFinite(v)) return 60_000;
    return Math.max(15_000, Math.min(300_000, Math.floor(v)));
  })();

  return new KimiClient({
    apiKey,
    baseUrl: baseUrl || undefined,
    model: model || undefined,
    timeoutMs
  });
}

