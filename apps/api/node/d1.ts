import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

/* The subset of Cloudflare's D1Database that src/ uses (prepare, bind, first, all, run, batch), over node:sqlite. */

type Row = Record<string, unknown>;

export interface D1Result<T = Row> {
  results: T[];
  success: true;
  meta: { changes: number; last_row_id: number; duration: number };
}

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Row>(column?: string): Promise<T | null>;
  all<T = Row>(): Promise<D1Result<T>>;
  run<T = Row>(): Promise<D1Result<T>>;
  /** Not in D1: synchronous execution, so that a batch runs in one transaction. */
  execute(): D1Result;
}

export interface D1 {
  prepare(sql: string): D1Statement;
  batch<T = Row>(statements: D1Statement[]): Promise<D1Result<T>[]>;
}

/**
 * Opens a SQLite file, creating its directory. Foreign keys are on (node:sqlite default), as in D1. WAL and the
 * busy timeout let `pnpm user:create --db` write while the server runs.
 */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 5_000 });
  db.exec('PRAGMA journal_mode = WAL');
  return db;
}

/** D1 binds booleans as 0/1; node:sqlite rejects them. Other unsupported values (undefined…) throw, as in D1. */
const toSql = (value: unknown) => (typeof value === 'boolean' ? Number(value) : value) as SQLInputValue;

export function createD1(db: DatabaseSync): D1 {
  const counters = db.prepare('SELECT total_changes() AS total, last_insert_rowid() AS rowid');
  const readCounters = () => counters.get() as { total: number; rowid: number };

  // node:sqlite is synchronous: a statement, or a whole batch, runs without interleaving with other requests.
  const execute = (sql: string, params: SQLInputValue[]): D1Result => {
    const before = readCounters();
    const results = db.prepare(sql).all(...params);
    const after = readCounters();
    // total_changes() delta: rows written by this statement only (0 for a SELECT, unlike sqlite3_changes()).
    return {
      results,
      success: true,
      meta: { changes: after.total - before.total, last_row_id: after.rowid, duration: 0 },
    };
  };

  const statement = (sql: string, params: SQLInputValue[]): D1Statement => ({
    bind: (...values) => statement(sql, values.map(toSql)),
    first: async <T>(column?: string) => {
      const row = execute(sql, params).results[0];
      if (row === undefined) return null;
      return (column === undefined ? row : (row[column] ?? null)) as T | null;
    },
    all: async <T>() => execute(sql, params) as D1Result<T>,
    run: async <T>() => execute(sql, params) as D1Result<T>,
    execute: () => execute(sql, params),
  });

  return {
    prepare: (sql) => statement(sql, []),
    // D1 batches are atomic: all statements commit, or none does.
    batch: async <T>(statements: D1Statement[]) => {
      db.exec('BEGIN');
      try {
        const results = statements.map((s) => s.execute());
        db.exec('COMMIT');
        return results as D1Result<T>[];
      } catch (err) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}
