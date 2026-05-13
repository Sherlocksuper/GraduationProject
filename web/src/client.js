export const TOKEN_KEY = "gp_auth_token";

export const jsonHeaders = { "Content-Type": "application/json" };

export function readStoredToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function writeStoredToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export function apiFetch(url, options = {}) {
  const t = readStoredToken();
  const auth = t ? { Authorization: `Bearer ${t}` } : {};
  const headers = { ...auth, ...(options.headers || {}) };
  return fetch(url, { ...options, credentials: "include", headers });
}

export function clearSessionIfUnauthorized(resp, setUser) {
  if (resp.status === 401) {
    writeStoredToken("");
    setUser(null);
    return true;
  }
  return false;
}

/** 将后端 { error, detail } 拼成可读提示 */
export function apiErrorMessage(data, httpStatus) {
  const d = data || {};
  if (d.detail) return `${d.error || "error"}: ${d.detail}`;
  return d.error || `HTTP ${httpStatus}`;
}
