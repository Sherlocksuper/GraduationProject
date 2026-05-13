import fs from "node:fs/promises";
import path from "node:path";

function readArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const val = process.argv[idx + 1];
  return val && !val.startsWith("--") ? val : "";
}

function safeFilePart(s) {
  return String(s || "")
    .trim()
    .slice(0, 64)
    .replace(/[^\w.-]+/g, "_");
}

function formatTsForFile(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

async function writeJsonFile(filePath, obj) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

async function loginJwt({ baseUrl, username, password }) {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/auth/login`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`login failed: ${resp.status} ${data?.error || JSON.stringify(data)}`);
  }
  const token = data?.token;
  if (!token || typeof token !== "string") {
    throw new Error("login ok but no token in JSON body");
  }
  return token;
}

async function createChatSession({ baseUrl, bearer }) {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/chats`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` }
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`create chat failed: ${resp.status} ${data?.error || JSON.stringify(data)}`);
  }
  const id = data?.chat?.id;
  if (!id) throw new Error("create chat: missing chat.id");
  return id;
}

async function requestChat({ baseUrl, sessionId, question, debug, bearer }) {
  const q = new URLSearchParams();
  q.set("sync", "1");
  if (debug) q.set("debug", "1");
  const url = `${baseUrl.replace(/\/+$/, "")}/api/chat?${q.toString()}`;
  const headers = { "Content-Type": "application/json" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionId, question })
  });
  const text = await resp.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: resp.status, ok: resp.ok, url, data };
}

const baseUrl = readArg("baseUrl") || process.env.SMOKE_BASE_URL || "http://localhost:3001";
const chatIdArg =
  readArg("chatId") || process.env.SMOKE_CHAT_ID || readArg("sessionId") || process.env.SMOKE_SESSION_ID || "";
const smokeUser = process.env.SMOKE_USER || "";
const smokePass = process.env.SMOKE_PASS || "";
const debug = (readArg("debug") || process.env.SMOKE_DEBUG || "1") !== "0";
const question =
  readArg("question") ||
  process.env.SMOKE_QUESTION ||
  "先告诉我现在时间，然后算 12*(3+4)，最后用一句话总结。";

const root = path.resolve(process.cwd(), "..");
const logDir =
  readArg("logDir") || process.env.SMOKE_LOG_DIR || path.join(root, "docs", "debug", "runs");
const logPath = (() => {
  const direct = readArg("logPath") || process.env.SMOKE_LOG_PATH;
  if (direct) return direct;
  const now = new Date();
  const ts = formatTsForFile(now);
  const sid = safeFilePart(chatIdArg || "smoke");
  return path.join(logDir, `smoke-${ts}-${sid}.json`);
})();

const record = {
  ts: new Date().toISOString(),
  chatId: chatIdArg,
  question,
  debug,
  ok: false,
  status: 0
};

try {
  let bearer = "";
  if (smokeUser && smokePass) {
    bearer = await loginJwt({ baseUrl, username: smokeUser, password: smokePass });
  } else {
    throw new Error("Set SMOKE_USER and SMOKE_PASS (account must exist; register once in the web UI).");
  }
  const sessionId = chatIdArg || (await createChatSession({ baseUrl, bearer }));
  record.chatId = sessionId;
  const result = await requestChat({ baseUrl, sessionId, question, debug, bearer });
  record.ok = result.ok;
  record.status = result.status;
  record.answer = result.data?.answer;
  if (debug) {
    record.mode = result.data?.mode;
    record.taskId = result.data?.taskId;
    record.trace = result.data?.trace;
    record.plan = result.data?.plan;
    record.observations = result.data?.observations;
  }
  await writeJsonFile(logPath, record);
  process.stdout.write(`${result.ok ? "OK" : "FAIL"} ${result.status}\n${logPath}\n`);
} catch (e) {
  record.error = e?.message || "unknown_error";
  await writeJsonFile(logPath, record);
  process.stdout.write(`ERROR\n${record.error}\n${logPath}\n`);
  process.exitCode = 1;
}
