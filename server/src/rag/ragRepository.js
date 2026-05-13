import crypto from "node:crypto";

function newId() {
  return crypto.randomUUID();
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return -1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const den = Math.sqrt(na) * Math.sqrt(nb);
  return den === 0 ? 0 : dot / den;
}

export class RagRepository {
  constructor(db) {
    this.db = db;
    this.insertCollection = db.prepare(
      `INSERT INTO rag_collections (id, username, name, embedding_model, created_at) VALUES (?, ?, ?, ?, ?)`
    );
    this.listCollectionsWithCounts = db.prepare(
      `SELECT c.id, c.name, c.embedding_model, c.created_at,
        COALESCE((SELECT COUNT(*) FROM rag_chunks rc WHERE rc.collection_id = c.id), 0) AS chunk_count
       FROM rag_collections c
       WHERE c.username = ?
       ORDER BY c.created_at DESC
       LIMIT 200`
    );
    this.selectCollection = db.prepare(`SELECT * FROM rag_collections WHERE id = ? AND username = ?`);
    this.deleteCollection = db.prepare(`DELETE FROM rag_collections WHERE id = ? AND username = ?`);
    this.deleteChunks = db.prepare(`DELETE FROM rag_chunks WHERE collection_id = ?`);
    this.insertChunk = db.prepare(
      `INSERT INTO rag_chunks (collection_id, chunk_index, content, embedding_json) VALUES (?, ?, ?, ?)`
    );
    this.selectChunks = db.prepare(
      `SELECT id, chunk_index, content, embedding_json FROM rag_chunks WHERE collection_id = ? ORDER BY chunk_index ASC`
    );
    this.selectChunkByPk = db.prepare(
      `SELECT id, collection_id, chunk_index, content, embedding_json FROM rag_chunks WHERE id = ? AND collection_id = ?`
    );
    this.countChunks = db.prepare(`SELECT COUNT(*) AS c FROM rag_chunks WHERE collection_id = ?`);
    this.listChunksPaged = db.prepare(`
      SELECT id, chunk_index, content,
        COALESCE(json_array_length(embedding_json), 0) AS embedding_dim
      FROM rag_chunks WHERE collection_id = ?
      ORDER BY chunk_index ASC LIMIT ? OFFSET ?
    `);
    this.listChunksPagedSearch = db.prepare(`
      SELECT id, chunk_index, content,
        COALESCE(json_array_length(embedding_json), 0) AS embedding_dim
      FROM rag_chunks WHERE collection_id = ?
        AND (instr(lower(content), ?) > 0 OR instr(CAST(chunk_index AS TEXT), ?) > 0)
      ORDER BY chunk_index ASC LIMIT ? OFFSET ?
    `);
    this.countChunksSearch = db.prepare(`
      SELECT COUNT(*) AS c FROM rag_chunks WHERE collection_id = ?
        AND (instr(lower(content), ?) > 0 OR instr(CAST(chunk_index AS TEXT), ?) > 0)
    `);
    this.maxChunkIndex = db.prepare(`SELECT MAX(chunk_index) AS m FROM rag_chunks WHERE collection_id = ?`);
    this.updateCollectionName = db.prepare(`UPDATE rag_collections SET name = ? WHERE id = ? AND username = ?`);
    this.updateChunkRow = db.prepare(
      `UPDATE rag_chunks SET content = ?, embedding_json = ? WHERE id = ? AND collection_id = ?`
    );
    this.deleteChunkRow = db.prepare(`DELETE FROM rag_chunks WHERE id = ? AND collection_id = ?`);
  }

  owns(username, collectionId) {
    const row = this.selectCollection.get(String(collectionId || "").trim(), String(username || "").trim());
    return Boolean(row);
  }

  createCollection(username, name) {
    const u = String(username || "").trim();
    const n = String(name || "").trim() || "未命名知识库";
    if (!u) throw new Error("username required");
    const id = newId();
    const now = Date.now();
    const model = (process.env.EMBEDDING_MODEL || "doubao-embedding-text-240515").trim();
    this.insertCollection.run(id, u, n, model, now);
    return { id, name: n, embeddingModel: model, createdAt: now };
  }

  list(username) {
    const u = String(username || "").trim();
    if (!u) return [];
    return this.listCollectionsWithCounts.all(u).map((r) => ({
      id: r.id,
      name: r.name,
      embeddingModel: r.embedding_model,
      createdAt: r.created_at,
      chunkCount: Number(r.chunk_count) || 0
    }));
  }

