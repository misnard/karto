/**
 * Creates a user and a one-time pairing code (valid 15 min) in D1.
 * Usage: pnpm user:create <name> [--admin] [--remote]   (local D1 by default)
 * Plain Node (type stripping), no dependency.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { newPairingCode } from '../src/pairing-code.ts';

const args = process.argv.slice(2);
const name = args.find((arg) => !arg.startsWith('--'))?.trim();
if (!name) {
  console.error('Usage : pnpm user:create <nom> [--admin] [--remote]');
  process.exit(1);
}

const now = Date.now();
const userId = randomUUID();
const { code, expiresAt } = newPairingCode(now);
const codeHash = createHash('sha256').update(code).digest('hex');
const sqlName = name.replaceAll("'", "''");

const sql = [
  `INSERT INTO users (id, name, is_admin, created_at) VALUES ('${userId}', '${sqlName}', ${args.includes('--admin') ? 1 : 0}, ${now});`,
  `INSERT INTO pairing_codes (code_hash, user_id, expires_at) VALUES ('${codeHash}', '${userId}', ${expiresAt});`,
].join('\n');

// No shell: arguments are passed as is.
execFileSync(
  'wrangler',
  ['d1', 'execute', 'karto', args.includes('--remote') ? '--remote' : '--local', '--command', sql],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);

console.log(`Utilisateur « ${name} » créé (${userId}).`);
console.log(`Code d'appairage : ${code} (valable jusqu'à ${new Date(expiresAt).toLocaleTimeString('fr-FR')})`);
