import fs from "fs";
import crypto from "node:crypto";

const LOGIN_OTP_TTL_MS = 10 * 60 * 1000;
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "../../data/users.json");

function ensureDataFile() {
  const dir = path.dirname(DATA_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_PATH)) {
    fs.writeFileSync(DATA_PATH, JSON.stringify({ users: {} }, null, 2), "utf8");
  }
}

function load() {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(DATA_PATH, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || !data.users || typeof data.users !== "object") {
      return { users: {} };
    }
    return { users: { ...data.users } };
  } catch {
    return { users: {} };
  }
}

function save(data) {
  ensureDataFile();
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), "utf8");
}

function normalizeUsername(u) {
  return String(u || "").trim();
}

function normalizeEmail(e) {
  return String(e || "").trim().toLowerCase();
}

function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function randomToken() {
  return crypto.randomBytes(32).toString("hex");
}

function canLogin(row) {
  if (!row) return false;
  if (!row.email) return true;
  return row.emailVerified === true;
}

export class UserStore {
  register({ username, password, email }) {
    const name = normalizeUsername(username);
    const pass = String(password ?? "");
    const emailNorm = normalizeEmail(email);
    if (!name) return { ok: false, error: "username is required" };
    if (!pass) return { ok: false, error: "password is required" };
    if (!emailNorm) return { ok: false, error: "email is required" };
    if (!isValidEmail(emailNorm)) return { ok: false, error: "invalid email" };
    if (name.length > 64 || pass.length > 200) return { ok: false, error: "username or password too long" };

    const data = load();
    if (data.users[name]) return { ok: false, error: "username already exists" };

    for (const k of Object.keys(data.users)) {
      const u = data.users[k];
      if (u?.email && normalizeEmail(u.email) === emailNorm) {
        return { ok: false, error: "email already registered" };
      }
    }

    const verifyToken = randomToken();
    const verifyExpires = Date.now() + 24 * 60 * 60 * 1000;

    data.users[name] = {
      password: pass,
      email: emailNorm,
      emailVerified: false,
      verifyToken,
      verifyExpires,
      resetToken: null,
      resetExpires: null,
      createdAt: Date.now()
    };
    save(data);
    return { ok: true, email: emailNorm, verifyToken };
  }

  validateLogin({ username, password }) {
    const name = normalizeUsername(username);
    const pass = String(password ?? "");
    if (!name || !pass) return { ok: false, error: "invalid credentials" };
    const data = load();
    const row = data.users[name];
    if (!row || row.password !== pass) return { ok: false, error: "invalid credentials" };
    if (!canLogin(row)) return { ok: false, error: "email_not_verified" };
    return { ok: true, username: name };
  }

  verifyEmailToken(token) {
    const t = String(token || "").trim();
    if (!t) return { ok: false, error: "token is required" };
    const data = load();
    const now = Date.now();
    for (const name of Object.keys(data.users)) {
      const u = data.users[name];
      if (u.verifyToken === t && typeof u.verifyExpires === "number" && u.verifyExpires > now) {
        u.emailVerified = true;
        u.verifyToken = null;
        u.verifyExpires = null;
        save(data);
        return { ok: true, username: name };
      }
    }
    return { ok: false, error: "invalid_or_expired_token" };
  }

  requestPasswordReset(email) {
    const emailNorm = normalizeEmail(email);
    if (!emailNorm || !isValidEmail(emailNorm)) return { ok: true };
    const data = load();
    for (const name of Object.keys(data.users)) {
      const u = data.users[name];
      if (u?.email && normalizeEmail(u.email) === emailNorm) {
        const resetToken = randomToken();
        const resetExpires = Date.now() + 60 * 60 * 1000;
        u.resetToken = resetToken;
        u.resetExpires = resetExpires;
        save(data);
        return { ok: true, email: emailNorm, resetToken };
      }
    }
    return { ok: true };
  }

  resetPasswordWithToken(token, newPassword) {
    const t = String(token || "").trim();
    const pass = String(newPassword ?? "");
    if (!t) return { ok: false, error: "token is required" };
    if (!pass) return { ok: false, error: "password is required" };
    if (pass.length > 200) return { ok: false, error: "password too long" };
    const data = load();
    const now = Date.now();
    for (const name of Object.keys(data.users)) {
      const u = data.users[name];
      if (
        u.resetToken === t &&
        typeof u.resetExpires === "number" &&
        u.resetExpires > now
      ) {
        u.password = pass;
        u.resetToken = null;
        u.resetExpires = null;
        save(data);
        return { ok: true, username: name };
      }
    }
    return { ok: false, error: "invalid_or_expired_token" };
  }

  /**
   * 为已验证邮箱生成 6 位数字登录验证码；未注册或未验证邮箱时 noop（不写入）。
   * @returns {{ ok: true, noop: true } | { ok: true, email: string, code: string }}
   */
  issueLoginCode(email) {
    const emailNorm = normalizeEmail(email);
    if (!emailNorm || !isValidEmail(emailNorm)) return { ok: false, error: "invalid email" };
    const data = load();
    for (const name of Object.keys(data.users)) {
      const u = data.users[name];
      if (u?.email && normalizeEmail(u.email) === emailNorm) {
        if (!canLogin(u)) return { ok: true, noop: true };
        const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
        u.loginOtpCode = code;
        u.loginOtpExpires = Date.now() + LOGIN_OTP_TTL_MS;
        save(data);
        return { ok: true, email: emailNorm, code };
      }
    }
    return { ok: true, noop: true };
  }

  validateLoginCode(email, code) {
    const emailNorm = normalizeEmail(email);
    const c = String(code ?? "").trim();
    if (!emailNorm || !isValidEmail(emailNorm)) return { ok: false, error: "invalid credentials" };
    if (!/^\d{6}$/.test(c)) return { ok: false, error: "invalid credentials" };
    const data = load();
    const now = Date.now();
    for (const name of Object.keys(data.users)) {
      const u = data.users[name];
      if (u?.email && normalizeEmail(u.email) === emailNorm) {
        if (
          u.loginOtpCode &&
          u.loginOtpCode === c &&
          typeof u.loginOtpExpires === "number" &&
          u.loginOtpExpires > now
        ) {
          u.loginOtpCode = null;
          u.loginOtpExpires = null;
          save(data);
          return { ok: true, username: name };
        }
        return { ok: false, error: "invalid credentials" };
      }
    }
    return { ok: false, error: "invalid credentials" };
  }

  resendVerification(email) {
    const emailNorm = normalizeEmail(email);
    if (!emailNorm || !isValidEmail(emailNorm)) return { ok: false, error: "invalid email" };
    const data = load();
    for (const name of Object.keys(data.users)) {
      const u = data.users[name];
      if (u?.email && normalizeEmail(u.email) === emailNorm) {
        if (u.emailVerified) return { ok: false, error: "already_verified" };
        const verifyToken = randomToken();
        const verifyExpires = Date.now() + 24 * 60 * 60 * 1000;
        u.verifyToken = verifyToken;
        u.verifyExpires = verifyExpires;
        save(data);
        return { ok: true, email: emailNorm, verifyToken };
      }
    }
    return { ok: false, error: "email_not_found" };
  }
}
