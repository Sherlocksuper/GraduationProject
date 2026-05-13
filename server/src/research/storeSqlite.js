import crypto from "node:crypto";

function newId() {
  return `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function parseTask(row) {
  if (!row) return null;
  let artifacts = {};
  let trace = [];
  try {
    artifacts = JSON.parse(row.artifacts_json || "{}");
  } catch {
    artifacts = {};
  }
  try {
    trace = JSON.parse(row.trace_json || "[]");
  } catch {
    trace = [];
  }
  if (!Array.isArray(trace)) trace = [];
  return {
    id: row.id,
    username: row.username,
    topic: row.topic,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.error,
    artifacts,
    trace
  };
}

export class ResearchStoreSqlite {
  constructor(db, { maxTasksPerUser = 200 } = {}) {
    this.db = db;
    this.maxTasksPerUser = maxTasksPerUser;
    this.insertTask = db.prepare(`
      INSERT INTO research_tasks (id, username, topic, status, error, created_at, updated_at, artifacts_json, trace_json)
      VALUES (?, ?, ?, ?, NULL, ?, ?, '{}', '[]')
    `);
    this.selectTask = db.prepare(`SELECT * FROM research_tasks WHERE id = ?`);
    this.updateFull = db.prepare(`
      UPDATE research_tasks
      SET status = ?, error = ?, updated_at = ?, artifacts_json = ?, trace_json = ?
      WHERE id = ?
    `);
    this.deleteTask = db.prepare(`DELETE FROM research_tasks WHERE id = ? AND username = ?`);
    this.countForUser = db.prepare(`SELECT COUNT(*) AS c FROM research_tasks WHERE username = ?`);
    this.oldestIdForUser = db.prepare(
      `SELECT id FROM research_tasks WHERE username = ? ORDER BY created_at ASC LIMIT 1`
    );
  }

  evictIfNeeded(username) {
    const u = String(username || "").trim();
    if (!u) return;
    while (this.countForUser.get(u).c > this.maxTasksPerUser) {
      const row = this.oldestIdForUser.get(u);
      if (!row) break;
      this.db.prepare(`DELETE FROM research_tasks WHERE id = ?`).run(row.id);
    }
  }

  createTask({ topic, username }) {
    const u = String(username || "").trim();
    if (!u) throw new Error("username required");
    this.evictIfNeeded(u);
    const id = newId();
    const now = Date.now();
    const t = String(topic || "").trim();
    this.insertTask.run(id, u, t, "created", now, now);
    return parseTask(this.selectTask.get(id));
  }

  getTask(taskId) {
    const id = String(taskId || "").trim();
    if (!id) return null;
    return parseTask(this.selectTask.get(id));
  }

  getTaskForUser(taskId, username) {
    const t = this.getTask(taskId);
    const u = String(username || "").trim();
    if (!t || t.username !== u) return null;
    return t;
  }

  _persist(t) {
    this.updateFull.run(
      t.status,
      t.error,
      t.updatedAt,
      JSON.stringify(t.artifacts || {}),
      JSON.stringify(t.trace || []),
      t.id
    );
  }

  setStatus(taskId, status) {
    const t = this.getTask(taskId);
    if (!t) return null;
    t.status = status;
    t.updatedAt = Date.now();
    this._persist(t);
    return t;
  }

  setError(taskId, error) {
    const t = this.getTask(taskId);
    if (!t) return null;
    t.status = "failed";
    t.error = String(error?.message || error || "unknown_error");
    t.updatedAt = Date.now();
    this._persist(t);
    return t;
  }

  putArtifact(taskId, name, value) {
    const t = this.getTask(taskId);
    if (!t) return null;
    t.artifacts[name] = value;
    t.updatedAt = Date.now();
    this._persist(t);
    return t;
  }

  addTraceEvent(taskId, event) {
    const t = this.getTask(taskId);
    if (!t) return null;
    t.trace.push({
      ts: new Date().toISOString(),
      ...event
    });
    t.updatedAt = Date.now();
    this._persist(t);
    return t;
  }

  listForUser(username) {
    const u = String(username || "").trim();
    if (!u) return [];
    const rows = this.db
      .prepare(
        `SELECT id, topic, status, error, created_at, updated_at FROM research_tasks WHERE username = ? ORDER BY updated_at DESC LIMIT 200`
      )
      .all(u);
    return rows.map((r) => ({
      id: r.id,
      topic: r.topic,
      status: r.status,
      error: r.error,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }));
  }

  deleteForUser(username, taskId) {
    const id = String(taskId || "").trim();
    const u = String(username || "").trim();
    return this.deleteTask.run(id, u).changes > 0;
  }
}
