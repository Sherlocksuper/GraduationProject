import crypto from "node:crypto";

const MAX_MESSAGES = 50;

/** JSON 里可能出现 null，经 String 会变成字面量 "null"，会导致 owns 校验失败 */
export function normalizeRagCollectionIdsArray(arr) {
  if (!Array.isArray(arr)) return [];
  return [
    ...new Set(
      arr
        .map((x) => String(x ?? "").trim())
        .filter((t) => t && t !== "null" && t !== "undefined")
    )
  ];
}

function parseRagCollectionIdsJson(raw) {
  try {
    const j = JSON.parse(String(raw ?? "[]"));
    if (!Array.isArray(j)) return [];
    return normalizeRagCollectionIdsArray(j);
  } catch {
    return [];
  }
}

function parseMessageMeta(raw) {
  if (raw == null || raw === "") return {};
  try {
    const j = JSON.parse(String(raw));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

export class ChatRepository {
  constructor(db) {
    this.db = db;
    this.insertSession = db.prepare(
      `INSERT INTO chat_sessions (id, username, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    );
    this.insertMessage = db.prepare(
      `INSERT INTO chat_messages (session_id, role, content, ts, meta_json) VALUES (?, ?, ?, ?, ?)`
    );
    this.updateSessionMeta = db.prepare(
      `UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ? AND username = ?`
    );
    this.touchSession = db.prepare(`UPDATE chat_sessions SET updated_at = ? WHERE id = ? AND username = ?`);
    this.selectSession = db.prepare(`SELECT * FROM chat_sessions WHERE id = ? AND username = ?`);
    this.listSessions = db.prepare(
      `SELECT id, title, created_at, updated_at, rag_collection_ids_json FROM chat_sessions WHERE username = ? ORDER BY updated_at DESC LIMIT 200`
    );
    this.updateSessionRagIds = db.prepare(
      `UPDATE chat_sessions SET rag_collection_ids_json = ?, updated_at = ? WHERE id = ? AND username = ?`
    );
    this.deleteSession = db.prepare(`DELETE FROM chat_sessions WHERE id = ? AND username = ?`);
    this.selectMessages = db.prepare(
      `SELECT id, role, content, ts, meta_json FROM chat_messages WHERE session_id = ? ORDER BY id ASC`
    );
    this.listMessageIdsDesc = db.prepare(
      `SELECT id FROM chat_messages WHERE session_id = ? ORDER BY id DESC`
    );
    this.deleteMessageById = db.prepare(`DELETE FROM chat_messages WHERE id = ?`);
  }

  _trimMessages(sessionId) {
    const rows = this.listMessageIdsDesc.all(sessionId);
    if (rows.length <= MAX_MESSAGES) return;
    const drop = rows.slice(MAX_MESSAGES);
    const tx = this.db.transaction(() => {
      for (const r of drop) this.deleteMessageById.run(r.id);
    });
    tx();
  }

  ownsSession(username, sessionId) {
    const sid = String(sessionId || "").trim();
    const u = String(username || "").trim();
    if (!sid || !u) return false;
    const row = this.selectSession.get(sid, u);
    return Boolean(row);
  }

  list(username) {
    const u = String(username || "").trim();
    if (!u) return [];
    return this.listSessions.all(u).map((r) => ({
      id: r.id,
      title: r.title || "新对话",
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      ragCollectionIds: parseRagCollectionIdsJson(r.rag_collection_ids_json)
    }));
  }

  /**
   * @returns {string[]}
   */
  getRagCollectionIds(username, sessionId) {
    const sid = String(sessionId || "").trim();
    const u = String(username || "").trim();
    if (!this.ownsSession(u, sid)) return [];
    const row = this.selectSession.get(sid, u);
    if (!row) return [];
    return parseRagCollectionIdsJson(row.rag_collection_ids_json);
  }

  /**
   * @param {string[]} ids
   * @returns {boolean}
   */
  setRagCollectionIds(username, sessionId, ids) {
    const sid = String(sessionId || "").trim();
    const u = String(username || "").trim();
    if (!this.ownsSession(u, sid)) return false;
    const list = Array.isArray(ids) ? ids : [];
    const json = JSON.stringify(list);
    const now = Date.now();
    this.updateSessionRagIds.run(json, now, sid, u);
    return true;
  }

  /** 与 list() 中单条结构一致，供 PATCH 返回 */
  getSessionSummary(username, sessionId) {
    const sid = String(sessionId || "").trim();
    const u = String(username || "").trim();
    const row = this.selectSession.get(sid, u);
    if (!row) return null;
    return {
      id: row.id,
      title: row.title || "新对话",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ragCollectionIds: parseRagCollectionIdsJson(row.rag_collection_ids_json)
    };
  }

  create(username) {
    const u = String(username || "").trim();
    if (!u) throw new Error("username required");
    const id = crypto.randomUUID();
    const now = Date.now();
    const title = "";
    const tx = this.db.transaction(() => {
      this.insertSession.run(id, u, title, now, now);
      this.insertMessage.run(
        id,
        "assistant",
        "你好！请输入你的问题。每次回复将经过规划、联网检索与报告式写作（耗时可能较长，请耐心等待）。",
        now,
        null
      );
    });
    tx();
    return { id, title: "新对话", createdAt: now, updatedAt: now, ragCollectionIds: [] };
  }

  getMessages(username, sessionId) {
    const sid = String(sessionId || "").trim();
    const u = String(username || "").trim();
    if (!this.ownsSession(u, sid)) return null;
    const rows = this.selectMessages.all(sid);
    return rows.map((r) => ({
      id: String(r.id),
      role: r.role,
      content: r.content,
      ts: r.ts,
      meta: parseMessageMeta(r.meta_json)
    }));
  }

  appendMessage(username, sessionId, { role, content, meta }) {
    const sid = String(sessionId || "").trim();
    const u = String(username || "").trim();
    if (!this.ownsSession(u, sid)) return null;
    const now = Date.now();
    const r = String(role || "");
    const c = String(content || "");
    const metaJson =
      meta != null && typeof meta === "object" && Object.keys(meta).length
        ? JSON.stringify(meta)
        : null;
    const tx = this.db.transaction(() => {
      this.insertMessage.run(sid, r, c, now, metaJson);
      this.touchSession.run(now, sid, u);
      if (r === "user") {
        const row = this.selectSession.get(sid, u);
        if (row && !(row.title && String(row.title).trim())) {
          const snippet = c.trim().slice(0, 48) || "新对话";
          this.updateSessionMeta.run(snippet, now, sid, u);
        }
      }
      this._trimMessages(sid);
    });
    tx();
    return this.getMessages(u, sid);
  }

  delete(username, sessionId) {
    const sid = String(sessionId || "").trim();
    const u = String(username || "").trim();
    const r = this.deleteSession.run(sid, u);
    return r.changes > 0;
  }
}
