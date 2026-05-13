import "dotenv/config";
import cors from "cors";
import express from "express";
import { createLLMClientFromEnv } from "./llm/index.js";
import { fitMessagesToContextBudget } from "./llm/fitMessagesToContextBudget.js";
import { openDb } from "./db/openDb.js";
import { ChatRepository, normalizeRagCollectionIdsArray } from "./chat/chatRepository.js";
import { RagRepository } from "./rag/ragRepository.js";
import { chunkText } from "./rag/chunkText.js";
import { embedTexts, embedQuery, isEmbeddingConfigured } from "./rag/embedApi.js";
import { ResearchStoreSqlite } from "./research/storeSqlite.js";
import { normalizeResearchRuntime, runResearchTask } from "./research/runner.js";
import { buildPipelineFromTrace } from "./research/pipelineFromTrace.js";
import { UserStore } from "./auth/userStore.js";
import {
  isSmtpConfigured,
  sendLoginCodeEmail,
  sendPasswordResetEmail,
  sendVerificationEmail
} from "./auth/mail.js";
import { requireLogin } from "./auth/middleware.js";
import { bearerToken, signAuthToken, verifyAuthToken } from "./auth/jwt.js";

const app = express();
const llmClient = createLLMClientFromEnv();
const db = openDb();
const chatRepo = new ChatRepository(db);
const ragRepo = new RagRepository(db);
const research = new ResearchStoreSqlite(db);
const users = new UserStore();

/** 登录验证码发送成功后的冷却（按邮箱），毫秒 */
const LOGIN_CODE_COOLDOWN_MS = 60_000;
const loginCodeSentAt = new Map();

/** 同一用户下同一会话仅允许一条在跑的研究（防并发） */
const chatResearchInflight = new Map();

/** 对话中附带知识库检索时的命中条数上限（可被环境变量覆盖） */
const RAG_CHAT_TOPK = Math.max(1, Math.min(16, Number(process.env.RAG_CHAT_TOPK) || 6));

/** 服务端默认 RAG 最低相似度（余弦）；0 表示不启用门槛。请求体 ragMinScore 优先。 */
const RAG_MIN_SCORE_DEFAULT = Math.max(
  0,
  Math.min(0.99, Number(process.env.RAG_MIN_SCORE_DEFAULT) || 0)
);

/**
 * 将「最低相似度」钳到 [0, 0.99]；≤0 表示关闭（不过滤）。
 * @param {unknown} raw
 */
function clampRagMinScore(raw) {
  const x = Number(raw);
  if (!Number.isFinite(x) || x <= 0) return 0;
  return Math.max(0, Math.min(0.99, x));
}

/**
 * 多库合并且已按 score 降序后：若最高分仍低于 floor，则整轮不返回任何命中（与「禁用 RAG」一致）。
 * @param {Array<{ score?: number }>} hitsSortedDesc
 * @param {number} minScore 0 关闭；否则 (0,1]
 */
function applyRagMinScoreFloor(hitsSortedDesc, minScore) {
  const list = Array.isArray(hitsSortedDesc) ? hitsSortedDesc : [];
  const floor = clampRagMinScore(minScore);
  if (floor <= 0) {
    return {
      hits: list,
      suppressed: false,
      bestScore: list.length ? Number(list[0].score) : null
    };
  }
  if (!list.length) {
    return { hits: [], suppressed: false, bestScore: null };
  }
  const best = Number(list[0].score);
  if (!Number.isFinite(best) || best < floor) {
    return { hits: [], suppressed: true, bestScore: best };
  }
  return { hits: list, suppressed: false, bestScore: best };
}

/** 单会话允许绑定的知识库个数上限 */
const RAG_BINDINGS_PER_CHAT_MAX = 16;

/**
 * 对已绑定的一个或多个知识库分别向量检索，按分数合并后取 Top-K。
 * @param {string} username
 * @param {string[]} collectionIds
 * @param {string} question
 * @param {number} topK
 * @param {number} [minScore=0] 最佳命中余弦相似度低于此值时返回空 hits（整轮禁用 RAG）；0 关闭
 * @returns {Promise<{ hits: Array<...>, ragSuppressedByMinScore?: boolean, ragBestScore?: number | null }>}
 */
async function fetchRagHitsForChatMulti(username, collectionIds, question, topK, minScore = 0) {
  const ids = [...new Set(collectionIds.map((x) => String(x || "").trim()).filter(Boolean))];
  if (!ids.length) return { hits: [] };
  if (!isEmbeddingConfigured()) return { hits: [] };
  const qv = await embedQuery(question);
  const per = Math.min(20, Math.max(topK, Math.ceil((topK + ids.length * 2) / Math.max(1, ids.length))));
  const all = [];
  for (const cid of ids) {
    const col = ragRepo.getCollection(username, cid);
    if (!col || !col.chunkCount) continue;
    const part = ragRepo.query(username, cid, qv, per) || [];
    for (const h of part) {
      all.push({
        ...h,
        collectionId: cid,
        collectionName: col.name
      });
    }
  }
  all.sort((a, b) => Number(b.score) - Number(a.score));
  const k = Math.max(1, Math.min(20, Number(topK) || 6));
  const sliced = all.slice(0, k);
  const { hits, suppressed, bestScore } = applyRagMinScoreFloor(sliced, minScore);
  return {
    hits,
    ragSuppressedByMinScore: suppressed,
    ragBestScore: bestScore
  };
}

