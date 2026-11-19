import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import db from '../db/client';
import { User } from '../db/schema';
import { JWT_SECRET } from '../middleware/auth';
import { resolvePendingInvitations } from './invitations';
import { asyncHandler } from '../lib/asyncHandler';
import { validatePassword } from '../lib/passwords';
import { loginBlockedFor, recordLoginFailure, recordLoginSuccess } from '../lib/loginThrottle';

// Self-service registration is closed unless explicitly opened. Accounts are
// otherwise created by an admin (POST /admin/users or npm run admin:create).
export function registrationOpen(): boolean {
  return process.env.AIORC_OPEN_REGISTRATION === '1';
}

const router = Router();

export const NICKNAME_REGEX = /^[a-zA-Z0-9_-]{3,30}$/;
export const BIO_MAX_LENGTH = 500;

function userPayload(u: User) {
  return {
    id: u.id, email: u.email, name: u.name,
    nickname: u.nickname, bio: u.bio, role: u.role, created_at: u.created_at
  };
}

// POST /auth/login
// Hash compared when the email is unknown, so both paths cost the same.
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer-not-a-password', 10);

router.post('/login', asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body as { email?: unknown; password?: unknown };

  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }

  const key = email.trim().toLowerCase();
  const ip = req.ip ?? '';
  const wait = loginBlockedFor(key, ip);
  if (wait > 0) {
    res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
    res.status(429).json({ error: 'Too many failed login attempts. Try again later.' });
    return;
  }

  const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(key) as User | undefined;
  const valid = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !valid) {
    recordLoginFailure(key, ip);
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }
  recordLoginSuccess(key);

  const token = jwt.sign(
    { userId: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: '24h' }
  );

  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), user.id);
  resolvePendingInvitations(user.email, user.id);

  res.json({ token, user: userPayload(user) });
}));

// GET /auth/config — what the login page needs to know before showing forms.
router.get('/config', (_req: Request, res: Response): void => {
  res.json({ registration_open: registrationOpen() });
});

// POST /auth/register
router.post('/register', asyncHandler(async (req: Request, res: Response): Promise<void> => {
  if (!registrationOpen()) {
    res.status(403).json({ error: 'Registration is closed on this server. Ask an administrator for an account.' });
    return;
  }
  const { email, password, name, nickname, bio } = req.body as {
    email?: string; password?: string; name?: string; nickname?: string; bio?: string;
  };

  if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }
  const pwError = validatePassword(password);
  if (pwError) {
    res.status(400).json({ error: pwError });
    return;
  }
  if (!nickname?.trim()) {
    res.status(400).json({ error: 'nickname is required' });
    return;
  }
  const nick = nickname.trim();
  if (!NICKNAME_REGEX.test(nick)) {
    res.status(400).json({ error: 'nickname must be 3–30 chars, only letters, numbers, hyphens, underscores' });
    return;
  }
  if (typeof bio === 'string' && bio.length > BIO_MAX_LENGTH) {
    res.status(400).json({ error: `bio must be at most ${BIO_MAX_LENGTH} characters` });
    return;
  }

  const existingEmail = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existingEmail) {
    res.status(409).json({ error: 'Email already registered' });
    return;
  }
  // Case-insensitive nickname uniqueness
  const existingNick = db.prepare('SELECT id FROM users WHERE LOWER(nickname) = LOWER(?)').get(nick);
  if (existingNick) {
    res.status(409).json({ error: 'Nickname already taken' });
    return;
  }

  const { v4: uuidv4 } = await import('uuid');
  const id = uuidv4();
  const hash = await bcrypt.hash(password, 10);
  const cleanBio = (bio ?? '').trim().slice(0, BIO_MAX_LENGTH);

  db.prepare(
    'INSERT INTO users (id, email, password_hash, name, nickname, bio, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id, email, hash, name?.trim() || email.split('@')[0],
    nick, cleanBio, 'user', Date.now()
  );

  const created = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User;
  // Link invitations addressed to this email but sent before the user registered.
  resolvePendingInvitations(email, id);
  const token = jwt.sign({ userId: id, email }, JWT_SECRET, { expiresIn: '24h' });
  res.status(201).json({ token, user: userPayload(created) });
}));

export default router;
