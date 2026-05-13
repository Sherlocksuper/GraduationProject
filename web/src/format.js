export function formatTime(ts) {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function formatDateTime(ts) {
  try {
    const d = new Date(ts);
    return d.toLocaleString([], {
      hour: "2-digit",
      minute: "2-digit",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
  } catch {
    return "";
  }
}

export function clip(s, n) {
  const t = String(s || "").trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n)}…`;
}