/**
 * @param {Array<{ rowId?: number, chunkIndex: number, content: string, score: number, collectionName?: string }>} hits
 */
/**
 * 将 RAG 命中转为研究管线中的「伪网页」文档（Reader 仅接受 http(s) URL）。
 * @param {Array<{ rowId?: number, chunkIndex: number, content: string, score: number, collectionId?: string, collectionName?: string }>} hits
 */
function hitsToKbResearchDocs(hits) {
  if (!Array.isArray(hits) || !hits.length) return [];
  return hits
    .map((h, i) => {
      const cid = encodeURIComponent(String(h.collectionId || "unknown"));
      const rid =
        h.rowId != null && Number.isFinite(Number(h.rowId))
          ? String(h.rowId)
          : `idx-${typeof h.chunkIndex === "number" ? h.chunkIndex : i}`;
      const url = `https://kb.local/rag/${cid}/${encodeURIComponent(rid)}`;
      const cn = String(h.collectionName || "知识库").trim() || "知识库";
      const idx = typeof h.chunkIndex === "number" ? h.chunkIndex : "?";
      return {
        url,
        title: `知识库「${cn}」分块 #${idx}`,
        text: String(h.content || "").trim(),
        via: "rag",
        ragScore: Number(h.score) || 0
      };
    })
    .filter((d) => d.text);
}

function truncateRagSnippetForPrompt(text, maxChars) {
  const t = String(text || "").trim();
  const m = Math.max(200, Math.floor(Number(maxChars) || 1200));
  if (t.length <= m) return t;
  return `${t.slice(0, m - 20)}\n…（分块已截断）`;
}

function formatRagHitsForPrompt(hits, maxCharsPerChunk = 1200) {
  if (!Array.isArray(hits) || !hits.length) return "";
  const cap = Math.max(200, Math.floor(Number(maxCharsPerChunk) || 1200));
  const lines = [
    "以下为当前对话已绑定的知识库中，与本轮问题最相关的检索片段（多库已合并、按相关度排序）。编号 [知识库-1]、[知识库-2] … 与下列片段一一对应；每条标题中注明所属知识库名称。请在确有依据处使用对应引用标记。"
  ];
  hits.forEach((h, i) => {
    const n = i + 1;
    const idx = typeof h.chunkIndex === "number" ? h.chunkIndex : "?";
    const rid = h.rowId != null && Number.isFinite(Number(h.rowId)) ? String(h.rowId) : "";
    const meta = rid ? `分块序号 #${idx}，记录 id ${rid}` : `分块序号 #${idx}`;
    const pct = (Number(h.score) * 100).toFixed(1);
    const cn = String(h.collectionName || "知识库").trim() || "知识库";
    lines.push("");
    lines.push(`### [知识库-${n}]（知识库「${cn}」；${meta}，相关度 ${pct}%）`);
    lines.push(truncateRagSnippetForPrompt(String(h.content || "").trim(), cap));
  });
  return lines.join("\n");
}

function ragHitsWithSnippetLimit(hits, maxCharsPerChunk) {
  if (!Array.isArray(hits)) return [];
  const cap = Math.max(200, Math.floor(Number(maxCharsPerChunk) || 1200));
  return hits.map((h) => ({
    ...h,
    content: truncateRagSnippetForPrompt(String(h.content || "").trim(), cap)
  }));
}

function inflightChatKey(username, sessionId) {
  return `${String(username || "").trim()}::${String(sessionId || "").trim()}`;
}

function traceEventSummaryLine(e) {
  const p = e?.payload || {};
  if (p.msg) return String(p.msg);
  if (p.query) return `检索：${String(p.query).slice(0, 96)}`;
  if (typeof p.resultCount === "number") return `检索命中 ${p.resultCount} 条`;
  if (p.url) return `页面：${String(p.url).slice(0, 72)}`;
  if (p.error) return `异常：${String(p.error).slice(0, 120)}`;
  return "";
}

function sanitizeTraceForClient(trace) {
  const arr = Array.isArray(trace) ? trace : [];
  return arr.slice(-40).map((e) => ({
    ts: e.ts,
    stage: e.stage || "",
    agent: e.agent || "",
    type: e.type || "",
    summary: traceEventSummaryLine(e)
  }));
}

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "12mb" }));

/** 将当前问题与近期对话拼成研究课题（Planner / 检索 / 写作沿用 research 管线） */
function buildResearchTopicFromChat(question, history) {
  const q = String(question || "").trim();
  const msgs = Array.isArray(history) ? history : [];
  const lines = [];
  for (const m of msgs.slice(-12)) {
    if (m?.role !== "user" && m?.role !== "assistant") continue;
    const c = String(m?.content || "").trim();
    if (!c) continue;
    const label = m.role === "user" ? "用户" : "助理";
    lines.push(`${label}：${c.slice(0, 1500)}`);
  }
  const ctx = lines.join("\n");
  if (!ctx) return q;
  return `【对话上文】\n${ctx}\n\n【当前问题】\n${q}`.slice(0, 14_000);
}

