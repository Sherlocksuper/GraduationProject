import { KimiClient } from "./kimiClient.js";

export function createLLMClientFromEnv() {
  const provider = String(process.env.LLM_PROVIDER || "none").toLowerCase();
  if (provider !== "kimi" && provider !== "moonshot") return null;

  const apiKey = process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY;
  const baseUrl = process.env.KIMI_BASE_URL || process.env.MOONSHOT_BASE_URL;
  const model = process.env.KIMI_MODEL || process.env.MOONSHOT_MODEL;

  return new KimiClient({
    apiKey,
    baseUrl: baseUrl || undefined,
    model: model || undefined
  });
}

