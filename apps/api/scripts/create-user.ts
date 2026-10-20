/**
 * Creates a user and a one-time pairing code (valid 15 min).
 * Usage: pnpm user:create <name> [--admin] [--remote] [--db <path>]
 *   local D1 (wrangler) by default; --remote: Cloudflare D1; --db: the SQLite file of the Node server
 *   (apps/api/node/server.ts), migrated first if needed. A relative --db path is relative to apps/api.
 * Plain Node (type stripping), no dependency.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { openDatabase } from '../node/d1.ts';
import { applyMigrations } from '../node/migrate.ts';

// Crockford base32: no I, L, O, U, easy to read and type.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 10;
const CODE_TTL_MS = 15 * 60_000;

const { values: opts, positionals } = parseArgs({
  options: { admin: { type: 'boolean' }, remote: { type: 'boolean' }, db: { type: 'string' } },
  allowPositionals: true,
});
const name = positionals[0]?.trim();
if (!name) {
  console.error('Usage : pnpm user:create <nom> [--admin] [--remote] [--db <fichier.sqlite>]');
  process.exit(1);
}

const now = Date.now();
const userId = randomUUID();
const code = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
const codeHash = createHash('sha256').update(code).digest('hex');
const expiresAt = now + CODE_TTL_MS;
const isAdmin = opts.admin ? 1 : 0;

if (opts.db) {
  const db = openDatabase(opts.db);
  applyMigrations(db);
  db.exec('BEGIN');
  db.prepare('INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, ?, ?)').run(userId, name, isAdmin, now);
  db.prepare('INSERT INTO pairing_codes (code_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    codeHash,
    userId,
    expiresAt,
  );
  db.exec('COMMIT');
  db.close();
} else {
  const sqlName = name.replaceAll("'", "''");
  const sql = [
    `INSERT INTO users (id, name, is_admin, created_at) VALUES ('${userId}', '${sqlName}', ${isAdmin}, ${now});`,
    `INSERT INTO pairing_codes (code_hash, user_id, expires_at) VALUES ('${codeHash}', '${userId}', ${expiresAt});`,
  ].join('\n');

  // No shell: arguments are passed as is.
  execFileSync('wrangler', ['d1', 'execute', 'karto', opts.remote ? '--remote' : '--local', '--command', sql], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

console.log(`Utilisateur « ${name} » créé (${userId}).`);
console.log(`Code d'appairage : ${code} (valable jusqu'à ${new Date(expiresAt).toLocaleTimeString('fr-FR')})`);
