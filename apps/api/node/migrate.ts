import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Applies the migrations not applied yet, in file name order, each in its own transaction. They are tracked in
 * the same `d1_migrations` table as `wrangler d1 migrations apply`, so one folder serves both runtimes.
 * Returns the names applied.
 */
export function applyMigrations(db: DatabaseSync, dir = MIGRATIONS_DIR): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS d1_migrations(
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`);
  const applied = new Set(
    db
      .prepare('SELECT name FROM d1_migrations')
      .all()
      .map((row) => row.name),
  );
  const todo = readdirSync(dir)
    .filter((name) => name.endsWith('.sql') && !applied.has(name))
    .sort();
  for (const name of todo) {
    db.exec('BEGIN');
    try {
      db.exec(readFileSync(join(dir, name), 'utf8'));
      db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name);
      db.exec('COMMIT');
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw new Error(`Migration ${name} failed`, { cause: err });
    }
  }
  return todo;
}
