import { Router, Response, Request } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { normalizeTags } from '../lib/tags';
import { sendInvitationEmail } from '../lib/mailer';
import db from '../db/client';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { Context, ContextInvitation } from '../db/schema';
import { normalizeFiles, writeEntityFiles, loadEntityFiles, CONTEXT_FILES } from '../lib/entityFiles';

const router = Router();

function isAdmin(userId: string): boolean {
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: string } | undefined;
  return u?.role === 'admin';
}

interface ProjectAttachment {
  project_id: string;
  share_on_fork: boolean;
}

function loadProjectAttachmentsForContext(contextId: string): ProjectAttachment[] {
  const rows = db.prepare(
    'SELECT project_id, share_on_fork FROM project_contexts WHERE context_id = ?'
  ).all(contextId) as { project_id: string; share_on_fork: number }[];
  return rows.map(r => ({ project_id: r.project_id, share_on_fork: !!r.share_on_fork }));
}

const contextStarsCount = db.prepare('SELECT COUNT(*) as n FROM context_stars WHERE context_id = ?');
const contextForksCount = db.prepare('SELECT COUNT(*) as n FROM contexts WHERE forked_from = ?');
const contextStarredBy = db.prepare('SELECT 1 FROM context_stars WHERE context_id = ? AND user_id = ?');

function enrichContext(c: Context, viewerId?: string) {
  return {
    ...c,
    files: loadEntityFiles(c.id, CONTEXT_FILES),
    project_attachments: loadProjectAttachmentsForContext(c.id),
    stars_count: (contextStarsCount.get(c.id) as { n: number }).n,
    forks_count: (contextForksCount.get(c.id) as { n: number }).n,
    is_starred: viewerId ? !!contextStarredBy.get(c.id, viewerId) : undefined,
  };
}

function replaceContextProjects(
  contextId: string,
  userId: string,
  attachments: ProjectAttachment[]
): { ok: true } | { ok: false; error: string } {
  const admin = isAdmin(userId);
  const seen = new Set<string>();
  const cleaned: ProjectAttachment[] = [];
  for (const a of attachments) {
    if (!a || typeof a.project_id !== 'string' || !a.project_id.trim() || seen.has(a.project_id)) continue;
    seen.add(a.project_id);
    cleaned.push({ project_id: a.project_id, share_on_fork: !!a.share_on_fork });
  }

  if (cleaned.length > 0) {
    const ids = cleaned.map(a => a.project_id);
    const placeholders = ids.map(() => '?').join(',');
    const found = db.prepare(`SELECT id, user_id FROM projects WHERE id IN (${placeholders})`).all(...ids) as { id: string; user_id: string }[];
    if (found.length !== ids.length) {
      const foundIds = new Set(found.map(r => r.id));
      const missing = ids.filter(id => !foundIds.has(id));
      return { ok: false, error: `Unknown project ids: ${missing.join(', ')}` };
    }
    if (!admin) {
      const foreign = found.find(r => r.user_id !== userId);
      if (foreign) return { ok: false, error: `Project ${foreign.id} does not belong to this user` };
    }
  }

  const tx = db.transaction((items: ProjectAttachment[]) => {
    db.prepare('DELETE FROM project_contexts WHERE context_id = ?').run(contextId);
    const ins = db.prepare('INSERT INTO project_contexts (project_id, context_id, share_on_fork) VALUES (?, ?, ?)');
    items.forEach(a => ins.run(a.project_id, contextId, a.share_on_fork ? 1 : 0));
  });
  tx(cleaned);

  return { ok: true };
}