  /** @returns {null | { id: string, name: string, embeddingModel: string, createdAt: number, chunkCount: number }} */
  getCollection(username, collectionId) {
    const id = String(collectionId || "").trim();
    const u = String(username || "").trim();
    const row = this.selectCollection.get(id, u);
    if (!row) return null;
    const chunkCount = Number(this.countChunks.get(id)?.c ?? 0) || 0;
    return {
      id: row.id,
      name: row.name,
      embeddingModel: row.embedding_model,
      createdAt: row.created_at,
      chunkCount
    };
  }

  /**
   * @returns {null | Array<{ rowId: number, chunkIndex: number, content: string, embedding: number[] }>}
   */
  listChunks(username, collectionId) {
    const id = String(collectionId || "").trim();
    const u = String(username || "").trim();
    if (!this.owns(u, id)) return null;
    return this.selectChunks.all(id).map((r) => {
      let embedding = [];
      try {
        const parsed = JSON.parse(r.embedding_json || "[]");
        embedding = Array.isArray(parsed) ? parsed.map((x) => Number(x)) : [];
      } catch {
        embedding = [];
      }
      return {
        rowId: r.id,
        chunkIndex: r.chunk_index,
        content: r.content,
        embedding
      };
    });
  }

  /**
   * 分页列出分块（不含 embedding，仅 embeddingDim），支持按正文小写或序号子串筛选。
   * @returns {null | { chunks: Array<{ rowId: number, chunkIndex: number, content: string, embeddingDim: number }>, total: number, page: number, pageSize: number }}
   */
  listChunksPage(username, collectionId, { page = 1, pageSize = 20, q = "" } = {}) {
    const cid = String(collectionId || "").trim();
    const u = String(username || "").trim();
    if (!this.owns(u, cid)) return null;
    const ps = Math.min(100, Math.max(1, Number(pageSize) || 20));
    const pg = Math.max(1, Number(page) || 1);
    const offset = (pg - 1) * ps;
    const term = String(q || "").trim().toLowerCase();

    let rows;
    let total;
    if (term) {
      rows = this.listChunksPagedSearch.all(cid, term, term, ps, offset);
      total = Number(this.countChunksSearch.get(cid, term, term)?.c ?? 0);
    } else {
      rows = this.listChunksPaged.all(cid, ps, offset);
      total = Number(this.countChunks.get(cid)?.c ?? 0);
    }

    return {
      chunks: rows.map((r) => ({
        rowId: r.id,
        chunkIndex: r.chunk_index,
        content: r.content,
        embeddingDim: Number(r.embedding_dim) || 0
      })),
      total,
      page: pg,
      pageSize: ps
    };
  }

  /**
   * 单条分块（含完整 embedding），用于懒加载展示。
   * @returns {null | { rowId: number, chunkIndex: number, content: string, embedding: number[] }}
   */
  getChunkByRowId(username, collectionId, rowId) {
    const cid = String(collectionId || "").trim();
    const u = String(username || "").trim();
    const rid = Number(rowId);
    if (!this.owns(u, cid) || !Number.isFinite(rid)) return null;
    const row = this.selectChunkByPk.get(rid, cid);
    if (!row) return null;
    let embedding = [];
    try {
      const parsed = JSON.parse(row.embedding_json || "[]");
      embedding = Array.isArray(parsed) ? parsed.map((x) => Number(x)) : [];
    } catch {
      embedding = [];
    }
    return {
      rowId: row.id,
      chunkIndex: row.chunk_index,
      content: row.content,
      embedding
    };
  }

  delete(username, collectionId) {
    const id = String(collectionId || "").trim();
    const u = String(username || "").trim();
    return this.deleteCollection.run(id, u).changes > 0;
  }

  updateCollection(username, collectionId, name) {
    const id = String(collectionId || "").trim();
    const u = String(username || "").trim();
    const n = String(name || "").trim();
    if (!this.owns(u, id) || !n) return false;
    return this.updateCollectionName.run(n, id, u).changes > 0;
  }

  /**
   * @returns {{ ok: true, chunk: { rowId: number, chunkIndex: number, content: string, embedding: number[] } } | { ok: false, error: string }}
   */
  appendChunk(username, collectionId, content, embedding) {
    const id = String(collectionId || "").trim();
    const u = String(username || "").trim();
    if (!this.owns(u, id)) return { ok: false, error: "not_found" };
    const text = String(content || "").trim();
    if (!text) return { ok: false, error: "empty_content" };
    if (!Array.isArray(embedding) || !embedding.length) return { ok: false, error: "invalid_embedding" };
    const m = this.maxChunkIndex.get(id)?.m;
    const next = (m == null || Number.isNaN(Number(m)) ? -1 : Number(m)) + 1;
    const info = this.insertChunk.run(id, next, text, JSON.stringify(embedding.map((x) => Number(x))));
    const rowId = Number(info.lastInsertRowid);
    return { ok: true, chunk: { rowId, chunkIndex: next, content: text, embedding: embedding.map((x) => Number(x)) } };
  }

