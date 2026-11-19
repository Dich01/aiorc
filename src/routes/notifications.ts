import { Router, Response } from 'express';
import db from '../db/client';
import { requireAuth, AuthRequest } from '../middleware/auth';

// The signed-in user's notifications.
//   GET  /notifications               newest first (?limit, default 50) + unread count
//   GET  /notifications/unread-count  for the red dot in the menu
//   POST /notifications/:id/read      mark one as read
//   POST /notifications/read-all      mark all as read
const router = Router();

const unread = (userId: string) =>
  (db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId) as { n: number }).n;

router.get('/', requireAuth, (req: AuthRequest, res: Response): void => {
  const limit = Math.min(200, Math.max(1, Number(req.query['limit']) || 50));
  const items = db.prepare(
    `SELECT id, kind, title, body, link, project_id, entity_kind, entity_id, created_at, read_at
     FROM notifications WHERE user_id = ? ORDER BY (read_at IS NULL) DESC, created_at DESC LIMIT ?`
  ).all(req.userId!, limit);
  res.json({ unread: unread(req.userId!), items });
});

router.get('/unread-count', requireAuth, (req: AuthRequest, res: Response): void => {
  res.json({ unread: unread(req.userId!) });
});

router.post('/read-all', requireAuth, (req: AuthRequest, res: Response): void => {
  db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(Date.now(), req.userId!);
  res.json({ unread: 0 });
});

router.post('/:id/read', requireAuth, (req: AuthRequest, res: Response): void => {
  const r = db.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?').run(Date.now(), req.params['id'], req.userId!);
  if (r.changes === 0) { res.status(404).json({ error: 'Notification not found' }); return; }
  res.json({ unread: unread(req.userId!) });
});

export default router;
