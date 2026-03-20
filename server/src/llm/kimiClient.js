export class KimiClient {
  constructor({
    apiKey,
    baseUrl = "https://api.moonshot.cn/v1",
    model = "moonshot-v1-8k",
    timeoutMs = 60_000
  } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  isEnabled() {
    return Boolean(this.apiKey);
  }

  async chat({ messages, temperature = 0.2, maxTokens } = {}) {
    if (!this.apiKey) throw new Error("KIMI_API_KEY is not set");

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: this.model,
          messages: Array.isArray(messages) ? messages : [],
          temperature,
          ...(Number.isFinite(maxTokens) ? { max_tokens: Math.max(1, Math.floor(maxTokens)) } : {})
        }),
        signal: controller.signal
      });

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const msg =
          data?.error?.message || data?.message || `kimi_http_error_${resp.status}`;
        throw new Error(msg);
      }
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) throw new Error("empty_model_output");
      return content.trim();
    } finally {
      clearTimeout(t);
    }
  }
}