  /**
   * @returns {{ ok: true, chunk: { rowId: number, chunkIndex: number, content: string, embedding: number[] } } | { ok: false, error: string }}
   */
  updateChunk(username, collectionId, rowId, content, embedding) {
    const cid = String(collectionId || "").trim();
    const u = String(username || "").trim();
    const rid = Number(rowId);
    if (!this.owns(u, cid) || !Number.isFinite(rid)) return { ok: false, error: "not_found" };
    const row = this.selectChunkByPk.get(rid, cid);
    if (!row) return { ok: false, error: "not_found" };
    const text = String(content || "").trim();
    if (!text) return { ok: false, error: "empty_content" };
    if (!Array.isArray(embedding) || !embedding.length) return { ok: false, error: "invalid_embedding" };
    const embJson = JSON.stringify(embedding.map((x) => Number(x)));
    this.updateChunkRow.run(text, embJson, rid, cid);
    return {
      ok: true,
      chunk: {
        rowId: rid,
        chunkIndex: row.chunk_index,
        content: text,
        embedding: embedding.map((x) => Number(x))
      }
    };
  }

  deleteChunk(username, collectionId, rowId) {
    const cid = String(collectionId || "").trim();
    const u = String(username || "").trim();
    const rid = Number(rowId);
    if (!this.owns(u, cid) || !Number.isFinite(rid)) return false;
    const row = this.selectChunkByPk.get(rid, cid);
    if (!row) return false;
    return this.deleteChunkRow.run(rid, cid).changes > 0;
  }

  /**
   * 按主键批量删除分块（仅删除属于该库且存在的行）。
   * @param {number[]} rowIds
   * @returns {{ ok: true, deleted: number } | { ok: false, error: string }}
   */
  deleteChunksByRowIds(username, collectionId, rowIds) {
    const cid = String(collectionId || "").trim();
    const u = String(username || "").trim();
    if (!this.owns(u, cid)) return { ok: false, error: "not_found" };
    const uniq = [...new Set(rowIds.map(Number).filter(Number.isFinite))];
    if (!uniq.length) return { ok: false, error: "empty_row_ids" };
    const tx = this.db.transaction((ids) => {
      let n = 0;
      for (const rid of ids) {
        const row = this.selectChunkByPk.get(rid, cid);
        if (row) {
          this.deleteChunkRow.run(rid, cid);
          n += 1;
        }
      }
      return n;
    });
    const deleted = tx(uniq);
    return { ok: true, deleted };
  }

  /**
   * 覆盖写入：清空该库下所有 chunk，再写入新分块与向量。
   */
  ingestChunks(username, collectionId, { chunks, embeddings }) {
    const id = String(collectionId || "").trim();
    const u = String(username || "").trim();
    if (!this.owns(u, id)) return { ok: false, error: "not_found" };
    if (!Array.isArray(chunks) || !Array.isArray(embeddings) || chunks.length !== embeddings.length) {
      return { ok: false, error: "invalid_payload" };
    }

    const pairs = chunks
      .map((c, i) => ({ content: String(c || "").trim(), emb: embeddings[i] }))
      .filter((p) => p.content && Array.isArray(p.emb) && p.emb.length);

    const tx = this.db.transaction(() => {
      this.deleteChunks.run(id);
      pairs.forEach((p, idx) => {
        this.insertChunk.run(id, idx, p.content, JSON.stringify(p.emb));
      });
    });
    tx();
    const c = this.countChunks.get(id)?.c ?? 0;
    return { ok: true, chunkCount: c };
  }

  query(username, collectionId, queryVector, topK = 5) {
    const id = String(collectionId || "").trim();
    const u = String(username || "").trim();
    if (!this.owns(u, id)) return null;
    if (!Array.isArray(queryVector) || !queryVector.length) return null;

    const k = Math.max(1, Math.min(20, Number(topK) || 5));
    const rows = this.selectChunks.all(id);
    const scored = [];
    for (const r of rows) {
      let vec;
      try {
        vec = JSON.parse(r.embedding_json || "[]");
      } catch {
        continue;
      }
      if (!Array.isArray(vec)) continue;
      const score = cosineSimilarity(queryVector, vec);
      if (score >= 0) {
        scored.push({ rowId: r.id, chunkIndex: r.chunk_index, content: r.content, score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }
}