async function finalizeChatResearch({ username, sessionId, taskId }) {
  const researchMeta = { researchTaskId: String(taskId || "").trim() };
  const t = research.getTaskForUser(taskId, username);
  if (!t) {
    chatRepo.appendMessage(username, sessionId, {
      role: "assistant",
      content: "研究任务异常结束（未找到任务记录）。",
      meta: researchMeta
    });
    return;
  }
  if (t.status === "failed" || t.error) {
    chatRepo.appendMessage(username, sessionId, {
      role: "assistant",
      content: `研究未顺利完成：${t.error}\n\n可尝试缩小范围或稍后重试。`,
      meta: researchMeta
    });
    return;
  }
  const report = String(t.artifacts?.["report.md"] ?? "").trim();
  if (!report) {
    chatRepo.appendMessage(username, sessionId, {
      role: "assistant",
      content: "研究已完成但未生成报告正文，请重试。",
      meta: researchMeta
    });
    return;
  }
  chatRepo.appendMessage(username, sessionId, { role: "assistant", content: report, meta: researchMeta });
}

async function runChatResearchPipeline({ username, sessionId, taskId, retrieveKbDocs, researchRuntime }) {
  try {
    await runResearchTask({ store: research, taskId, llmClient, retrieveKbDocs, runtime: researchRuntime });
  } catch (e) {
    research.addTraceEvent(taskId, {
      type: "observation",
      stage: "failed",
      agent: "Coordinator",
      payload: { error: String(e?.message || e || "unknown_error") }
    });
    research.setError(taskId, e);
  }
  await finalizeChatResearch({ username, sessionId, taskId });
}

function normalizeDialogueTone(raw) {
  const t = String(raw || "balanced").trim().toLowerCase();
  if (t === "concise" || t === "detailed" || t === "balanced") return t;
  return "balanced";
}

function normalizeChatRouteMode(raw) {
  const s = String(raw || "auto").trim().toLowerCase();
  if (s === "simple" || s === "deep") return s;
  if (s === "research") return "deep";
  return "auto";
}

function clampIntPref(n, lo, hi, fallback) {
  const x = Math.floor(Number(n));
  if (!Number.isFinite(x)) return fallback;
  return Math.max(lo, Math.min(hi, x));
}

function clampFloatPref(n, lo, hi, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(lo, Math.min(hi, x));
}

function buildChatMessagesForSimple({ history, question, ragPromptAppendix, dialogueTone }) {
  const tone = normalizeDialogueTone(dialogueTone);
  const toneAppend =
    tone === "concise"
      ? "\n\n【会话语气】请控制篇幅：先给结论或要点，再必要时简要补充；避免冗长铺垫与重复表述。"
      : tone === "detailed"
        ? "\n\n【会话语气】在保持自然、口语化的前提下，可对关键概念适度展开解释，必要时给出简短背景；仍不要用论文大纲体例。"
        : "";
  const base =
    "你是友好的研究助理，用中文像日常聊天那样回答。不要用「目录」「摘要」「一、二、三」等公文或论文大纲格式；除非用户明确要求，否则不要用长串编号列表。不确定时请明说。" + toneAppend;
  const rag = String(ragPromptAppendix || "").trim();
  const systemContent = rag
    ? `${base}\n\n用户已选定个人知识库，并在下方提供了检索到的片段。请优先依据这些片段作答；若片段不足以回答问题，请明确说明并给出合理推断。仅在陈述确有片段支持的内容时，在对应句末或段末添加引用标记，格式为「[知识库-1]」「[知识库-2]」等，与片段标题中的编号一致；不要堆砌无关引用。\n\n【结构与去重】若问题一两句话就能答全，请直接作答，不要用「两个小节」或两个意思相同、仅多一个「的」或标点不同的标题重复叙述同一事实；不要用「用户知识库检索参考」之类作为回答的总标题（那是系统说明，不是你的输出结构）。\n\n----------\n${rag}\n----------`
    : base;
  const msgs = [{ role: "system", content: systemContent }];
  for (const m of Array.isArray(history) ? history : []) {
    if (m?.role !== "user" && m?.role !== "assistant") continue;
    const content = String(m?.content || "").trim();
    if (!content) continue;
    msgs.push({ role: m.role, content });
  }
  msgs.push({ role: "user", content: question });
  return msgs;
}

async function simpleLLMReply({ history, question, ragPromptAppendix, dialogueTone, temperature, maxTokens }) {
  const maxTok = clampIntPref(maxTokens, 256, 4096, 2048);
  const temp = clampFloatPref(temperature, 0.05, 0.99, 0.35);
  let messages = buildChatMessagesForSimple({ history, question, ragPromptAppendix, dialogueTone });
  // 下游 8k 模型：输入 + max_tokens 不得超过上下文；长历史 + RAG 易超限，先裁再请求
  messages = fitMessagesToContextBudget(messages, { maxCompletionTokens: maxTok });
  const answer = await llmClient.chat({ messages, temperature: temp, maxTokens: maxTok });
  return { answer };
}

function trivialGreetingHeuristic(q) {
  const trimmed = String(q || "").trim();
  if (!trimmed) return true;
  const s = trimmed.replace(/[!！?？.。,，~～…\s]+$/u, "").trim();
  if (!s) return true;
  if (s.length > 56) return false;
  const lower = s.toLowerCase();
  const cn =
    /^(哈喽|哈罗|哈喽啊|嗨|嗨嗨|你好|您好|在吗|在么|早上好|下午好|晚上好|谢谢|多谢|辛苦啦|辛苦|拜托|拜拜|再见|白白|好的|好滴|嗯嗯|嗯|行|行吧|可以)$/u;
  const en = /^(hi|hello|hey|thanks|thank you|bye|good morning|good night|morning|night|ok)$/i;
  if (cn.test(s) || en.test(lower)) return true;
  if (/^[\d\s!?！？.。,，~～…]+$/u.test(s) && s.length <= 8) return true;
  return false;
}

