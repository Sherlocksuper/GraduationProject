import { useSyncExternalStore } from "react";

const STORAGE_KEY = "magent_prefs_v1";

/** ragMinScore：0 关闭；>0 为余弦相似度下限（最高分低于则整轮不注入 RAG）。 */
/**
 * @typedef {{
 *   version: number,
 *   displayNames: Record<string, string>,
 *   traceHighlight: Record<string, boolean>,
 *   dialogueTone: "balanced" | "concise" | "detailed",
 *   chatRouteMode: "auto" | "simple" | "deep",
 *   ragTopK: number,
 *   ragMinScore: number,
 *   ragSnippetMaxChars: number,
 *   simpleChatTemperature: number,
 *   simpleChatMaxTokens: number,
 *   traceTailCount: number,
 *   plannerMaxTokens: number,
 *   plannerTemperature: number,
 *   writerMaxTokens: number,
 *   readerMaxTokens: number,
 *   readerMaxSources: number,
 *   readerClipChars: number,
 *   fetcherPreferKbOnly: boolean,
 *   criticRewriteMaxTokens: number
 * }} AgentPrefs
 */

function clampInt(n, lo, hi, d) {
  const x = Math.floor(Number(n));
  if (!Number.isFinite(x)) return d;
  return Math.max(lo, Math.min(hi, x));
}

function clampFloat(n, lo, hi, d) {
  const x = Number(n);
  if (!Number.isFinite(x)) return d;
  return Math.max(lo, Math.min(hi, x));
}

function defaultPrefsMutable() {
  return {
    version: 1,
    displayNames: {},
    traceHighlight: {},
    dialogueTone: "balanced",
    chatRouteMode: "auto",
    ragTopK: 6,
    ragMinScore: 0,
    ragSnippetMaxChars: 1200,
    simpleChatTemperature: 0.35,
    simpleChatMaxTokens: 2048,
    traceTailCount: 10,
    plannerMaxTokens: 1200,
    plannerTemperature: 0.2,
    writerMaxTokens: 560,
    readerMaxTokens: 900,
    readerMaxSources: 3,
    readerClipChars: 2400,
    fetcherPreferKbOnly: false,
    criticRewriteMaxTokens: 1200
  };
}

/** 与 parse 后的默认语义一致；勿就地 mutate */
const EMPTY_SNAPSHOT = Object.freeze({
  version: 1,
  displayNames: Object.freeze({}),
  traceHighlight: Object.freeze({}),
  dialogueTone: "balanced",
  chatRouteMode: "auto",
  ragTopK: 6,
  ragMinScore: 0,
  ragSnippetMaxChars: 1200,
  simpleChatTemperature: 0.35,
  simpleChatMaxTokens: 2048,
  traceTailCount: 10,
  plannerMaxTokens: 1200,
  plannerTemperature: 0.2,
  writerMaxTokens: 560,
  readerMaxTokens: 900,
  readerMaxSources: 3,
  readerClipChars: 2400,
  fetcherPreferKbOnly: false,
  criticRewriteMaxTokens: 1200
});

