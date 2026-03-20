import "dotenv/config";
import cors from "cors";
import express from "express";
import { createDefaultOrchestrator } from "./react/index.js";
import { createLLMClientFromEnv } from "./llm/index.js";
import { SessionStore } from "./memory/sessionStore.js";
import { ResearchStore } from "./research/store.js";
import { runResearchTask } from "./research/runner.js";

const app = express();
const llmClient = createLLMClientFromEnv();
const orchestrator = createDefaultOrchestrator({ llmClient });
const sessions = new SessionStore();
const research = new ResearchStore();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

function buildChatMessages({ history, question }) {
  const msgs = [
    {
      role: "system",
      content:
        "你是一个严谨、友好的研究助理。请用中文回答，尽量给出清晰结构与可执行建议；当不确定时明确说明不确定之处。"
    }
  ];

  for (const m of Array.isArray(history) ? history : []) {
    if (m?.role !== "user" && m?.role !== "assistant") continue;
    const content = String(m?.content || "").trim();
    if (!content) continue;
    msgs.push({ role: m.role, content });
  }

  msgs.push({ role: "user", content: question });
  return msgs;
}

async function simpleLLMReply({ history, question }) {
  if (!llmClient) {
    throw new Error(
      "LLM is not configured. Set LLM_PROVIDER=kimi|moonshot and provide KIMI_API_KEY (or MOONSHOT_API_KEY)."
    );
  }
  const messages = buildChatMessages({ history, question });
  const answer = await llmClient.chat({ messages, temperature: 0.2 });
  return { answer };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/session/:id", (req, res) => {
  const s = sessions.get(req.params.id);
  res.json({ session: s || { id: req.params.id, messages: [] } });
});

app.post("/api/research", async (req, res) => {
  try {
    const topic = String(req.body?.topic || "").trim();
    if (!topic) return res.status(400).json({ error: "topic is required" });

    const task = research.createTask({ topic });
    research.addTraceEvent(task.id, {
      type: "decision",
      stage: "created",
      agent: "Coordinator",
      payload: { msg: "Task created" }
    });

    // 后台异步执行（中期 MVP：先跑规划，后续再加 collecting/writing/...）
    queueMicrotask(async () => {
      try {
        await runResearchTask({ store: research, taskId: task.id, llmClient });
      } catch (e) {
        research.addTraceEvent(task.id, {
          type: "observation",
          stage: "failed",
          agent: "Coordinator",
          payload: { error: String(e?.message || e || "unknown_error") }
        });
        research.setError(task.id, e);
      }
    });

    res.status(202).json({ taskId: task.id, status: task.status });
  } catch (e) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

app.get("/api/research/:id", (req, res) => {
  const t = research.getTask(req.params.id);
  if (!t) return res.status(404).json({ error: "not_found" });
  res.json({
    task: {
      id: t.id,
      topic: t.topic,
      status: t.status,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      error: t.error,
      artifacts: Object.keys(t.artifacts),
      trace: t.trace
    }
  });
});

app.get("/api/research/:id/artifact/:name", (req, res) => {
  const t = research.getTask(req.params.id);
  if (!t) return res.status(404).json({ error: "not_found" });
  const name = String(req.params.name || "").trim();
  if (!name) return res.status(400).json({ error: "name is required" });
  if (!(name in t.artifacts)) return res.status(404).json({ error: "artifact_not_found" });

  const v = t.artifacts[name];
  if (name.endsWith(".md") || name.endsWith(".txt")) {
    res.type("text/plain; charset=utf-8").send(String(v || ""));
    return;
  }
  res.json({ artifact: v });
});

app.post("/api/chat", async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || "").trim();
    const question = String(req.body?.question || "").trim();
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });
    if (!question) return res.status(400).json({ error: "question is required" });

    const s = sessions.ensure(sessionId);
    const history = s.messages;
    const mode = String(req.query?.mode || process.env.CHAT_MODE || "simple").toLowerCase();

    const result =
      mode === "react"
        ? await orchestrator.run({ question, history })
        : await simpleLLMReply({ question, history });

    sessions.appendMessage(sessionId, { role: "user", content: question });
    sessions.appendMessage(sessionId, { role: "assistant", content: result.answer });

    const debug = req.query?.debug === "1";
    if (debug) {
      res.json({ sessionId, mode, ...result });
      return;
    }
    res.json({ sessionId, answer: result.answer });
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
  server.close(() => {
    process.stdout.write("server closed\n");
    process.exit(0);
  });
  // Force exit if close hangs
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.on("error", (err) => {
  process.stderr.write(`server_error: ${err?.message || err}\n`);
  // Let watch restarter bring it back
  process.exit(1);
});