async function llmRouteNeedsDeepResearch(question, history) {
  const q = String(question || "").trim().slice(0, 2000);
  const recent = (Array.isArray(history) ? history : []).slice(-6);
  const lines = [];
  for (const m of recent) {
    if (m?.role !== "user" && m?.role !== "assistant") continue;
    const c = String(m?.content || "").trim();
    if (!c) continue;
    lines.push(`${m.role === "user" ? "用户" : "助理"}：${c.slice(0, 400)}`);
  }
  const ctx = lines.join("\n");
  const system = [
    "你是对话分流器。判断用户的「最新消息」是否必须使用：联网检索、多源资料、分步规划与长篇报告式写作（deep research）。",
    "needsResearch 为 false：寒暄问候致谢告别、无实质确认、纯闲聊、讲笑话、测试连接、明显不需要查证的内容。",
    "needsResearch 为 true：需要事实数据论文新闻、对比调研、技术方案、行业综述等依赖外部资料或可验证信息的问题。",
    "只输出严格 JSON，例如 {\"needsResearch\":false} 或 {\"needsResearch\":true}，不要其它文字。"
  ].join("\n");
  const userContent = ctx ? `【最近对话】\n${ctx}\n\n【最新消息】\n${q}` : `【最新消息】\n${q}`;
  const raw = await llmClient.chat({
    messages: [
      { role: "system", content: system },
      { role: "user", content: userContent }
    ],
    temperature: 0,
    maxTokens: 64
  });
  const m = raw.match(/\{[\s\S]*"needsResearch"[\s\S]*\}/);
  if (!m) return true;
  try {
    const j = JSON.parse(m[0]);
    const v = j?.needsResearch;
    if (v === false || v === 0) return false;
    if (v === true || v === 1) return true;
    if (typeof v === "string") {
      const s = v.toLowerCase();
      if (s === "false" || s === "no" || s === "0") return false;
      if (s === "true" || s === "yes" || s === "1") return true;
    }
    return true;
  } catch {
    return true;
  }
}

async function shouldUseDeepResearch(question, history, clientRouteMode) {
  const client = normalizeChatRouteMode(clientRouteMode);
  if (client === "simple") return false;
  if (client === "deep") return true;
  const force = String(process.env.CHAT_ROUTER_FORCE || "").toLowerCase();
  if (force === "research") return true;
  if (force === "simple") return false;
  if (trivialGreetingHeuristic(question)) return false;
  return llmRouteNeedsDeepResearch(question, history);
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  const token = bearerToken(req);
  const v = token ? verifyAuthToken(token) : null;
  if (!v) {
    res.json({ user: null });
    return;
  }
  res.json({ user: { username: v.username } });
});

