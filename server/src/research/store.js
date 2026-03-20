function newId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class ResearchStore {
  constructor({ maxTasks = 200 } = {}) {
    this.maxTasks = maxTasks;
    this.tasks = new Map();
  }

  createTask({ topic }) {
    const id = newId();
    const now = Date.now();
    const task = {
      id,
      topic: String(topic || "").trim(),
      status: "created",
      createdAt: now,
      updatedAt: now,
      error: null,
      artifacts: {},
      trace: []
    };
    this.evictIfNeeded();
    this.tasks.set(id, task);
    return task;
  }

  getTask(taskId) {
    const id = String(taskId || "").trim();
    if (!id) return null;
    return this.tasks.get(id) || null;
  }

  setStatus(taskId, status) {
    const t = this.getTask(taskId);
    if (!t) return null;
    t.status = status;
    t.updatedAt = Date.now();
    return t;
  }

  setError(taskId, error) {
    const t = this.getTask(taskId);
    if (!t) return null;
    t.status = "failed";
    t.error = String(error?.message || error || "unknown_error");
    t.updatedAt = Date.now();
    return t;
  }

  putArtifact(taskId, name, value) {
    const t = this.getTask(taskId);
    if (!t) return null;
    t.artifacts[name] = value;
    t.updatedAt = Date.now();
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
    return t;
  }

  evictIfNeeded() {
    if (this.tasks.size < this.maxTasks) return;
    const oldest = Array.from(this.tasks.values()).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) this.tasks.delete(oldest.id);
  }
}

