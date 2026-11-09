// Creates (or promotes) the first admin account. There is no seed: a fresh
// database has no users at all until this runs.
//
//   AIORC_ADMIN_EMAIL=you@example.com AIORC_ADMIN_PASSWORD='...' npm run admin:create
//
// Optional: AIORC_ADMIN_NICKNAME (defaults to the email local part).
import bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import db from '../db/client';
import { validatePassword } from '../lib/passwords';

async function main(): Promise<void> {
  const email = String(process.env.AIORC_ADMIN_EMAIL ?? '').trim().toLowerCase();
  const password = String(process.env.AIORC_ADMIN_PASSWORD ?? '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Set AIORC_ADMIN_EMAIL to a valid email address.');
  }
  const pwError = validatePassword(password);
  if (pwError) throw new Error(`AIORC_ADMIN_PASSWORD: ${pwError}`);

  const nickname = String(process.env.AIORC_ADMIN_NICKNAME ?? email.split('@')[0]).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 30) || 'admin';
  const hash = await bcrypt.hash(password, 10);

  const existing = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(email) as { id: string } | undefined;
  if (existing) {
    db.prepare("UPDATE users SET role = 'admin', password_hash = ? WHERE id = ?").run(hash, existing.id);
    console.log(`[AIOrc] ${email} already existed: promoted to admin and password updated.`);
    return;
  }
  db.prepare(
    "INSERT INTO users (id, email, password_hash, name, nickname, bio, role, created_at) VALUES (?, ?, ?, ?, ?, '', 'admin', ?)"
  ).run(randomUUID(), email, hash, nickname, nickname, Date.now());
  console.log(`[AIOrc] Admin ${email} created.`);
}

main().catch(err => {
  console.error((err as Error).message);
  process.exit(1);
});