app.post("/api/auth/register", async (req, res) => {
  try {
    if (!isSmtpConfigured()) {
      return res.status(503).json({ error: "smtp_not_configured" });
    }
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password ?? "");
    const email = String(req.body?.email || "").trim();
    const r = users.register({ username, password, email });
    if (!r.ok) return res.status(400).json({ error: r.error });
    try {
      await sendVerificationEmail(r.email, r.verifyToken);
    } catch (e) {
      process.stderr.write(`[mail] sendVerificationEmail: ${e?.stack || e}\n`);
      return res.status(500).json({
        error: "email_send_failed",
        detail: String(e?.message || e)
      });
    }
    res.json({ ok: true, message: "verification_email_sent" });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

app.get("/api/auth/verify-email", (req, res) => {
  try {
    const token = String(req.query?.token || "").trim();
    const r = users.verifyEmailToken(token);
    if (!r.ok) return res.status(400).json({ error: r.error || "verify_failed" });
    res.json({ ok: true, username: r.username });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

app.post("/api/auth/resend-verification", async (req, res) => {
  try {
    if (!isSmtpConfigured()) {
      return res.status(503).json({ error: "smtp_not_configured" });
    }
    const email = String(req.body?.email || "").trim();
    const r = users.resendVerification(email);
    if (!r.ok && r.error === "already_verified") {
      return res.status(400).json({ error: r.error });
    }
    if (!r.ok) {
      return res.json({ ok: true });
    }
    try {
      await sendVerificationEmail(r.email, r.verifyToken);
    } catch (e) {
      process.stderr.write(`[mail] resend: ${e?.stack || e}\n`);
      return res.status(500).json({ error: "email_send_failed", detail: String(e?.message || e) });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

app.post("/api/auth/forgot-password", async (req, res) => {
  try {
    if (!isSmtpConfigured()) {
      return res.status(503).json({ error: "smtp_not_configured" });
    }
    const email = String(req.body?.email || "").trim();
    const r = users.requestPasswordReset(email);
    if (r.resetToken) {
      try {
        await sendPasswordResetEmail(r.email, r.resetToken);
      } catch (e) {
        process.stderr.write(`[mail] forgot-password: ${e?.stack || e}\n`);
        /* 仍返回 ok，避免暴露邮箱是否注册 */
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

app.post("/api/auth/reset-password", (req, res) => {
  try {
    const token = String(req.body?.token || "").trim();
    const password = String(req.body?.password ?? "");
    const r = users.resetPasswordWithToken(token, password);
    if (!r.ok) return res.status(400).json({ error: r.error || "reset_failed" });
    res.json({ ok: true, username: r.username });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

app.post("/api/auth/send-login-code", async (req, res) => {
  try {
    if (!isSmtpConfigured()) {
      return res.status(503).json({ error: "smtp_not_configured" });
    }
    const emailRaw = String(req.body?.email || "").trim();
    const emailNorm = emailRaw.toLowerCase();
    const last = loginCodeSentAt.get(emailNorm) || 0;
    const now = Date.now();
    if (now - last < LOGIN_CODE_COOLDOWN_MS) {
      const retryAfterSec = Math.ceil((LOGIN_CODE_COOLDOWN_MS - (now - last)) / 1000);
      return res.status(429).json({ error: "rate_limited", retryAfterSec });
    }
    const r = users.issueLoginCode(emailRaw);
    if (!r.ok) return res.status(400).json({ error: r.error });
    if (r.noop) return res.json({ ok: true });
    try {
      await sendLoginCodeEmail(r.email, r.code);
      loginCodeSentAt.set(emailNorm, Date.now());
    } catch (e) {
      process.stderr.write(`[mail] send-login-code: ${e?.stack || e}\n`);
      return res.status(500).json({
        error: "email_send_failed",
        detail: String(e?.message || e)
      });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

app.post("/api/auth/login-with-code", (req, res) => {
  try {
    const r = users.validateLoginCode(req.body?.email, req.body?.code);
    if (!r.ok) return res.status(401).json({ error: r.error });
    const token = signAuthToken(r.username);
    res.json({ ok: true, user: { username: r.username }, token });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

app.post("/api/auth/login", (req, res) => {
  try {
    const r = users.validateLogin({
      username: req.body?.username,
      password: req.body?.password
    });
    if (!r.ok) return res.status(401).json({ error: r.error });
    const token = signAuthToken(r.username);
    res.json({ ok: true, user: { username: r.username }, token });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

app.post("/api/auth/logout", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/chats", requireLogin, (req, res) => {
  try {
    const list = chatRepo.list(req.user.username);
    res.json({ chats: list });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

app.post("/api/chats", requireLogin, (req, res) => {
  try {
    const row = chatRepo.create(req.user.username);
    res.status(201).json({ chat: row });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

app.get("/api/chats/:id/messages", requireLogin, (req, res) => {
  try {
    const msgs = chatRepo.getMessages(req.user.username, req.params.id);
    if (!msgs) return res.status(404).json({ error: "not_found" });
    res.json({ messages: msgs });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

app.delete("/api/chats/:id", requireLogin, (req, res) => {
  try {
    const ok = chatRepo.delete(req.user.username, req.params.id);
    if (!ok) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

app.patch("/api/chats/:id", requireLogin, (req, res) => {
  try {
    const sessionId = String(req.params.id || "").trim();
    if (!chatRepo.ownsSession(req.user.username, sessionId)) {
      return res.status(404).json({ error: "not_found" });
    }
    const raw = req.body?.ragCollectionIds;
    if (!Array.isArray(raw)) {
      return res.status(400).json({
        error: "ragCollectionIds_required",
        message: "请求体需提供 ragCollectionIds 数组；传 [] 表示解除全部绑定。"
      });
    }
    const ids = normalizeRagCollectionIdsArray(raw);
    if (ids.length > RAG_BINDINGS_PER_CHAT_MAX) {
      return res.status(400).json({
        error: "too_many_rag_collections",
        message: `单会话最多绑定 ${RAG_BINDINGS_PER_CHAT_MAX} 个知识库。`
      });
    }
    const u = String(req.user.username || "").trim();
    const validIds = ids.filter((cid) => ragRepo.owns(u, cid));
    if (ids.length > 0 && validIds.length === 0) {
      return res.status(400).json({ error: "invalid_rag_collection", collectionId: ids[0] });
    }
    chatRepo.setRagCollectionIds(req.user.username, sessionId, validIds);
    const chat = chatRepo.getSessionSummary(req.user.username, sessionId);
    if (!chat) return res.status(404).json({ error: "not_found" });
    res.json({ chat });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

app.post("/api/rag/collections", requireLogin, (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const row = ragRepo.createCollection(req.user.username, name);
    res.status(201).json({ collection: row });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

app.get("/api/rag/collections", requireLogin, (req, res) => {
  try {
    res.json({ collections: ragRepo.list(req.user.username) });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

app.get("/api/rag/collections/:id/chunks/:rowId", requireLogin, (req, res) => {
  try {
    const cid = String(req.params.id || "").trim();
    const rowId = Number(req.params.rowId);
    if (!Number.isFinite(rowId)) return res.status(400).json({ error: "invalid_row_id" });
    const chunk = ragRepo.getChunkByRowId(req.user.username, cid, rowId);
    if (!chunk) return res.status(404).json({ error: "not_found" });
    res.json({ chunk });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

app.get("/api/rag/collections/:id/chunks", requireLogin, (req, res) => {
  try {
    const cid = String(req.params.id || "").trim();
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize || "20"), 10) || 20));
    const q = String(req.query.q || "").trim();
    const r = ragRepo.listChunksPage(req.user.username, cid, { page, pageSize, q });
    if (r === null) return res.status(404).json({ error: "not_found" });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

app.get("/api/rag/collections/:id", requireLogin, (req, res) => {
  try {
    const cid = String(req.params.id || "").trim();
    const collection = ragRepo.getCollection(req.user.username, cid);
    if (!collection) return res.status(404).json({ error: "not_found" });
    res.json({ collection });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

app.patch("/api/rag/collections/:id", requireLogin, (req, res) => {
  try {
    const cid = String(req.params.id || "").trim();
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "name is required" });
    const ok = ragRepo.updateCollection(req.user.username, cid, name);
    if (!ok) return res.status(404).json({ error: "not_found" });
    const collection = ragRepo.getCollection(req.user.username, cid);
    res.json({ collection });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

app.post("/api/rag/collections/:id/chunks", requireLogin, async (req, res) => {
  try {
    if (!isEmbeddingConfigured()) {
      return res.status(503).json({
        error: "embedding_not_configured",
        message: "请配置 ARK_API_KEY 或 EMBEDDING_API_KEY（火山方舟），并设置 EMBEDDING_MODEL。"
      });
    }
    const cid = String(req.params.id || "").trim();
    if (!ragRepo.owns(req.user.username, cid)) {
      return res.status(404).json({ error: "not_found" });
    }
    const content = String(req.body?.content ?? "").trim();
    if (!content) return res.status(400).json({ error: "empty_content" });
    const [vec] = await embedTexts([content]);
    const r = ragRepo.appendChunk(req.user.username, cid, content, vec);
    if (!r.ok) return res.status(400).json({ error: r.error || "append_failed" });
    res.status(201).json({ chunk: r.chunk });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

app.post("/api/rag/collections/:id/chunks/batch-delete", requireLogin, (req, res) => {
  try {
    const cid = String(req.params.id || "").trim();
    const rowIds = req.body?.rowIds;
    if (!Array.isArray(rowIds)) {
      return res.status(400).json({ error: "rowIds array required" });
    }
    const r = ragRepo.deleteChunksByRowIds(req.user.username, cid, rowIds);
    if (!r.ok) {
      if (r.error === "not_found") return res.status(404).json({ error: "not_found" });
      if (r.error === "empty_row_ids") return res.status(400).json({ error: "empty_row_ids" });
      return res.status(400).json({ error: r.error || "batch_delete_failed" });
    }
    res.json({ ok: true, deleted: r.deleted });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

app.put("/api/rag/collections/:id/chunks/:rowId", requireLogin, async (req, res) => {
  try {
    if (!isEmbeddingConfigured()) {
      return res.status(503).json({
        error: "embedding_not_configured",
        message: "请配置 ARK_API_KEY 或 EMBEDDING_API_KEY（火山方舟），并设置 EMBEDDING_MODEL。"
      });
    }
    const cid = String(req.params.id || "").trim();
    const rowId = Number(req.params.rowId);
    if (!ragRepo.owns(req.user.username, cid) || !Number.isFinite(rowId)) {
      return res.status(404).json({ error: "not_found" });
    }
    const content = String(req.body?.content ?? "").trim();
    if (!content) return res.status(400).json({ error: "empty_content" });
    const [vec] = await embedTexts([content]);
    const r = ragRepo.updateChunk(req.user.username, cid, rowId, content, vec);
    if (!r.ok) return res.status(404).json({ error: r.error || "not_found" });
    res.json({ chunk: r.chunk });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

app.delete("/api/rag/collections/:id/chunks/:rowId", requireLogin, (req, res) => {
  try {
    const cid = String(req.params.id || "").trim();
    const rowId = Number(req.params.rowId);
    if (!Number.isFinite(rowId)) return res.status(400).json({ error: "invalid_row_id" });
    const ok = ragRepo.deleteChunk(req.user.username, cid, rowId);
    if (!ok) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

app.delete("/api/rag/collections/:id", requireLogin, (req, res) => {
  try {
    const ok = ragRepo.delete(req.user.username, req.params.id);
    if (!ok) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

app.post("/api/rag/collections/:id/ingest", requireLogin, async (req, res) => {
  try {
    if (!isEmbeddingConfigured()) {
      return res.status(503).json({
        error: "embedding_not_configured",
        message: "请配置 ARK_API_KEY 或 EMBEDDING_API_KEY（火山方舟），并设置 EMBEDDING_MODEL。"
      });
    }
    const cid = String(req.params.id || "").trim();
    if (!ragRepo.owns(req.user.username, cid)) {
      return res.status(404).json({ error: "not_found" });
    }
    const text = String(req.body?.text ?? "");
    const chunkSize = Number(req.body?.chunkSize) || 800;
    const overlap = Number(req.body?.overlap) || 120;
    const chunks = chunkText(text, { chunkSize, overlap });
    if (!chunks.length) return res.status(400).json({ error: "empty_text" });

    const BATCH = 24;
    const embeddings = [];
    for (let i = 0; i < chunks.length; i += BATCH) {
      const part = chunks.slice(i, i + BATCH);
      const vecs = await embedTexts(part);
      embeddings.push(...vecs);
    }
    if (embeddings.length !== chunks.length) {
      return res.status(500).json({ error: "embedding_count_mismatch" });
    }
    const r = ragRepo.ingestChunks(req.user.username, cid, { chunks, embeddings });
    if (!r.ok) return res.status(400).json({ error: r.error || "ingest_failed" });
    res.json({ ok: true, chunkCount: r.chunkCount });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

app.post("/api/rag/collections/:id/query", requireLogin, async (req, res) => {
  try {
    if (!isEmbeddingConfigured()) {
      return res.status(503).json({
        error: "embedding_not_configured",
        message: "请配置 ARK_API_KEY 或 EMBEDDING_API_KEY（火山方舟），并设置 EMBEDDING_MODEL。"
      });
    }
    const cid = String(req.params.id || "").trim();
    if (!ragRepo.owns(req.user.username, cid)) {
      return res.status(404).json({ error: "not_found" });
    }
    const question = String(req.body?.question || "").trim();
    if (!question) return res.status(400).json({ error: "question is required" });
    const topK = Number(req.body?.topK) || 5;
    const minScore = clampRagMinScore(
      req.body?.minScore !== undefined && req.body?.minScore !== null ? req.body.minScore : RAG_MIN_SCORE_DEFAULT
    );
    const qv = await embedQuery(question);
    const hitsRaw = ragRepo.query(req.user.username, cid, qv, topK);
    if (hitsRaw === null) return res.status(404).json({ error: "not_found" });
    const { hits, suppressed } = applyRagMinScoreFloor(hitsRaw, minScore);
    res.json({
      hits,
      topK: Math.max(1, Math.min(20, Number(topK) || 5)),
      minScore,
      bestScore: hitsRaw.length ? Number(hitsRaw[0].score) : null,
      belowMinScore: suppressed
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

app.get("/api/chat/research/:taskId", requireLogin, (req, res) => {
  try {
    const taskId = String(req.params.taskId || "").trim();
    const t = research.getTaskForUser(taskId, req.user.username);
    if (!t) return res.status(404).json({ error: "not_found" });
    const trace = Array.isArray(t.trace) ? t.trace : [];
    const last = trace.length ? trace[trace.length - 1] : null;
    res.json({
      taskId: t.id,
      status: t.status,
      error: t.error || null,
      stage: last?.stage || t.status,
      trace: sanitizeTraceForClient(t.trace)
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

app.get("/api/chat/research/:taskId/pipeline", requireLogin, (req, res) => {
  try {
    const taskId = String(req.params.taskId || "").trim();
    const t = research.getTaskForUser(taskId, req.user.username);
    if (!t) return res.status(404).json({ error: "not_found" });
    const trace = Array.isArray(t.trace) ? t.trace : [];
    const pipe = buildPipelineFromTrace(trace, t.topic || "");
    const { nodes: _n, edges: _e, ...pipeRest } = pipe;
    res.json({ taskId: t.id, status: t.status, error: t.error || null, ...pipeRest });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

app.post("/api/chat", requireLogin, async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || "").trim();
    const question = String(req.body?.question || "").trim();
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });
    if (!question) return res.status(400).json({ error: "question is required" });

    if (!chatRepo.ownsSession(req.user.username, sessionId)) {
      return res.status(403).json({ error: "forbidden_or_not_found" });
    }

    if (!llmClient) {
      return res.status(503).json({
        error: "llm_not_configured",
        message: "Set LLM_PROVIDER=kimi|moonshot and KIMI_API_KEY (or MOONSHOT_API_KEY)."
      });
    }

    const sync = String(req.query?.sync || "") === "1";
    const key = inflightChatKey(req.user.username, sessionId);
    if (chatResearchInflight.has(key)) {
      return res.status(409).json({ error: "chat_research_in_progress" });
    }

    const stored = chatRepo.getMessages(req.user.username, sessionId);
    const history = stored.map(({ role, content }) => ({ role, content }));
    const dialogueTone = normalizeDialogueTone(req.body?.dialogueTone);
    const chatRouteMode = normalizeChatRouteMode(req.body?.chatRouteMode);
    const ragTopKUser = clampIntPref(req.body?.ragTopK, 1, 16, RAG_CHAT_TOPK);
    const ragMinScoreUser = clampRagMinScore(
      req.body?.ragMinScore !== undefined && req.body?.ragMinScore !== null
        ? req.body.ragMinScore
        : RAG_MIN_SCORE_DEFAULT
    );
    const ragSnippetMaxChars = clampIntPref(req.body?.ragSnippetMaxChars, 400, 4000, 1200);
    const simpleChatTemperature = clampFloatPref(req.body?.simpleChatTemperature, 0.05, 0.99, 0.35);
    const simpleChatMaxTokens = clampIntPref(req.body?.simpleChatMaxTokens, 256, 4096, 2048);
    const researchRuntime = normalizeResearchRuntime({
      plannerMaxTokens: req.body?.plannerMaxTokens,
      plannerTemperature: req.body?.plannerTemperature,
      writerMaxTokens: req.body?.writerMaxTokens,
      readerMaxTokens: req.body?.readerMaxTokens,
      readerMaxSources: req.body?.readerMaxSources,
      readerClipChars: req.body?.readerClipChars,
      fetcherPreferKbOnly: req.body?.fetcherPreferKbOnly,
      criticRewriteMaxTokens: req.body?.criticRewriteMaxTokens
    });
    const needsResearch = await shouldUseDeepResearch(question, history, chatRouteMode);

    const ragCollectionIds = chatRepo.getRagCollectionIds(req.user.username, sessionId);
    let ragPromptAppendix = "";
    let ragHitCount = 0;
    let ragSuppressedByMinScore = false;
    /** @type {number | null} */
    let ragBestScore = null;
    if (ragCollectionIds.length) {
      try {
        const ragPack = await fetchRagHitsForChatMulti(
          req.user.username,
          ragCollectionIds,
          question,
          ragTopKUser,
          ragMinScoreUser
        );
        ragHitCount = ragPack.hits.length;
        ragSuppressedByMinScore = Boolean(ragPack.ragSuppressedByMinScore);
        ragBestScore =
          ragPack.ragBestScore !== undefined && ragPack.ragBestScore !== null && Number.isFinite(Number(ragPack.ragBestScore))
            ? Number(ragPack.ragBestScore)
            : null;
        ragPromptAppendix = formatRagHitsForPrompt(ragPack.hits, ragSnippetMaxChars);
      } catch (e) {
        process.stderr.write(`[rag-chat] retrieve failed: ${e?.stack || e}\n`);
      }
    }

    if (!needsResearch) {
      chatResearchInflight.set(key, "__simple__");
      try {
        chatRepo.appendMessage(req.user.username, sessionId, { role: "user", content: question });
        let answer;
        try {
          const out = await simpleLLMReply({
            history,
            question,
            ragPromptAppendix,
            dialogueTone,
            temperature: simpleChatTemperature,
            maxTokens: simpleChatMaxTokens
          });
          answer = out.answer;
        } catch (e) {
          answer = `回复失败：${String(e?.message || e || "unknown_error")}`;
        }
        chatRepo.appendMessage(req.user.username, sessionId, { role: "assistant", content: answer });
        const debug = req.query?.debug === "1";
        if (debug) {
          res.json({
            sessionId,
            mode: "simple",
            answer,
            taskId: null,
            ragHitCount,
            ragMinScore: ragMinScoreUser,
            ragSuppressedByMinScore,
            ragBestScore
          });
          return;
        }
        res.json({
          sessionId,
          answer,
          mode: "simple",
          ragHitCount,
          ragMinScore: ragMinScoreUser,
          ragSuppressedByMinScore,
          ragBestScore
        });
      } finally {
        chatResearchInflight.delete(key);
      }
      return;
    }

    chatResearchInflight.set(key, "__reserved__");

    let task;
    try {
      const topicBase = buildResearchTopicFromChat(question, history);
      const topic = ragPromptAppendix.trim()
        ? `【用户知识库检索参考】\n${ragPromptAppendix.trim()}\n\n---\n\n${topicBase}`
        : topicBase;
      task = research.createTask({ topic, username: req.user.username });
      research.addTraceEvent(task.id, {
        type: "decision",
        stage: "created",
        agent: "Coordinator",
        payload: { msg: "Chat: deep research pipeline" }
      });

      chatRepo.appendMessage(req.user.username, sessionId, { role: "user", content: question });
      chatResearchInflight.set(key, task.id);
    } catch (e) {
      chatResearchInflight.delete(key);
      throw e;
    }

    const retrieveKbDocs =
      ragCollectionIds.length && isEmbeddingConfigured()
        ? async (queryText) => {
            const qt = String(queryText || "").trim() || question;
            const deepK = Math.min(16, ragTopKUser + 4);
            const ragPack = await fetchRagHitsForChatMulti(
              req.user.username,
              ragCollectionIds,
              qt,
              deepK,
              ragMinScoreUser
            );
            return hitsToKbResearchDocs(ragHitsWithSnippetLimit(ragPack.hits, ragSnippetMaxChars));
          }
        : undefined;

    const run = async () => {
      try {
        await runChatResearchPipeline({
          username: req.user.username,
          sessionId,
          taskId: task.id,
          retrieveKbDocs,
          researchRuntime
        });
      } finally {
        chatResearchInflight.delete(key);
      }
    };

    if (sync) {
      await run();
      const msgs = chatRepo.getMessages(req.user.username, sessionId) || [];
      const last = msgs.length ? msgs[msgs.length - 1] : null;
      const answer = last?.role === "assistant" ? last.content : "";
      const debug = req.query?.debug === "1";
      if (debug) {
        const t2 = research.getTaskForUser(task.id, req.user.username);
        res.json({
          sessionId,
          mode: "deep_research",
          answer,
          taskId: task.id,
          trace: t2?.trace || [],
          ragHitCount,
          ragMinScore: ragMinScoreUser,
          ragSuppressedByMinScore,
          ragBestScore
        });
        return;
      }
      res.json({
        sessionId,
        answer,
        mode: "deep_research",
        ragHitCount,
        ragMinScore: ragMinScoreUser,
        ragSuppressedByMinScore,
        ragBestScore
      });
      return;
    }

    queueMicrotask(() => {
      void run();
    });

    res.status(202).json({
      ok: true,
      taskId: task.id,
      sessionId,
      mode: "deep_research",
      ragHitCount,
      ragMinScore: ragMinScoreUser,
      ragSuppressedByMinScore,
      ragBestScore
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

const port = Number(process.env.PORT || 3001);
const server = app.listen(port, () => {
  process.stdout.write(`server listening on http://localhost:${port}\n`);
});

function shutdown(signal) {
  process.stdout.write(`\nreceived ${signal}, shutting down...\n`);
  try {
    db.close();
  } catch {
    /* ignore */
  }
  server.close(() => {
    process.stdout.write("server closed\n");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.on("error", (err) => {
  process.stderr.write(`server_error: ${err?.message || err}\n`);
  process.exit(1);
});
