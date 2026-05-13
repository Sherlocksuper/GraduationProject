import crypto from "node:crypto";

/** 默认 30 天；服务端重启不失效 */
const TTL_SEC = 60 * 60 * 24 * 30;

export function getJwtSecret() {
  return String(process.env.JWT_SECRET || "graduation-project-dev-jwt-secret");
}

export function signAuthToken(username) {
  const sub = String(username || "").trim();
  if (!sub) throw new Error("invalid_subject");
  const secret = getJwtSecret();
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8").toString(
    "base64url"
  );
  const payload = Buffer.from(
    JSON.stringify({ sub, iat: now, exp: now + TTL_SEC }),
    "utf8"
  ).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const sig = crypto.createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${sig}`;
}

export function verifyAuthToken(token) {
  const secret = getJwtSecret();
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const signingInput = `${h}.${p}`;
  const expected = crypto.createHmac("sha256", secret).update(signingInput).digest("base64url");
  const expBuf = Buffer.from(expected, "utf8");
  const sigBuf = Buffer.from(s, "utf8");
  if (expBuf.length !== sigBuf.length || !crypto.timingSafeEqual(expBuf, sigBuf)) {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && now > payload.exp) return null;
  const sub = payload.sub;
  if (typeof sub !== "string" || !sub.trim()) return null;
  return { username: sub.trim() };
}

export function bearerToken(req) {
  const h = req.headers.authorization;
  if (!h || typeof h !== "string") return null;
  const m = h.match(/^\s*Bearer\s+(\S+)\s*$/i);
  return m ? m[1] : null;
}