// GET /contexts/public — public contexts with optional filters & sort.
router.get('/public', (req: Request, res: Response): void => {
  const query = req.query as { q?: string; owner?: string; sort?: string };
  const q = String(query.q ?? '').trim();
  const owner = String(query.owner ?? '').trim();
  const sort = String(query.sort ?? 'recent');

  const orderBy = sort === 'stars'
    ? '(SELECT COUNT(*) FROM context_stars WHERE context_id = c.id) DESC, c.created_at DESC'
    : sort === 'forks'
      ? '(SELECT COUNT(*) FROM contexts f WHERE f.forked_from = c.id) DESC, c.created_at DESC'
      : sort === 'usage'
        ? 'usage_runs DESC, c.created_at DESC'
        : 'c.created_at DESC';

  const where: string[] = ['c.is_public = 1'];
  const params: unknown[] = [];
  if (q) { where.push('(LOWER(c.name) LIKE LOWER(?) OR LOWER(c.description) LIKE LOWER(?) OR LOWER(c.tags) LIKE LOWER(?))'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (owner) { where.push('LOWER(u.nickname) = LOWER(?)'); params.push(owner); }

  // A context is emitted into every compiled workflow of the projects that
  // include it, so usage = runs of those projects.
  const rows = db.prepare(`
    SELECT c.*, u.email as owner_email, u.nickname as owner_nickname,
           (SELECT COUNT(*) FROM runs r
              JOIN project_contexts pc ON pc.project_id = r.project_id
              WHERE pc.context_id = c.id) as usage_runs
    FROM contexts c JOIN users u ON u.id = c.user_id
    WHERE ${where.join(' AND ')}
    ORDER BY ${orderBy}
  `).all(...params) as (Context & { owner_email: string; owner_nickname: string; usage_runs: number })[];

  res.json(rows.map(c => {
    const e = enrichContext(c);
    const { user_id: _u, content: _c, files: _f, ...safe } = e;
    void _u; void _c; void _f;
    // 'content'/'files' stay private until forked — preview only via description.
    return safe;
  }));
});

// GET /contexts — list user's contexts (admin sees all). Optional ?project_id= filter.
router.get('/', requireAuth, (req: AuthRequest, res: Response): void => {
  const admin = isAdmin(req.userId!);
  const projectId = typeof req.query['project_id'] === 'string' ? req.query['project_id'] : '';

  let rows: Context[];
  if (projectId) {
    const ownerClause = admin ? '' : 'AND c.user_id = ?';
    const params: unknown[] = [projectId, projectId];
    if (!admin) params.push(req.userId!, req.userId!);
    rows = db.prepare(
      `SELECT c.* FROM contexts c
       WHERE EXISTS (SELECT 1 FROM project_contexts WHERE context_id = c.id AND project_id = ?)
       AND EXISTS (SELECT 1 FROM projects p WHERE p.id = ? ${admin ? '' : 'AND p.user_id = ?'})
       ${ownerClause}
       ORDER BY c.name ASC`
    ).all(...params) as Context[];
  } else {
    rows = admin
      ? db.prepare('SELECT * FROM contexts ORDER BY name ASC').all() as Context[]
      : db.prepare('SELECT * FROM contexts WHERE user_id = ? ORDER BY name ASC').all(req.userId!) as Context[];
  }

  res.json(rows.map(c => enrichContext(c, req.userId!)));
});

// GET /contexts/:id — context detail with content. Owner/admin always; others only if public or invited.
router.get('/:id', requireAuth, (req: AuthRequest, res: Response): void => {
  const ctx = db.prepare('SELECT * FROM contexts WHERE id = ?').get(req.params['id']) as Context | undefined;
  if (!ctx) { res.status(404).json({ error: 'Context not found' }); return; }

  const admin = isAdmin(req.userId!);
  const isOwn = ctx.user_id === req.userId;
  if (!admin && !isOwn) {
    if (!ctx.is_public) {
      const me = db.prepare('SELECT email FROM users WHERE id = ?').get(req.userId!) as { email: string } | undefined;
      const invited = me ? db.prepare(
        'SELECT 1 FROM context_invitations WHERE context_id = ? AND status != ? AND (invitee_user_id = ? OR LOWER(invitee_email) = LOWER(?))'
      ).get(ctx.id, 'revoked', req.userId!, me.email) : null;
      if (!invited) { res.status(403).json({ error: 'Forbidden' }); return; }
    }
  }

  res.json(enrichContext(ctx, req.userId!));
});

// POST /contexts — create context
router.post('/', requireAuth, (req: AuthRequest, res: Response): void => {
  const { name, description, tags, content, files, project_attachments } = req.body as {
    name?: string; description?: string; tags?: unknown; content?: string; files?: unknown[]; project_attachments?: ProjectAttachment[];
  };

  if (!name?.trim() || !description?.trim()) {
    res.status(400).json({ error: 'name and description are required' }); return;
  }

  const normalized = normalizeFiles(files as never, content, CONTEXT_FILES);
  if (!normalized.ok) { res.status(400).json({ error: normalized.error }); return; }

  const id = uuidv4();
  const entryContent = normalized.files.find(f => f.is_entry)?.content ?? '';
  db.prepare(
    'INSERT INTO contexts (id, user_id, name, description, tags, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, req.userId!, name.trim(), description.trim(), normalizeTags(tags), entryContent, Date.now());
  writeEntityFiles(id, normalized.files, CONTEXT_FILES);

  if (Array.isArray(project_attachments) && project_attachments.length > 0) {
    const result = replaceContextProjects(id, req.userId!, project_attachments);
    if (!result.ok) {
      db.prepare('DELETE FROM contexts WHERE id = ?').run(id);
      res.status(400).json({ error: result.error });
      return;
    }
  }

  const created = db.prepare('SELECT * FROM contexts WHERE id = ?').get(id) as Context;
  res.status(201).json(enrichContext(created, req.userId!));
});

// PUT /contexts/:id — update context
router.put('/:id', requireAuth, (req: AuthRequest, res: Response): void => {
  const ctx = db.prepare('SELECT * FROM contexts WHERE id = ?').get(req.params['id']) as Context | undefined;
  if (!ctx) { res.status(404).json({ error: 'Context not found' }); return; }

  if (!isAdmin(req.userId!) && ctx.user_id !== req.userId) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }

  const { name, description, tags, content, files, project_attachments } = req.body as {
    name?: string; description?: string; tags?: unknown; content?: string; files?: unknown[]; project_attachments?: ProjectAttachment[];
  };

  let entryContent = ctx.content;
  if (Array.isArray(files) || typeof content === 'string') {
    const normalized = normalizeFiles(files as never, content, CONTEXT_FILES);
    if (!normalized.ok) { res.status(400).json({ error: normalized.error }); return; }
    entryContent = normalized.files.find(f => f.is_entry)?.content ?? '';
    writeEntityFiles(ctx.id, normalized.files, CONTEXT_FILES);
  }

  db.prepare('UPDATE contexts SET name=?, description=?, tags=?, content=? WHERE id=?').run(
    name?.trim() || ctx.name,
    description?.trim() || ctx.description,
    tags !== undefined ? normalizeTags(tags) : ctx.tags,
    entryContent,
    ctx.id
  );

  if (Array.isArray(project_attachments)) {
    const result = replaceContextProjects(ctx.id, req.userId!, project_attachments);
    if (!result.ok) { res.status(400).json({ error: result.error }); return; }
  }

  const updated = db.prepare('SELECT * FROM contexts WHERE id = ?').get(ctx.id) as Context;
  res.json(enrichContext(updated, req.userId!));
});

// PATCH /contexts/:id/visibility — toggle public/private (owner/admin only).
router.patch('/:id/visibility', requireAuth, (req: AuthRequest, res: Response): void => {
  const ctx = db.prepare('SELECT * FROM contexts WHERE id = ?').get(req.params['id']) as Context | undefined;
  if (!ctx) { res.status(404).json({ error: 'Context not found' }); return; }
  if (!isAdmin(req.userId!) && ctx.user_id !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

  const { is_public } = req.body as { is_public?: boolean };
  if (typeof is_public !== 'boolean') { res.status(400).json({ error: 'is_public boolean is required' }); return; }
  db.prepare('UPDATE contexts SET is_public = ? WHERE id = ?').run(is_public ? 1 : 0, ctx.id);
  const updated = db.prepare('SELECT * FROM contexts WHERE id = ?').get(ctx.id) as Context;
  res.json(enrichContext(updated, req.userId!));
});

// PATCH /contexts/:id/share-on-fork — change share_on_fork for a single project attachment.
router.patch('/:id/share-on-fork', requireAuth, (req: AuthRequest, res: Response): void => {
  const ctx = db.prepare('SELECT * FROM contexts WHERE id = ?').get(req.params['id']) as Context | undefined;
  if (!ctx) { res.status(404).json({ error: 'Context not found' }); return; }
  if (!isAdmin(req.userId!) && ctx.user_id !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

  const { project_id, share_on_fork } = req.body as { project_id?: string; share_on_fork?: boolean };
  if (!project_id || typeof share_on_fork !== 'boolean') {
    res.status(400).json({ error: 'project_id and share_on_fork (boolean) are required' }); return;
  }
  const result = db.prepare(
    'UPDATE project_contexts SET share_on_fork = ? WHERE context_id = ? AND project_id = ?'
  ).run(share_on_fork ? 1 : 0, ctx.id, project_id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Context is not attached to this project' }); return;
  }
  res.json({ ok: true, share_on_fork });
});

// POST /contexts/:id/star — toggle.
router.post('/:id/star', requireAuth, (req: AuthRequest, res: Response): void => {
  const ctx = db.prepare('SELECT id, user_id, is_public FROM contexts WHERE id = ?').get(req.params['id']) as { id: string; user_id: string; is_public: number } | undefined;
  if (!ctx) { res.status(404).json({ error: 'Context not found' }); return; }

  const isOwn = ctx.user_id === req.userId;
  if (!isOwn && !ctx.is_public) {
    const me = db.prepare('SELECT email FROM users WHERE id = ?').get(req.userId!) as { email: string } | undefined;
    const invited = me ? db.prepare(
      'SELECT 1 FROM context_invitations WHERE context_id = ? AND status != ? AND (invitee_user_id = ? OR LOWER(invitee_email) = LOWER(?))'
    ).get(ctx.id, 'revoked', req.userId!, me.email) : null;
    if (!invited) { res.status(403).json({ error: 'Cannot star this context' }); return; }
  }

  const existing = db.prepare('SELECT 1 FROM context_stars WHERE context_id = ? AND user_id = ?').get(ctx.id, req.userId!);
  if (existing) {
    db.prepare('DELETE FROM context_stars WHERE context_id = ? AND user_id = ?').run(ctx.id, req.userId!);
    const count = (db.prepare('SELECT COUNT(*) as n FROM context_stars WHERE context_id = ?').get(ctx.id) as { n: number }).n;
    res.json({ is_starred: false, stars_count: count });
    return;
  }
  db.prepare('INSERT INTO context_stars (user_id, context_id, created_at) VALUES (?, ?, ?)').run(req.userId!, ctx.id, Date.now());
  const count = (db.prepare('SELECT COUNT(*) as n FROM context_stars WHERE context_id = ?').get(ctx.id) as { n: number }).n;
  res.json({ is_starred: true, stars_count: count });
});

// POST /contexts/:id/invitations — owner invites by email.
router.post('/:id/invitations', requireAuth, (req: AuthRequest, res: Response): void => {
  const ctx = db.prepare('SELECT * FROM contexts WHERE id = ?').get(req.params['id']) as Context | undefined;
  if (!ctx) { res.status(404).json({ error: 'Context not found' }); return; }
  if (ctx.user_id !== req.userId) { res.status(403).json({ error: 'Only the owner can invite' }); return; }

  const { email } = req.body as { email?: string };
  const cleanEmail = (email ?? '').trim().toLowerCase();
  if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    res.status(400).json({ error: 'A valid email is required' }); return;
  }
  const me = db.prepare('SELECT email FROM users WHERE id = ?').get(req.userId!) as { email: string } | undefined;
  if (me && me.email.toLowerCase() === cleanEmail) {
    res.status(400).json({ error: 'You cannot invite yourself' }); return;
  }

  const existing = db.prepare(
    'SELECT * FROM context_invitations WHERE context_id = ? AND LOWER(invitee_email) = ? AND status = ?'
  ).get(ctx.id, cleanEmail, 'pending');
  if (existing) { res.status(200).json(existing); return; }

  const inviteeUser = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(cleanEmail) as { id: string } | undefined;
  const id = uuidv4();
  db.prepare(
    'INSERT INTO context_invitations (id, context_id, inviter_user_id, invitee_email, invitee_user_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, ctx.id, req.userId!, cleanEmail, inviteeUser?.id ?? null, 'pending', Date.now());
  sendInvitationEmail({ inviterUserId: req.userId!, inviteeEmail: cleanEmail, entityType: 'context', entityName: ctx.name });
  res.status(201).json(db.prepare('SELECT * FROM context_invitations WHERE id = ?').get(id));
});

// GET /contexts/:id/invitations — owner lists invitations sent for this context.
router.get('/:id/invitations', requireAuth, (req: AuthRequest, res: Response): void => {
  const ctx = db.prepare('SELECT * FROM contexts WHERE id = ?').get(req.params['id']) as Context | undefined;
  if (!ctx) { res.status(404).json({ error: 'Context not found' }); return; }
  if (ctx.user_id !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

  res.json(db.prepare(`
    SELECT i.*, u.nickname as invitee_nickname
    FROM context_invitations i
    LEFT JOIN users u ON u.id = i.invitee_user_id
    WHERE i.context_id = ?
    ORDER BY i.created_at DESC
  `).all(ctx.id));
});

// POST /contexts/:id/fork — clone context into caller's workspace.
router.post('/:id/fork', requireAuth, (req: AuthRequest, res: Response): void => {
  const source = db.prepare('SELECT * FROM contexts WHERE id = ?').get(req.params['id']) as Context | undefined;
  if (!source) { res.status(404).json({ error: 'Context not found' }); return; }

  const me = db.prepare('SELECT email FROM users WHERE id = ?').get(req.userId!) as { email: string } | undefined;
  if (!me) { res.status(404).json({ error: 'User not found' }); return; }

  const isOwn = source.user_id === req.userId;
  const isPublic = !!source.is_public;
  const invitation = isOwn ? null : db.prepare(
    `SELECT * FROM context_invitations WHERE context_id = ? AND status IN ('pending','accepted')
     AND (invitee_user_id = ? OR LOWER(invitee_email) = LOWER(?)) LIMIT 1`
  ).get(source.id, req.userId!, me.email) as (ContextInvitation | undefined);
  if (!isOwn && !isPublic && !invitation) {
    res.status(403).json({ error: 'You cannot fork this context' }); return;
  }

  const baseName = `${source.name} (fork)`;
  let candidate = baseName;
  let n = 2;
  while (db.prepare('SELECT 1 FROM contexts WHERE user_id = ? AND name = ?').get(req.userId!, candidate)) {
    candidate = `${source.name} (fork ${n++})`;
  }

  const newContextId = uuidv4();
  const now = Date.now();

  const fork = db.transaction(() => {
    db.prepare(
      'INSERT INTO contexts (id, user_id, name, description, content, is_public, forked_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(newContextId, req.userId!, candidate, source.description, source.content, 0, source.id, now);

    // Deep-copy the context's files (entry + supporting).
    const srcFiles = loadEntityFiles(source.id, CONTEXT_FILES);
    if (srcFiles.length > 0) {
      writeEntityFiles(newContextId, srcFiles.map(f => ({ name: f.name, description: f.description, content: f.content, is_entry: f.is_entry })), CONTEXT_FILES);
    }

    if (invitation && invitation.status === 'pending') {
      db.prepare('UPDATE context_invitations SET status = ?, responded_at = ?, invitee_user_id = COALESCE(invitee_user_id, ?) WHERE id = ?').run(
        'accepted', now, req.userId!, invitation.id
      );
    }
  });

  try { fork(); }
  catch (err) { res.status(500).json({ error: 'Fork failed', detail: String(err) }); return; }

  const created = db.prepare('SELECT * FROM contexts WHERE id = ?').get(newContextId) as Context;
  res.status(201).json(enrichContext(created, req.userId!));
});

// DELETE /contexts/:id
router.delete('/:id', requireAuth, (req: AuthRequest, res: Response): void => {
  const ctx = db.prepare('SELECT * FROM contexts WHERE id = ?').get(req.params['id']) as Context | undefined;
  if (!ctx) { res.status(404).json({ error: 'Context not found' }); return; }

  if (!isAdmin(req.userId!) && ctx.user_id !== req.userId) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }

  db.prepare('DELETE FROM project_contexts WHERE context_id = ?').run(ctx.id);
  db.prepare('DELETE FROM contexts WHERE id = ?').run(ctx.id);
  res.status(204).end();
});

export default router;
