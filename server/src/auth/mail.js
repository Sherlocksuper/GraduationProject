import dns from "node:dns";
import nodemailer from "nodemailer";

try {
  if (typeof dns.setDefaultResultOrder === "function") {
    dns.setDefaultResultOrder("ipv4first");
  }
} catch {
  /* ignore */
}

function getPublicBase() {
  return String(process.env.PUBLIC_APP_URL || "http://localhost:5173").replace(/\/+$/, "");
}

export function isSmtpConfigured() {
  const u = process.env.SMTP_USER?.trim();
  const p = process.env.SMTP_PASS?.trim();
  return Boolean(u && p);
}

/**
 * QQ 邮箱：优先用 nodemailer 内置的 QQ 预设（smtp.qq.com:465 + SSL），比手写 host/port 更稳。
 * 授权码为邮箱「设置 → 账户 → 开启 SMTP」生成的 16 位码，不是 QQ 登录密码。
 */
function createTransport() {
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  if (!user || !pass) return null;

  const forceManual = process.env.SMTP_USE_MANUAL === "1";
  const isQq = /@qq\.com$/i.test(user);

  if (isQq && !forceManual) {
    return nodemailer.createTransport({
      service: "QQ",
      auth: { user, pass }
    });
  }

  const port = Number(process.env.SMTP_PORT || 465);
  const useStarttls = port === 587;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.qq.com",
    port,
    secure: !useStarttls && port === 465,
    requireTLS: useStarttls,
    auth: { user, pass },
    tls: { minVersion: "TLSv1.2" },
    connectionTimeout: 25_000,
    greetingTimeout: 25_000
  });
}

export async function sendVerificationEmail(to, token) {
  const transport = createTransport();
  if (!transport) throw new Error("SMTP not configured");
  const link = `${getPublicBase()}/?verify=${encodeURIComponent(token)}`;
  const fromAddr = process.env.SMTP_USER?.trim();
  const from = process.env.SMTP_FROM || `DeepResearch <${fromAddr}>`;
  await transport.sendMail({
    from,
    to,
    subject: "【DeepResearch】请验证您的邮箱",
    text: `请复制到浏览器打开（24 小时内有效）：\n${link}\n\n如非本人注册请忽略。`,
    html: `<p>请点击链接完成邮箱验证（24 小时内有效）：</p><p><a href="${link}">${link}</a></p><p>如非本人注册请忽略。</p>`
  });
}

export async function sendLoginCodeEmail(to, code) {
  const transport = createTransport();
  if (!transport) throw new Error("SMTP not configured");
  const fromAddr = process.env.SMTP_USER?.trim();
  const from = process.env.SMTP_FROM || `DeepResearch <${fromAddr}>`;
  const c = String(code || "").trim();
  await transport.sendMail({
    from,
    to,
    subject: "【DeepResearch】登录验证码",
    text: `您的登录验证码为：${c}\n10 分钟内有效。如非本人操作请忽略。`,
    html: `<p>您的登录验证码为：</p><p style="font-size:22px;font-weight:700;letter-spacing:4px;">${c}</p><p>10 分钟内有效。如非本人操作请忽略。</p>`
  });
}

export async function sendPasswordResetEmail(to, token) {
  const transport = createTransport();
  if (!transport) throw new Error("SMTP not configured");
  const link = `${getPublicBase()}/?reset=${encodeURIComponent(token)}`;
  const fromAddr = process.env.SMTP_USER?.trim();
  const from = process.env.SMTP_FROM || `DeepResearch <${fromAddr}>`;
  await transport.sendMail({
    from,
    to,
    subject: "【DeepResearch】重置密码",
    text: `请复制到浏览器打开（1 小时内有效）：\n${link}\n\n如非本人操作请忽略。`,
    html: `<p>请点击链接重置密码（1 小时内有效）：</p><p><a href="${link}">${link}</a></p><p>如非本人操作请忽略。</p>`
  });
}