function parsePrefs(raw) {
  const def = defaultPrefsMutable();
  try {
    const j = JSON.parse(String(raw || "{}"));
    if (!j || typeof j !== "object") return { ...def };
    const displayNames =
      j.displayNames && typeof j.displayNames === "object" ? { ...j.displayNames } : {};
    const traceHighlight =
      j.traceHighlight && typeof j.traceHighlight === "object" ? { ...j.traceHighlight } : {};
    const dialogueTone = ["balanced", "concise", "detailed"].includes(j.dialogueTone)
      ? j.dialogueTone
      : "balanced";
    const chatRouteMode = ["auto", "simple", "deep"].includes(j.chatRouteMode) ? j.chatRouteMode : "auto";
    return {
      ...def,
      displayNames,
      traceHighlight,
      dialogueTone,
      chatRouteMode,
      ragTopK: clampInt(j.ragTopK, 1, 16, def.ragTopK),
      ragMinScore: clampFloat(j.ragMinScore, 0, 0.99, def.ragMinScore),
      ragSnippetMaxChars: clampInt(j.ragSnippetMaxChars, 400, 4000, def.ragSnippetMaxChars),
      simpleChatTemperature: clampFloat(j.simpleChatTemperature, 0.05, 0.99, def.simpleChatTemperature),
      simpleChatMaxTokens: clampInt(j.simpleChatMaxTokens, 256, 4096, def.simpleChatMaxTokens),
      traceTailCount: clampInt(j.traceTailCount, 5, 40, def.traceTailCount),
      plannerMaxTokens: clampInt(j.plannerMaxTokens, 400, 2000, def.plannerMaxTokens),
      plannerTemperature: clampFloat(j.plannerTemperature, 0, 0.9, def.plannerTemperature),
      writerMaxTokens: clampInt(j.writerMaxTokens, 320, 2000, def.writerMaxTokens),
      readerMaxTokens: clampInt(j.readerMaxTokens, 400, 2000, def.readerMaxTokens),
      readerMaxSources: clampInt(j.readerMaxSources, 2, 8, def.readerMaxSources),
      readerClipChars: clampInt(j.readerClipChars, 600, 8000, def.readerClipChars),
      fetcherPreferKbOnly:
        j.fetcherPreferKbOnly === true || j.fetcherPreferKbOnly === "true" || j.fetcherPreferKbOnly === 1,
      criticRewriteMaxTokens: clampInt(j.criticRewriteMaxTokens, 400, 2400, def.criticRewriteMaxTokens)
    };
  } catch {
    return { ...def };
  }
}

/** 供设置页「恢复默认」等 */
export function createDefaultAgentPrefs() {
  return defaultPrefsMutable();
}

/** localStorage 原始串未变时复用同一 prefs 引用，满足 useSyncExternalStore 对 getSnapshot 的缓存要求 */
let cachedRaw = /** @type {string | null} */ (null);
let cachedSnapshot = /** @type {AgentPrefs} */ (EMPTY_SNAPSHOT);

function readRaw() {
  if (typeof window === "undefined") return null;
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === null || v === undefined ? "" : String(v);
}

function getSnapshot() {
  const raw = readRaw();
  if (raw === null) return EMPTY_SNAPSHOT;
  if (raw === cachedRaw && cachedSnapshot) return cachedSnapshot;
  cachedRaw = raw;
  if (!raw.trim()) {
    cachedSnapshot = EMPTY_SNAPSHOT;
    return cachedSnapshot;
  }
  cachedSnapshot = parsePrefs(raw);
  return cachedSnapshot;
}

function getServerSnapshot() {
  return EMPTY_SNAPSHOT;
}

export function loadAgentPrefs() {
  return getSnapshot();
}

/** @param {Partial<AgentPrefs> & Record<string, unknown>} prefs */
export function saveAgentPrefs(prefs) {
  if (typeof window === "undefined") return;
  const merged = { ...defaultPrefsMutable(), ...prefs, version: 1 };
  const next = JSON.stringify(merged);
  window.localStorage.setItem(STORAGE_KEY, next);
  cachedRaw = next;
  cachedSnapshot = parsePrefs(next);
  window.dispatchEvent(new Event("magent-prefs-changed"));
}

function subscribe(cb) {
  if (typeof window === "undefined") return () => {};
  const onStorage = (e) => {
    if (e.key === STORAGE_KEY || e.key === null) cb();
  };
  const onCustom = () => cb();
  window.addEventListener("storage", onStorage);
  window.addEventListener("magent-prefs-changed", onCustom);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("magent-prefs-changed", onCustom);
  };
}

export function useAgentPrefs() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** @param {string} agentId @param {AgentPrefs} prefs */
export function resolveAgentLabel(agentId, prefs) {
  const id = String(agentId || "").trim();
  const nick = String(prefs?.displayNames?.[id] || "").trim();
  return nick || id || "—";
}

/** @param {string} agentId @param {AgentPrefs} prefs */
export function isAgentTraceHighlighted(agentId, prefs) {
  return Boolean(prefs?.traceHighlight?.[String(agentId || "").trim()]);
}
