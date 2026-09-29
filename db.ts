import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type DB = DatabaseSync;
export type Row = Record<string, unknown>;

const SCHEMA_VERSION = 1;

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  const here = dirname(fileURLToPath(import.meta.url));
  db.exec(readFileSync(join(here, "schema.sql"), "utf8"));
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null };
  if ((row.v ?? 0) < SCHEMA_VERSION) {
    db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(SCHEMA_VERSION, new Date().toISOString());
  }
}

/** Transaction : tout ou rien. Imbrication gérée par SAVEPOINT. */
let depth = 0;
export function tx<T>(db: DB, fn: () => T): T {
  const sp = `sp${depth}`;
  db.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${sp}`);
  depth++;
  try {
    const result = fn();
    depth--;
    db.exec(depth === 0 ? "COMMIT" : `RELEASE ${sp}`);
    return result;
  } catch (e) {
    depth--;
    db.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw e;
  }
}

export function one<T = Row>(db: DB, sql: string, ...params: (string | number | null)[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function all<T = Row>(db: DB, sql: string, ...params: (string | number | null)[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function run(db: DB, sql: string, ...params: (string | number | null)[]): void {
  db.prepare(sql).run(...params);
}

export function nextCounter(db: DB, name: string): number {
  run(db, "INSERT INTO counters (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1", name);
  return (one<{ value: number }>(db, "SELECT value FROM counters WHERE name = ?", name))!.value;
}
