import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { FtlError } from "./errors";

export const MAX_DATA_LEN = 200;
export const MAX_LOG_RECORDS = 10000;

export function openDb(dbPath: string): DatabaseSync {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pages (
      block INTEGER NOT NULL,
      page INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('free','valid','invalid')),
      lpn INTEGER,
      data TEXT,
      PRIMARY KEY (block, page)
    );
    CREATE TABLE IF NOT EXISTS mapping (lpn INTEGER PRIMARY KEY, block INTEGER NOT NULL, page INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS stats (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS block_erases (block INTEGER PRIMARY KEY, count INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ops (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      detail TEXT NOT NULL
    );
  `);
  return db;
}

export function getMeta(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function requireMeta(db: DatabaseSync, key: string): string {
  const v = getMeta(db, key);
  if (v === undefined) throw new FtlError("INVALID_PARAM", `模拟盘尚未创建（缺少元数据 ${key}）`);
  return v;
}
