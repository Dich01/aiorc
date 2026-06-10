import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/client';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { Issue, IssueComment, IssueType } from '../db/schema';

const router = Router();

const VALID_TYPES: IssueType[] = ['bug', 'feature', 'question'];

function isAdmin(userId: string): boolean {
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: string } | undefined;
  return u?.role === 'admin';
}

const votesCountStmt = db.prepare('SELECT COUNT(*) as n FROM issue_votes WHERE issue_id = ?');
const commentsCountStmt = db.prepare('SELECT COUNT(*) as n FROM issue_comments WHERE issue_id = ?');
const votedByStmt = db.prepare('SELECT 1 FROM issue_votes WHERE issue_id = ? AND user_id = ?');

interface IssueRow extends Issue {
  author_nickname?: string;
  author_email?: string;
  closer_nickname?: string;
}

function enrichIssue(i: IssueRow, viewerId?: string) {
  return {
    ...i,
    votes_count: (votesCountStmt.get(i.id) as { n: number }).n,
    comments_count: (commentsCountStmt.get(i.id) as { n: number }).n,
    is_voted: viewerId ? !!votedByStmt.get(i.id, viewerId) : undefined,
  };
}

// Try to attach the viewerId from JWT if present, but don't require auth.
// Matches what we do with public agent/skill listings.
function softAuth(req: Request): string | undefined {
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) return undefined;
  try {
    // Lazy import to avoid circular dep with auth middleware constants.
    const jwt = require('jsonwebtoken');
    const { JWT_SECRET } = require('../middleware/auth');
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET) as { userId: string };
    return payload.userId;
  } catch { return undefined; }
}

