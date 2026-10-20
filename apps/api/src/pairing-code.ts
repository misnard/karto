/*
 * One-time pairing codes. No import: shared by the Worker and scripts/create-user.ts (plain Node, type stripping).
 * Only the code's SHA-256 is stored.
 */

// Crockford base32: no I, L, O, U, easy to read and type.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 10;
const CODE_TTL_MS = 15 * 60_000;

export function newPairingCode(now = Date.now()): { code: string; expiresAt: number } {
  // 32 symbols divide 256 evenly: `byte % 32` is uniform.
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return { code: Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join(''), expiresAt: now + CODE_TTL_MS };
}
