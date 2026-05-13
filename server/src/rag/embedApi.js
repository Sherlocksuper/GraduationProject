/**
 * 火山引擎方舟（豆包）向量化，仅支持 Ark `api/v3`。
 *
 * 环境变量（必填其一）：
 * - `ARK_API_KEY` 或 `EMBEDDING_API_KEY`：Bearer Token
 * - `EMBEDDING_MODEL`：模型名或推理接入点 `ep-...`（控制台为准）
 * - `EMBEDDING_BASE_URL`：默认 `https://ark.cn-beijing.volces.com/api/v3`（不要带 `/embeddings` 后缀）
 *
 * 文本向量化：`POST {BASE}/embeddings`，body `{ model, input: string[] }`（与方舟 OpenAI 形态一致）。
 *
 * 多模态向量化：`POST {BASE}/embeddings/multimodal`，body 含 `encoding_format` 与结构化 `input`。
 * - 设 `EMBEDDING_USE_MULTIMODAL=1`（或 true）启用；每个文本分块单独请求（`input` 仅一条 `{ type: "text", text }`）。
 * - 可选 `EMBEDDING_ENCODING_FORMAT`（默认 float）
 */

const DEFAULT_ARK_BASE = "https://ark.cn-beijing.volces.com/api/v3";
/** 未配置 EMBEDDING_MODEL 时的占位默认（请在生产环境改为控制台实际模型或 ep-） */
const DEFAULT_ARK_TEXT_MODEL = "doubao-embedding-text-240515";

export function isEmbeddingConfigured() {
  const k = process.env.ARK_API_KEY || process.env.EMBEDDING_API_KEY;
  return Boolean(k?.trim());
}

function arkApiKey() {
  const key = (process.env.ARK_API_KEY || process.env.EMBEDDING_API_KEY || "").trim();
  if (!key) throw new Error("Missing ARK_API_KEY or EMBEDDING_API_KEY（火山方舟 API Key）");
  return key;
}

function embeddingAuthHeaders() {
  return {
    Authorization: `Bearer ${arkApiKey()}`,
    "Content-Type": "application/json"
  };
}

function embeddingBaseUrl() {
  return (process.env.EMBEDDING_BASE_URL || DEFAULT_ARK_BASE).replace(/\/+$/, "");
}

function useMultimodalEmbeddings() {
  const v = (process.env.EMBEDDING_USE_MULTIMODAL || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function embeddingEndpoint() {
  const base = embeddingBaseUrl();
  if (useMultimodalEmbeddings()) {
    return `${base}/embeddings/multimodal`;
  }
  return `${base}/embeddings`;
}

function embeddingModel() {
  return (process.env.EMBEDDING_MODEL || DEFAULT_ARK_TEXT_MODEL).trim();
}

function encodingFormat() {
  return (process.env.EMBEDDING_ENCODING_FORMAT || "float").trim() || "float";
}

/** 从单条 Ark/OpenAI 形态行里取出向量数组（兼容部分 PascalCase 字段） */
function rowToVector(row) {
  if (!row || typeof row !== "object") return null;
  const cand =
    row.embedding ??
    row.Embedding ??
    row.dense_embedding ??
    row.DenseEmbedding ??
    row.dense ??
    row.vector ??
    row.values ??
    row.embedding_vector;
  if (!Array.isArray(cand) || !cand.length) return null;
  return cand.map((x) => Number(x));
}

/**
 * 解析方舟向量化 JSON（兼容标准 `data[]` 与部分多模态/网关变体）。
 * @returns {number[][]}
 */
function vectorsFromArkJson(data, expectedLen, depth = 0) {
  if (depth > 4) {
    throw new Error("embedding_parse_failed: nested Result 过深");
  }
  if (!data || typeof data !== "object") {
    throw new Error("embedding_parse_failed: response is not a JSON object");
  }

  const rows = Array.isArray(data.data) ? data.data : null;
  if (rows && rows.length === expectedLen) {
    rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const out = rows.map((r) => rowToVector(r));
    if (out.every((v) => v && v.length)) return out;
  }

  // `data` 为单对象：{ embedding: [...] }
  if (data.data && typeof data.data === "object" && !Array.isArray(data.data) && expectedLen === 1) {
    const v = rowToVector(data.data);
    if (v) return [v];
  }

  // 顶层一条向量
  const top =
    rowToVector(data) ||
    rowToVector({ embedding: data.embedding }) ||
    rowToVector({ embedding: data.dense_embedding }) ||
    rowToVector({ embedding: data.vector });
  if (top && expectedLen === 1) return [top];

  // `embeddings`: number[][] 或对象数组
  if (Array.isArray(data.embeddings) && data.embeddings.length === expectedLen) {
    const out = data.embeddings.map((item) =>
      Array.isArray(item) && typeof item[0] === "number"
        ? item.map((x) => Number(x))
        : rowToVector(item)
    );
    if (out.every((v) => v && v.length)) return out;
  }

  // 方舟部分接口：`Result` / `result` 包裹
  const wrapped = data.Result ?? data.result ?? data.Response ?? data.response;
  if (wrapped && wrapped !== data) {
    try {
      return vectorsFromArkJson(
        Array.isArray(wrapped.data) ? { data: wrapped.data } : wrapped,
        expectedLen,
        depth + 1
      );
    } catch {
      /* fall through */
    }
  }

  const preview = JSON.stringify(data).slice(0, 480);
  throw new Error(
    `embedding_parse_failed: expected ${expectedLen} vector(s); could not read data[].embedding (preview: ${preview})`
  );
}

async function postEmbedding(bodyStr) {
  const resp = await fetch(embeddingEndpoint(), {
    method: "POST",
    headers: embeddingAuthHeaders(),
    body: bodyStr
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.error?.message || data?.message || `embedding_http_${resp.status}`;
    throw new Error(msg);
  }
  // HTTP 200 但业务错误（部分网关 / 方舟形态）
  if (data?.error) {
    const msg = data.error?.message || data.error?.Message || JSON.stringify(data.error);
    throw new Error(msg);
  }
  if (typeof data?.code === "number" && data.code !== 0) {
    throw new Error(data.message || data.msg || `ark_error_code_${data.code}`);
  }
  return data;
}

/**
 * @param {string[]} inputs 非空字符串数组
 * @returns {Promise<number[][]>} 与 inputs 等长的向量数组
 */
export async function embedTexts(inputs) {
  const list = inputs.map((s) => String(s || "").trim()).filter(Boolean);
  if (!list.length) return [];

  if (useMultimodalEmbeddings()) {
    const vectors = [];
    for (const text of list) {
      const body = JSON.stringify({
        model: embeddingModel(),
        encoding_format: encodingFormat(),
        input: [{ type: "text", text }]
      });
      const data = await postEmbedding(body);
      const rows = vectorsFromArkJson(data, 1);
      vectors.push(rows[0]);
    }
    return vectors;
  }

  const body = JSON.stringify({
    model: embeddingModel(),
    input: list
  });
  const data = await postEmbedding(body);
  return vectorsFromArkJson(data, list.length);
}

/** 单条查询向量 */
export async function embedQuery(text) {
  const [v] = await embedTexts([text]);
  return v;
}