// GET /issues — public listing with filters & sort.
// ?q=…  ?type=bug|feature|question  ?status=open|closed|all (default open)  ?sort=recent|votes|comments
router.get('/', (req: Request, res: Response): void => {
  const query = req.query as { q?: string; type?: string; status?: string; sort?: string };
  const q = String(query.q ?? '').trim();
  const type = String(query.type ?? '').trim();
  const status = String(query.status ?? 'open').trim();
  const sort = String(query.sort ?? 'recent').trim();

  const orderBy = sort === 'votes'
    ? '(SELECT COUNT(*) FROM issue_votes WHERE issue_id = i.id) DESC, i.created_at DESC'
    : sort === 'comments'
      ? '(SELECT COUNT(*) FROM issue_comments WHERE issue_id = i.id) DESC, i.created_at DESC'
      : 'i.created_at DESC';

  const where: string[] = [];
  const params: unknown[] = [];
  if (status === 'open' || status === 'closed') { where.push('i.status = ?'); params.push(status); }
  if (VALID_TYPES.includes(type as IssueType)) { where.push('i.type = ?'); params.push(type); }
  if (q) {
    where.push('(LOWER(i.title) LIKE LOWER(?) OR LOWER(i.body) LIKE LOWER(?))');
    params.push(`%${q}%`, `%${q}%`);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT i.*,
           u.nickname as author_nickname, u.email as author_email,
           c.nickname as closer_nickname
    FROM issues i
    JOIN users u ON u.id = i.user_id
    LEFT JOIN users c ON c.id = i.closed_by_user_id
    ${whereSql}
    ORDER BY ${orderBy}
  `).all(...params) as IssueRow[];

  const viewerId = softAuth(req);
  res.json(rows.map(i => enrichIssue(i, viewerId)));
});

// GET /issues/:id — public.
router.get('/:id', (req: Request, res: Response): void => {
  const issue = db.prepare(`
    SELECT i.*,
           u.nickname as author_nickname, u.email as author_email,
           c.nickname as closer_nickname
    FROM issues i
    JOIN users u ON u.id = i.user_id
    LEFT JOIN users c ON c.id = i.closed_by_user_id
    WHERE i.id = ?
  `).get(req.params['id']) as IssueRow | undefined;
  if (!issue) { res.status(404).json({ error: 'Issue not found' }); return; }

  const viewerId = softAuth(req);
  res.json(enrichIssue(issue, viewerId));
});

// POST /issues — auth required, anyone can report.
router.post('/', requireAuth, (req: AuthRequest, res: Response): void => {
  const { title, body, type } = req.body as { title?: string; body?: string; type?: string };
  if (!title?.trim()) { res.status(400).json({ error: 'title is required' }); return; }
  const finalType: IssueType = VALID_TYPES.includes(type as IssueType) ? type as IssueType : 'bug';

  const id = uuidv4();
  const now = Date.now();
  db.prepare(
    'INSERT INTO issues (id, user_id, title, body, type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, req.userId!, title.trim().slice(0, 200), (body ?? '').trim(), finalType, 'open', now, now);

  const row = db.prepare(`
    SELECT i.*, u.nickname as author_nickname, u.email as author_email
    FROM issues i JOIN users u ON u.id = i.user_id WHERE i.id = ?
  `).get(id) as IssueRow;
  res.status(201).json(enrichIssue(row, req.userId!));
});

// PATCH /issues/:id — author or admin can edit title/body/type.
router.patch('/:id', requireAuth, (req: AuthRequest, res: Response): void => {
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(req.params['id']) as Issue | undefined;
  if (!issue) { res.status(404).json({ error: 'Issue not found' }); return; }
  if (issue.user_id !== req.userId && !isAdmin(req.userId!)) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }

  const { title, body, type } = req.body as { title?: string; body?: string; type?: string };
  const newTitle = typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : issue.title;
  const newBody = typeof body === 'string' ? body.trim() : issue.body;
  const newType = VALID_TYPES.includes(type as IssueType) ? type as IssueType : issue.type;

  db.prepare('UPDATE issues SET title = ?, body = ?, type = ?, updated_at = ? WHERE id = ?').run(
    newTitle, newBody, newType, Date.now(), issue.id
  );
  const updated = db.prepare(`
    SELECT i.*, u.nickname as author_nickname, u.email as author_email,
           c.nickname as closer_nickname
    FROM issues i JOIN users u ON u.id = i.user_id LEFT JOIN users c ON c.id = i.closed_by_user_id
    WHERE i.id = ?
  `).get(issue.id) as IssueRow;
  res.json(enrichIssue(updated, req.userId!));
});

// POST /issues/:id/close — admin only.
router.post('/:id/close', requireAuth, (req: AuthRequest, res: Response): void => {
  if (!isAdmin(req.userId!)) { res.status(403).json({ error: 'Only admins can close issues' }); return; }
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(req.params['id']) as Issue | undefined;
  if (!issue) { res.status(404).json({ error: 'Issue not found' }); return; }
  if (issue.status === 'closed') { res.status(400).json({ error: 'Already closed' }); return; }

  db.prepare('UPDATE issues SET status = ?, closed_by_user_id = ?, closed_at = ?, updated_at = ? WHERE id = ?').run(
    'closed', req.userId!, Date.now(), Date.now(), issue.id
  );
  const updated = db.prepare(`
    SELECT i.*, u.nickname as author_nickname, u.email as author_email, c.nickname as closer_nickname
    FROM issues i JOIN users u ON u.id = i.user_id LEFT JOIN users c ON c.id = i.closed_by_user_id
    WHERE i.id = ?
  `).get(issue.id) as IssueRow;
  res.json(enrichIssue(updated, req.userId!));
});

// POST /issues/:id/reopen — admin only.
router.post('/:id/reopen', requireAuth, (req: AuthRequest, res: Response): void => {
  if (!isAdmin(req.userId!)) { res.status(403).json({ error: 'Only admins can reopen issues' }); return; }
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(req.params['id']) as Issue | undefined;
  if (!issue) { res.status(404).json({ error: 'Issue not found' }); return; }
  if (issue.status === 'open') { res.status(400).json({ error: 'Already open' }); return; }

  db.prepare('UPDATE issues SET status = ?, closed_by_user_id = NULL, closed_at = NULL, updated_at = ? WHERE id = ?').run(
    'open', Date.now(), issue.id
  );
  const updated = db.prepare(`
    SELECT i.*, u.nickname as author_nickname, u.email as author_email, c.nickname as closer_nickname
    FROM issues i JOIN users u ON u.id = i.user_id LEFT JOIN users c ON c.id = i.closed_by_user_id
    WHERE i.id = ?
  `).get(issue.id) as IssueRow;
  res.json(enrichIssue(updated, req.userId!));
});

// DELETE /issues/:id — author or admin.
router.delete('/:id', requireAuth, (req: AuthRequest, res: Response): void => {
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(req.params['id']) as Issue | undefined;
  if (!issue) { res.status(404).json({ error: 'Issue not found' }); return; }
  if (issue.user_id !== req.userId && !isAdmin(req.userId!)) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }
  // Cascade: explicit cleanup since SQLite doesn't always cascade with the schema we shipped.
  db.prepare('DELETE FROM issue_comments WHERE issue_id = ?').run(issue.id);
  db.prepare('DELETE FROM issue_votes WHERE issue_id = ?').run(issue.id);
  db.prepare('DELETE FROM issues WHERE id = ?').run(issue.id);
  res.status(204).end();
});

// POST /issues/:id/vote — toggle 👍.
router.post('/:id/vote', requireAuth, (req: AuthRequest, res: Response): void => {
  const issue = db.prepare('SELECT id FROM issues WHERE id = ?').get(req.params['id']) as { id: string } | undefined;
  if (!issue) { res.status(404).json({ error: 'Issue not found' }); return; }

  const existing = db.prepare('SELECT 1 FROM issue_votes WHERE issue_id = ? AND user_id = ?').get(issue.id, req.userId!);
  if (existing) {
    db.prepare('DELETE FROM issue_votes WHERE issue_id = ? AND user_id = ?').run(issue.id, req.userId!);
    const count = (votesCountStmt.get(issue.id) as { n: number }).n;
    res.json({ is_voted: false, votes_count: count });
    return;
  }
  db.prepare('INSERT INTO issue_votes (user_id, issue_id, created_at) VALUES (?, ?, ?)').run(req.userId!, issue.id, Date.now());
  const count = (votesCountStmt.get(issue.id) as { n: number }).n;
  res.json({ is_voted: true, votes_count: count });
});

// GET /issues/:id/comments — public.
router.get('/:id/comments', (req: Request, res: Response): void => {
  const rows = db.prepare(`
    SELECT c.*, u.nickname as author_nickname, u.email as author_email, u.role as author_role
    FROM issue_comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.issue_id = ?
    ORDER BY c.created_at ASC
  `).all(req.params['id']);
  res.json(rows);
});

// POST /issues/:id/comments — auth, any logged-in user.
router.post('/:id/comments', requireAuth, (req: AuthRequest, res: Response): void => {
  const issue = db.prepare('SELECT id FROM issues WHERE id = ?').get(req.params['id']) as { id: string } | undefined;
  if (!issue) { res.status(404).json({ error: 'Issue not found' }); return; }
  const { body } = req.body as { body?: string };
  if (!body?.trim()) { res.status(400).json({ error: 'body is required' }); return; }

  const id = uuidv4();
  db.prepare('INSERT INTO issue_comments (id, issue_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id, issue.id, req.userId!, body.trim(), Date.now()
  );
  // Bump the issue's updated_at so sort=recent surfaces active threads.
  db.prepare('UPDATE issues SET updated_at = ? WHERE id = ?').run(Date.now(), issue.id);

  const created = db.prepare(`
    SELECT c.*, u.nickname as author_nickname, u.email as author_email, u.role as author_role
    FROM issue_comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?
  `).get(id) as IssueComment;
  res.status(201).json(created);
});

// DELETE /issues/:id/comments/:cid — comment author or admin.
router.delete('/:id/comments/:cid', requireAuth, (req: AuthRequest, res: Response): void => {
  const comment = db.prepare('SELECT * FROM issue_comments WHERE id = ?').get(req.params['cid']) as IssueComment | undefined;
  if (!comment) { res.status(404).json({ error: 'Comment not found' }); return; }
  if (comment.user_id !== req.userId && !isAdmin(req.userId!)) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }
  db.prepare('DELETE FROM issue_comments WHERE id = ?').run(comment.id);
  res.status(204).end();
});

export default router;
