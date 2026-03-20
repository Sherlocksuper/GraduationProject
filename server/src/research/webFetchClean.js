function stripJinaPrefix(text) {
  const s = String(text || "");
  // r.jina.ai 返回常见格式是以若干 meta 行开头，直接保守地去掉连续空行前的短行
  const lines = s.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim().length <= 120) i++;
  return lines.slice(Math.max(0, i - 1)).join("\n").trim() || s.trim();
}

export async function webFetchClean({ url, useJina = true, timeoutMs = 25_000, maxChars = 12_000 } = {}) {
  const u = String(url || "").trim();
  if (!u || !u.startsWith("http")) throw new Error("url must start with http/https");

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (useJina) {
      const proxyUrl = `https://r.jina.ai/${u}`;
      const resp = await fetch(proxyUrl, {
        method: "GET",
        headers: {
          Accept: "text/plain",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
        },
        signal: controller.signal
      });
      const text = await resp.text().catch(() => "");
      if (!resp.ok) throw new Error(`web_fetch_http_${resp.status}`);
      const cleaned = stripJinaPrefix(text);
      return {
        url: u,
        title: "",
        text: cleaned.slice(0, Math.max(1, Number(maxChars) || 12_000)),
        extractedAt: new Date().toISOString(),
        via: "jina"
      };
    }

    // fallback：直接抓 HTML（不做复杂正文提取，中期先能用）
    const resp = await fetch(u, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      },
      signal: controller.signal
    });
    const html = await resp.text().catch(() => "");
    if (!resp.ok) throw new Error(`web_fetch_http_${resp.status}`);
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return {
      url: u,
      title: "",
      text: text.slice(0, Math.max(1, Number(maxChars) || 12_000)),
      extractedAt: new Date().toISOString(),
      via: "direct"
    };
  } finally {
    clearTimeout(t);
  }
}

