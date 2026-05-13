import { bearerToken, verifyAuthToken } from "./jwt.js";

export function requireLogin(req, res, next) {
  const token = bearerToken(req);
  const v = token ? verifyAuthToken(token) : null;
  if (!v) return res.status(401).json({ error: "unauthorized" });
  req.user = { username: v.username };
  next();
}
