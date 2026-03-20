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

async function requestChat({ baseUrl, sessionId, question, debug }) {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/chat${debug ? "?debug=1" : ""}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
const sessionId = readArg("sessionId") || process.env.SMOKE_SESSION_ID || "smoke";
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
  const sid = safeFilePart(sessionId || "smoke");
  return path.join(logDir, `smoke-${ts}-${sid}.json`);
})();

const record = {
  ts: new Date().toISOString(),
  sessionId,
  question,
  debug,
  ok: false,
  status: 0
};

try {
  const result = await requestChat({ baseUrl, sessionId, question, debug });
  record.ok = result.ok;
  record.status = result.status;
  record.answer = result.data?.answer;
  if (debug) {
    record.plan = result.data?.plan;
    record.observations = result.data?.observations;
    record.trace = result.data?.trace;
  }
  await writeJsonFile(logPath, record);
  process.stdout.write(`${result.ok ? "OK" : "FAIL"} ${result.status}\n${logPath}\n`);
} catch (e) {
  record.error = e?.message || "unknown_error";
  await writeJsonFile(logPath, record);
  process.stdout.write(`ERROR\n${record.error}\n${logPath}\n`);
  process.exitCode = 1;
}
