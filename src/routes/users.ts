import { Router, Request, Response } from 'express';
import db from '../db/client';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { User } from '../db/schema';
import { NICKNAME_REGEX, BIO_MAX_LENGTH } from './auth';

const router = Router();

const ALLOWED_AVATARS = new Set([
  'avatar01.png', 'avatar02.png', 'avatar03.png',
  'avatar04.png', 'avatar05.png', 'Avatar06.png', 'Avatar07.png',
]);

function publicUser(u: User) {
  return {
    id: u.id, email: u.email, name: u.name,
    nickname: u.nickname, bio: u.bio, avatar: u.avatar,
    role: u.role, created_at: u.created_at, last_login: u.last_login ?? null,
  };
}

function userStats(userId: string) {
  const n = (sql: string, ...params: unknown[]) =>
    (db.prepare(sql).get(...(params as [unknown])) as { c: number }).c;

  return {
    projects:       n('SELECT COUNT(*) as c FROM projects WHERE user_id=?', userId),
    agents:         n('SELECT COUNT(*) as c FROM agents WHERE user_id=?', userId),
    skills:         n('SELECT COUNT(*) as c FROM skills WHERE user_id=?', userId),
    forks_made:     n(`SELECT
      (SELECT COUNT(*) FROM projects WHERE user_id=? AND forked_from IS NOT NULL)+
      (SELECT COUNT(*) FROM agents   WHERE user_id=? AND forked_from IS NOT NULL)+
      (SELECT COUNT(*) FROM skills   WHERE user_id=? AND forked_from IS NOT NULL) as c`,
      userId, userId, userId),
    issues_created: n('SELECT COUNT(*) as c FROM issues WHERE user_id=?', userId),
    issue_comments: n('SELECT COUNT(*) as c FROM issue_comments WHERE user_id=?', userId),
    stars_received: n(`SELECT
      (SELECT COUNT(*) FROM project_stars WHERE project_id IN (SELECT id FROM projects WHERE user_id=?))+
      (SELECT COUNT(*) FROM agent_stars   WHERE agent_id   IN (SELECT id FROM agents   WHERE user_id=?))+
      (SELECT COUNT(*) FROM skill_stars   WHERE skill_id   IN (SELECT id FROM skills   WHERE user_id=?)) as c`,
      userId, userId, userId),
    forks_received: n(`SELECT
      (SELECT COUNT(*) FROM projects WHERE forked_from IN (SELECT id FROM projects WHERE user_id=?))+
      (SELECT COUNT(*) FROM agents   WHERE forked_from IN (SELECT id FROM agents   WHERE user_id=?))+
      (SELECT COUNT(*) FROM skills   WHERE forked_from IN (SELECT id FROM skills   WHERE user_id=?)) as c`,
      userId, userId, userId),
  };
}

// GET /users/me
router.get('/me', requireAuth, (req: AuthRequest, res: Response): void => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId!) as User | undefined;
  if (!u) { res.status(404).json({ error: 'User not found' }); return; }
  res.json(publicUser(u));
});

// PATCH /users/me
router.patch('/me', requireAuth, (req: AuthRequest, res: Response): void => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId!) as User | undefined;
  if (!u) { res.status(404).json({ error: 'User not found' }); return; }

  const { nickname, bio, name, avatar } = req.body as {
    nickname?: string; bio?: string; name?: string; avatar?: string;
  };

  if (typeof nickname === 'string') {
    const nick = nickname.trim();
    if (!NICKNAME_REGEX.test(nick)) {
      res.status(400).json({ error: 'nickname must be 3–30 chars, only letters, numbers, hyphens, underscores' });
      return;
    }
    if (nick.toLowerCase() !== u.nickname.toLowerCase()) {
      const taken = db.prepare('SELECT id FROM users WHERE LOWER(nickname) = LOWER(?) AND id != ?').get(nick, u.id);
      if (taken) { res.status(409).json({ error: 'Nickname already taken' }); return; }
    }
    db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(nick, u.id);
  }
  if (typeof bio === 'string') {
    if (bio.length > BIO_MAX_LENGTH) { res.status(400).json({ error: `bio must be at most ${BIO_MAX_LENGTH} characters` }); return; }
    db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(bio.trim().slice(0, BIO_MAX_LENGTH), u.id);
  }
  if (typeof name === 'string' && name.trim()) {
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name.trim().slice(0, 80), u.id);
  }
  if (typeof avatar === 'string') {
    const av = avatar.trim();
    if (av !== '' && !ALLOWED_AVATARS.has(av)) {
      res.status(400).json({ error: 'Invalid avatar' }); return;
    }
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(av, u.id);
  }

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id) as User;
  res.json(publicUser(updated));
});

// GET /users/by-nickname/:nick
router.get('/by-nickname/:nick', (req: Request, res: Response): void => {
  const u = db.prepare('SELECT * FROM users WHERE LOWER(nickname) = LOWER(?)').get(req.params['nick']) as User | undefined;
  if (!u) { res.status(404).json({ error: 'User not found' }); return; }
  res.json({
    id: u.id, nickname: u.nickname, bio: u.bio, name: u.name,
    avatar: u.avatar, created_at: u.created_at, last_login: u.last_login ?? null,
    stats: userStats(u.id),
  });
});

export default router;
