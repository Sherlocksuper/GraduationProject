function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function flattenRelatedTopics(topics, out) {
  for (const t of Array.isArray(topics) ? topics : []) {
    if (!t) continue;
    if (Array.isArray(t.Topics)) {
      flattenRelatedTopics(t.Topics, out);
      continue;
    }
    const url = t.FirstURL || t.firstURL || t.url;
    const text = t.Text || t.text;
    if (typeof url === "string" && url.startsWith("http")) {
      out.push({ url, title: typeof text === "string" ? text : url });
    }
  }
}

function htmlDecode(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function webSearchBingHtml({ query, topK }) {
  const q = String(query || "").trim();
  const k = Math.max(1, Math.min(10, Number(topK) || 5));
  const url = `https://www.bing.com/search?` + new URLSearchParams({ q, count: String(k) }).toString();
  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      Accept: "text/html"
    }
  });
  const html = await resp.text().catch(() => "");
  if (!resp.ok) throw new Error(`bing_search_http_${resp.status}`);

  const items = [];
  const blocks = html.split(/<li class="b_algo"/g).slice(1);
  for (const b of blocks) {
    const m = b.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!m) continue;
    const href = htmlDecode(m[1]);
    if (!href.startsWith("http")) continue;
    const title = htmlDecode(m[2].replace(/<[^>]+>/g, "").trim());
    const sm = b.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = sm ? htmlDecode(sm[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()) : "";
    items.push({ url: href, title: title || href, snippet, source: "bing" });
    if (items.length >= k) break;
  }
  return items;
}

async function webSearchTavily({ query, topK }) {
  const apiKey = String(process.env.TAVILY_API_KEY || "").trim();
  if (!apiKey) throw new Error("TAVILY_API_KEY is not set");
  const q = String(query || "").trim();
  const k = Math.max(1, Math.min(10, Number(topK) || 5));
  const blockedSites = [
    "zhihu.com",
    "zhuanlan.zhihu.com",
    "baike.baidu.com",
    "wenku.baidu.com",
    "csdn.net",
    "juejin.cn",
    "weixin.qq.com",
    "mp.weixin.qq.com"
  ];

  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      api_key: apiKey,
      query: q,
      search_depth: "basic",
      max_results: k,
      include_answer: false,
      include_raw_content: false,
      include_images: false
    })
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.message || data?.error || `tavily_http_${resp.status}`);
  }

  const results = Array.isArray(data?.results) ? data.results : [];
  const mapped = results
    .map((r) => ({
      url: String(r?.url || "").trim(),
      title: String(r?.title || "").trim(),
      snippet: String(r?.content || "").trim(),
      source: "tavily"
    }))
    .filter((r) => r.url.startsWith("http"))
    .slice(0, k * 2);

  const filtered = mapped.filter((r) => !blockedSites.some((d) => r.url.includes(d)));
  return (filtered.length ? filtered : mapped).slice(0, k);
}

export async function webSearch({ query, topK = 5, safe = "moderate" } = {}) {
  const q = String(query || "").trim();
  if (!q) throw new Error("query is required");

  const provider = String(process.env.SEARCH_PROVIDER || "bing_html").toLowerCase();
  if (provider === "tavily") {
    return await webSearchTavily({ query: q, topK });
  }

  const blockedSites = [
    "zhihu.com",
    "baike.baidu.com",
    "wenku.baidu.com",
    "csdn.net",
    "juejin.cn",
    "weixin.qq.com"
  ];
  const qWithBlock = q + " " + blockedSites.map((s) => `-site:${s}`).join(" ");
  const preferredSites = [
    "arxiv.org",
    "acm.org",
    "ieee.org",
    "microsoft.com",
    "openai.com",
    "cloudflare.com",
    "aws.amazon.com",
    "oreilly.com",
    "martinfowler.com",
    "github.com"
  ];
  const preferClause = "(" + preferredSites.map((s) => `site:${s}`).join(" OR ") + ")";

  // 首选：Bing HTML 抓取（无需 key，且比 DDG Instant Answer 稳定返回 URL）
  try {
    const bing = await webSearchBingHtml({ query: qWithBlock, topK });
    if (bing.length) {
      const filtered = bing.filter((r) => !blockedSites.some((d) => r.url.includes(d)));
      if (filtered.length) return filtered.slice(0, Math.max(1, Number(topK) || 5));
    }
  } catch {
    // ignore
  }

  // fallback：若结果被“反爬站点”污染，强制限定可信站点集合
  try {
    const bingPrefer = await webSearchBingHtml({ query: `${q} ${preferClause}`, topK });
    const filtered = bingPrefer.filter((r) => !blockedSites.some((d) => r.url.includes(d)));
    if (filtered.length) return filtered.slice(0, Math.max(1, Number(topK) || 5));
  } catch {
    // ignore
  }

  const url =
    "https://api.duckduckgo.com/?" +
    new URLSearchParams({
      q,
      format: "json",
      no_redirect: "1",
      no_html: "1",
      skip_disambig: "1",
      t: "deepresearch",
      kp: safe === "strict" ? "1" : "-1"
    }).toString();

  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.message || `web_search_http_${resp.status}`);

  const items = [];
  if (Array.isArray(data?.Results)) {
    for (const r of data.Results) {
      const u = r?.FirstURL;
      const title = r?.Text;
      if (typeof u === "string" && u.startsWith("http")) items.push({ url: u, title: title || u });
    }
  }
  flattenRelatedTopics(data?.RelatedTopics, items);

  const normalized = uniqBy(items, (x) => x.url).slice(0, Math.max(1, Number(topK) || 5));
  const ddg = normalized.map((x) => ({
    url: x.url,
    title: x.title || x.url,
    source: "duckduckgo"
  }));

  if (ddg.length) return ddg;

  return [];
}

