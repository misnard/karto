import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createD1, type D1, openDatabase } from './d1.ts';
import { applyMigrations } from './migrate.ts';

describe('createD1', () => {
  let d1: D1;

  beforeEach(() => {
    const db = openDatabase(':memory:');
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL, flag INTEGER, note TEXT)');
    d1 = createD1(db);
  });

  const insert = (id: string, n: number) => d1.prepare('INSERT INTO t (id, n) VALUES (?, ?)').bind(id, n);

  it('first: the first row, one column of it, or null', async () => {
    await insert('a', 1).run();
    await insert('b', 2).run();
    const select = d1.prepare('SELECT id, n, note FROM t WHERE n >= ? ORDER BY n');
    expect(await select.bind(1).first()).toEqual({ id: 'a', n: 1, note: null });
    expect(await select.bind(2).first<string>('id')).toBe('b');
    expect(await select.bind(2).first<string>('note')).toBeNull();
    expect(await select.bind(3).first()).toBeNull();
  });

  it('all: results, numbered parameters and json_each like D1', async () => {
    await insert('a', 1).run();
    await insert('b', 2).run();
    const { results } = await d1
      .prepare('SELECT id FROM t WHERE n >= ?1 AND id IN (SELECT value FROM json_each(?2)) ORDER BY ?1, id')
      .bind(1, JSON.stringify(['a', 'b', 'c']))
      .all<{ id: string }>();
    expect(results).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('meta.changes counts the rows written by this statement only', async () => {
    await insert('a', 1).run();
    await insert('b', 1).run();
    expect((await d1.prepare('UPDATE t SET n = 2 WHERE n = 1').run()).meta.changes).toBe(2);
    // A SELECT right after a write reports 0, not the previous statement's count.
    expect((await d1.prepare('SELECT * FROM t').all()).meta.changes).toBe(0);
    const returning = await d1.prepare('UPDATE t SET n = 3 WHERE id = ? RETURNING id').bind('a').all();
    expect(returning.results).toEqual([{ id: 'a' }]);
    expect(returning.meta.changes).toBe(1);
    expect((await d1.prepare('UPDATE t SET n = 4 WHERE id = ?').bind('zz').run()).meta.changes).toBe(0);
  });

  it('binds booleans as 0/1 and rejects undefined', async () => {
    await d1.prepare('INSERT INTO t (id, n, flag) VALUES (?, ?, ?)').bind('a', 1, true).run();
    expect(await d1.prepare('SELECT flag FROM t').first<number>('flag')).toBe(1);
    await expect(insert('b', undefined as unknown as number).run()).rejects.toThrow();
  });

  it('batch: results in order, in one transaction', async () => {
    const results = await d1.batch([insert('a', 1), insert('b', 2), d1.prepare('SELECT COUNT(*) AS c FROM t')]);
    expect(results.map((r) => r.meta.changes)).toEqual([1, 1, 0]);
    expect(results[2]?.results).toEqual([{ c: 2 }]);
  });

  it('batch: a failing statement rolls back the whole batch', async () => {
    await insert('a', 1).run();
    await expect(d1.batch([insert('b', 2), insert('a', 3)])).rejects.toThrow(/UNIQUE constraint failed/);
    expect((await d1.prepare('SELECT id FROM t').all()).results).toEqual([{ id: 'a' }]);
    // The connection is usable afterwards (no transaction left open).
    expect((await d1.batch([insert('c', 4)]))[0]?.meta.changes).toBe(1);
  });
});

describe('applyMigrations', () => {
  it('applies pending files in order once, tracked in d1_migrations like wrangler', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karto-migrations-'));
    writeFileSync(join(dir, '0002_b.sql'), 'ALTER TABLE a ADD COLUMN y TEXT;');
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (x TEXT);');
    writeFileSync(join(dir, 'README.md'), 'not a migration');
    const db = openDatabase(':memory:');

    expect(applyMigrations(db, dir)).toEqual(['0001_a.sql', '0002_b.sql']);
    expect(applyMigrations(db, dir)).toEqual([]);
    expect(db.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).toEqual([
      { name: '0001_a.sql' },
      { name: '0002_b.sql' },
    ]);

    writeFileSync(join(dir, '0003_bad.sql'), 'CREATE TABLE c (z TEXT); NOT SQL;');
    expect(() => applyMigrations(db, dir)).toThrow('Migration 0003_bad.sql failed');
    // Rolled back: neither the table nor the record exists.
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'c'").all()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM d1_migrations').get()).toEqual({ n: 2 });
  });

  it('applies the real migrations', () => {
    const db = openDatabase(':memory:');
    expect(applyMigrations(db).length).toBeGreaterThan(0);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'jobs'").get()).toEqual({ name: 'jobs' });
  });
});
