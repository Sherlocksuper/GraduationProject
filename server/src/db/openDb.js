import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      rag_collection_ids_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions (username, updated_at DESC);

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      ts INTEGER NOT NULL,
      meta_json TEXT,
      FOREIGN KEY (session_id) REFERENCES chat_sessions (id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages (session_id, id);

    CREATE TABLE IF NOT EXISTS research_tasks (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      topic TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      artifacts_json TEXT NOT NULL DEFAULT '{}',
      trace_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_research_user ON research_tasks (username, updated_at DESC);

    CREATE TABLE IF NOT EXISTS rag_collections (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      name TEXT NOT NULL,
      embedding_model TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rag_collections_user ON rag_collections (username, created_at DESC);

    CREATE TABLE IF NOT EXISTS rag_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding_json TEXT NOT NULL,
      FOREIGN KEY (collection_id) REFERENCES rag_collections (id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_rag_chunks_collection ON rag_chunks (collection_id, chunk_index);
  `);

  const msgCols = db.prepare(`PRAGMA table_info(chat_messages)`).all();
  const hasMsgMeta = msgCols.some((c) => c.name === "meta_json");
  if (!hasMsgMeta) {
    db.exec(`ALTER TABLE chat_messages ADD COLUMN meta_json TEXT`);
  }
  const sessCols = db.prepare(`PRAGMA table_info(chat_sessions)`).all();
  const hasRagBind = sessCols.some((c) => c.name === "rag_collection_ids_json");
  if (!hasRagBind) {
    db.exec(
      `ALTER TABLE chat_sessions ADD COLUMN rag_collection_ids_json TEXT NOT NULL DEFAULT '[]'`
    );
  }
}

export function openDb() {
  const dir = process.env.DATA_DIR || path.join(__dirname, "../../data");
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "app.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}
