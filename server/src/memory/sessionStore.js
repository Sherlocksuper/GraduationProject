export class SessionStore {
  constructor({ maxSessions = 500, maxMessages = 50 } = {}) {
    this.maxSessions = maxSessions;
    this.maxMessages = maxMessages;
    this.sessions = new Map();
  }

  get(sessionId) {
    const id = String(sessionId || "").trim();
    if (!id) return null;
    return this.sessions.get(id) || null;
  }

  ensure(sessionId) {
    const id = String(sessionId || "").trim();
    if (!id) throw new Error("sessionId is required");
    let s = this.sessions.get(id);
    if (!s) {
      this.evictIfNeeded();
      s = { id, createdAt: Date.now(), messages: [] };
      this.sessions.set(id, s);
    }
    return s;
  }

  appendMessage(sessionId, message) {
    const s = this.ensure(sessionId);
    s.messages.push({
      role: message.role,
      content: String(message.content || ""),
      ts: Date.now()
    });
    if (s.messages.length > this.maxMessages) {
      s.messages.splice(0, s.messages.length - this.maxMessages);
    }
    return s;
  }

  evictIfNeeded() {
    if (this.sessions.size < this.maxSessions) return;
    const oldest = Array.from(this.sessions.values()).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) this.sessions.delete(oldest.id);
  }
}

