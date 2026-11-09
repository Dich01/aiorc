import { createHash, randomBytes } from 'crypto';

// Bearer secrets (project keys, personal tokens) are stored only as SHA-256
// hashes. The plaintext is shown once, when it is created or regenerated.
// They are long random strings, so a fast hash is the right tool here (unlike
// passwords, which go through bcrypt).

export const PROJECT_KEY_PREFIX = 'aiorc_pk_';
export const USER_TOKEN_PREFIX = 'aiorc_pat_';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function newSecret(prefix: string): { plaintext: string; hash: string; display: string } {
  const plaintext = prefix + randomBytes(24).toString('base64url');
  return { plaintext, hash: sha256Hex(plaintext), display: plaintext.slice(0, prefix.length + 4) };
}
