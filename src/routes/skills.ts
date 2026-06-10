import { Router, Response, Request } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/client';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { Skill, SkillFile, SkillInvitation } from '../db/schema';

const router = Router();

// Supporting files may be any text resource (markdown, scripts, configs…), so we
// allow any extension. No slashes/spaces — prevents path traversal and keeps names
// safe to render. The entry file must still be SKILL.md (enforced below).
const FILENAME_RE = /^[A-Za-z0-9_.-]+\.[A-Za-z0-9]+$/;
const ENTRY_NAME  = 'SKILL.md';

function isAdmin(userId: string): boolean {
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: string } | undefined;
  return u?.role === 'admin';
}

function loadProjectIdsForSkill(skillId: string): string[] {
  const rows = db.prepare('SELECT project_id FROM project_skills WHERE skill_id = ?').all(skillId) as { project_id: string }[];
  return rows.map(r => r.project_id);
}

function loadSkillFiles(skillId: string): SkillFile[] {
  return db.prepare(
    'SELECT * FROM skill_files WHERE skill_id = ? ORDER BY is_entry DESC, ordinal ASC, name ASC'
  ).all(skillId) as SkillFile[];
}

const skillStarsCount = db.prepare('SELECT COUNT(*) as n FROM skill_stars WHERE skill_id = ?');
const skillForksCount = db.prepare('SELECT COUNT(*) as n FROM skills WHERE forked_from = ?');
const skillStarredBy = db.prepare('SELECT 1 FROM skill_stars WHERE skill_id = ? AND user_id = ?');

interface IncomingFile {
  name?: string;
  description?: string;
  content?: string;
  is_entry?: boolean | number;
}

interface NormalizedFiles {
  ok: true;
  files: { name: string; description: string; content: string; is_entry: number }[];
}
interface NormalizedFilesError { ok: false; error: string }

// Validate + normalize the incoming files array. Accepts the legacy {content}
// payload (treated as a single SKILL.md file) for backward compatibility.
function normalizeFiles(
  files: IncomingFile[] | undefined,
  legacyContent: string | undefined
): NormalizedFiles | NormalizedFilesError {
  // Backward compat: if no files array, fall back to legacy single-blob content.
  if (!Array.isArray(files) || files.length === 0) {
    const content = (legacyContent ?? '').trim();
    if (!content) return { ok: false, error: 'At least one file (or `content`) is required' };
    return { ok: true, files: [{ name: ENTRY_NAME, description: '', content, is_entry: 1 }] };
  }

  const seen = new Set<string>();
  let entryCount = 0;
  const out: NormalizedFiles['files'] = [];

  for (const raw of files) {
    const name = String(raw.name ?? '').trim();
    const description = String(raw.description ?? '').trim();
    const content = String(raw.content ?? '');
    const is_entry = raw.is_entry ? 1 : 0;

    if (!name) return { ok: false, error: 'Each file must have a name' };
    if (!FILENAME_RE.test(name)) {
      return { ok: false, error: `Invalid file name "${name}". Allowed: letters, digits, '.', '_', '-', and a file extension (e.g. .md, .sh, .json)` };
    }
    if (seen.has(name.toLowerCase())) return { ok: false, error: `Duplicate file name: ${name}` };
    seen.add(name.toLowerCase());
    if (is_entry) entryCount++;
    if (is_entry && name !== ENTRY_NAME) {
      return { ok: false, error: `Entry file must be named ${ENTRY_NAME} (got "${name}")` };
    }
    if (!content.trim()) return { ok: false, error: `File "${name}" content is empty` };

    out.push({ name, description, content, is_entry });
  }

  if (entryCount !== 1) {
    return { ok: false, error: `Exactly one file must be marked as entry (got ${entryCount})` };
  }
  // Ensure SKILL.md is present (it is, since entry must be SKILL.md and exactly one entry exists).
  if (!seen.has(ENTRY_NAME.toLowerCase())) {
    return { ok: false, error: `${ENTRY_NAME} is required` };
  }
  return { ok: true, files: out };
}

function writeSkillFiles(skillId: string, files: NormalizedFiles['files']): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM skill_files WHERE skill_id = ?').run(skillId);
    const ins = db.prepare(
      'INSERT INTO skill_files (id, skill_id, name, description, content, is_entry, ordinal) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    files.forEach((f, idx) => {
      ins.run(uuidv4(), skillId, f.name, f.description, f.content, f.is_entry, idx);
    });
    // Keep the legacy skills.content column populated with the entry content for safe rollback.
    const entry = files.find(f => f.is_entry);
    if (entry) db.prepare('UPDATE skills SET content = ? WHERE id = ?').run(entry.content, skillId);
  });
  tx();
}

function enrichSkill(s: Skill, viewerId?: string, includeFiles = true) {
  const base = {
    ...s,
    project_ids: loadProjectIdsForSkill(s.id),
    stars_count: (skillStarsCount.get(s.id) as { n: number }).n,
    forks_count: (skillForksCount.get(s.id) as { n: number }).n,
    is_starred: viewerId ? !!skillStarredBy.get(s.id, viewerId) : undefined,
  };
  if (!includeFiles) return base;
  const files = loadSkillFiles(s.id);
  return { ...base, files, files_count: files.length };
}

function replaceSkillProjects(skillId: string, userId: string, projectIds: string[]): { ok: true } | { ok: false; error: string } {
  const admin = isAdmin(userId);
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const id of projectIds) {
    if (typeof id !== 'string' || !id.trim() || seen.has(id)) continue;
    seen.add(id);
    cleaned.push(id);
  }

  if (cleaned.length > 0) {
    const placeholders = cleaned.map(() => '?').join(',');
    const found = db.prepare(`SELECT id, user_id FROM projects WHERE id IN (${placeholders})`).all(...cleaned) as { id: string; user_id: string }[];
    if (found.length !== cleaned.length) {
      const foundIds = new Set(found.map(r => r.id));
      const missing = cleaned.filter(id => !foundIds.has(id));
      return { ok: false, error: `Unknown project ids: ${missing.join(', ')}` };
    }
    if (!admin) {
      const foreign = found.find(r => r.user_id !== userId);
      if (foreign) return { ok: false, error: `Project ${foreign.id} does not belong to this user` };
    }
  }

  const tx = db.transaction((ids: string[]) => {
    db.prepare('DELETE FROM project_skills WHERE skill_id = ?').run(skillId);
    const ins = db.prepare('INSERT INTO project_skills (project_id, skill_id) VALUES (?, ?)');
    ids.forEach(pid => ins.run(pid, skillId));
  });
  tx(cleaned);

  return { ok: true };
}

// GET /skills/public — public skills (no auth) with optional filters & sort.
// File contents are stripped — only metadata (name + description) is exposed
// in the listing. Forking via POST /:id/fork copies the full files.
router.get('/public', (req: Request, res: Response): void => {
  const query = req.query as { q?: string; owner?: string; sort?: string };
  const q = String(query.q ?? '').trim();
  const owner = String(query.owner ?? '').trim();
  const sort = String(query.sort ?? 'recent');

  const orderBy = sort === 'stars'
    ? '(SELECT COUNT(*) FROM skill_stars WHERE skill_id = s.id) DESC, s.created_at DESC'
    : sort === 'forks'
      ? '(SELECT COUNT(*) FROM skills f WHERE f.forked_from = s.id) DESC, s.created_at DESC'
      : sort === 'usage'
        ? 'usage_invocations DESC, usage_runs DESC, s.created_at DESC'
        : 's.created_at DESC';

  const where: string[] = ['s.is_public = 1'];
  const params: unknown[] = [];
  if (q) { where.push('(LOWER(s.name) LIKE LOWER(?) OR LOWER(s.description) LIKE LOWER(?))'); params.push(`%${q}%`, `%${q}%`); }
  if (owner) { where.push('LOWER(u.nickname) = LOWER(?)'); params.push(owner); }

  // A skill "runs" whenever an agent that carries it is executed, so usage is
  // the reported usage of all agents linked through agent_skills.
  const rows = db.prepare(`
    SELECT s.*, u.email as owner_email, u.nickname as owner_nickname,
           (SELECT COUNT(DISTINCT au.run_id) FROM agent_usage au
              JOIN agent_skills ask ON ask.agent_id = au.agent_id
              WHERE ask.skill_id = s.id AND au.source = 'reported') as usage_runs,
           (SELECT COALESCE(SUM(au.invocations), 0) FROM agent_usage au
              JOIN agent_skills ask ON ask.agent_id = au.agent_id
              WHERE ask.skill_id = s.id AND au.source = 'reported') as usage_invocations
    FROM skills s JOIN users u ON u.id = s.user_id
    WHERE ${where.join(' AND ')}
    ORDER BY ${orderBy}
  `).all(...params) as (Skill & { owner_email: string; owner_nickname: string; usage_runs: number; usage_invocations: number })[];

  res.json(rows.map(s => {
    const e = enrichSkill(s, undefined, false);
    const filesMeta = loadSkillFiles(s.id).map(f => ({
      name: f.name, description: f.description, is_entry: f.is_entry, ordinal: f.ordinal
    }));
    const { user_id: _u, content: _c, ...safe } = e;
    void _u; void _c;
    return { ...safe, files: filesMeta, files_count: filesMeta.length };
  }));
});

// GET /skills — list user's skills (admin sees all). Optional ?project_id= filter
// applies the implicit-all rule: skills with NO project links are visible everywhere.
router.get('/', requireAuth, (req: AuthRequest, res: Response): void => {
  const admin = isAdmin(req.userId!);
  const projectId = typeof req.query['project_id'] === 'string' ? req.query['project_id'] : '';

  let rows: Skill[];
  if (projectId) {
    const ownerClause = admin ? '' : 'AND s.user_id = ?';
    const params: unknown[] = [projectId, projectId];
    if (!admin) params.push(req.userId!, req.userId!);
    rows = db.prepare(
      `SELECT s.* FROM skills s
       WHERE (
         NOT EXISTS (SELECT 1 FROM project_skills WHERE skill_id = s.id)
         OR EXISTS (SELECT 1 FROM project_skills WHERE skill_id = s.id AND project_id = ?)
       )
       AND EXISTS (SELECT 1 FROM projects p WHERE p.id = ? ${admin ? '' : 'AND p.user_id = ?'})
       ${ownerClause}
       ORDER BY s.name ASC`
    ).all(...params) as Skill[];
  } else {
    rows = admin
      ? db.prepare('SELECT * FROM skills ORDER BY name ASC').all() as Skill[]
      : db.prepare('SELECT * FROM skills WHERE user_id = ? ORDER BY name ASC').all(req.userId!) as Skill[];
  }

  res.json(rows.map(s => enrichSkill(s, req.userId!)));
});

// GET /skills/:id — skill detail with files. Owner/admin always; others only if public or invited.
router.get('/:id', requireAuth, (req: AuthRequest, res: Response): void => {
  const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(req.params['id']) as Skill | undefined;
  if (!skill) { res.status(404).json({ error: 'Skill not found' }); return; }

  const admin = isAdmin(req.userId!);
  const isOwn = skill.user_id === req.userId;
  if (!admin && !isOwn) {
    if (!skill.is_public) {
      const me = db.prepare('SELECT email FROM users WHERE id = ?').get(req.userId!) as { email: string } | undefined;
      const invited = me ? db.prepare(
        'SELECT 1 FROM skill_invitations WHERE skill_id = ? AND status != ? AND (invitee_user_id = ? OR LOWER(invitee_email) = LOWER(?))'
      ).get(skill.id, 'revoked', req.userId!, me.email) : null;
      if (!invited) { res.status(403).json({ error: 'Forbidden' }); return; }
    }
  }

  res.json(enrichSkill(skill, req.userId!));
});

// POST /skills — create skill. Accepts `files: [...]` or legacy `content: "..."`.
router.post('/', requireAuth, (req: AuthRequest, res: Response): void => {
  const { name, description, files, content, project_ids } = req.body as {
    name?: string; description?: string;
    files?: IncomingFile[]; content?: string;
    project_ids?: string[];
  };

  if (!name?.trim() || !description?.trim()) {
    res.status(400).json({ error: 'name and description are required' }); return;
  }
  const normalized = normalizeFiles(files, content);
  if (!normalized.ok) { res.status(400).json({ error: normalized.error }); return; }

  const id = uuidv4();
  const entryContent = normalized.files.find(f => f.is_entry)?.content ?? '';
  db.prepare(
    'INSERT INTO skills (id, user_id, name, description, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, req.userId!, name.trim(), description.trim(), entryContent, Date.now());
  writeSkillFiles(id, normalized.files);

  if (Array.isArray(project_ids) && project_ids.length > 0) {
    const result = replaceSkillProjects(id, req.userId!, project_ids);
    if (!result.ok) {
      db.prepare('DELETE FROM skills WHERE id = ?').run(id);
      res.status(400).json({ error: result.error });
      return;
    }
  }

  const created = db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as Skill;
  res.status(201).json(enrichSkill(created, req.userId!));
});

// PUT /skills/:id — update skill. Accepts `files: [...]` (replaces all files)
// or legacy `content: "..."` (replaces only the entry file).
router.put('/:id', requireAuth, (req: AuthRequest, res: Response): void => {
  const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(req.params['id']) as Skill | undefined;
  if (!skill) { res.status(404).json({ error: 'Skill not found' }); return; }

  if (!isAdmin(req.userId!) && skill.user_id !== req.userId) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }

  const { name, description, files, content, project_ids } = req.body as {
    name?: string; description?: string;
    files?: IncomingFile[]; content?: string;
    project_ids?: string[];
  };

  db.prepare('UPDATE skills SET name=?, description=? WHERE id=?').run(
    name?.trim() || skill.name,
    description?.trim() || skill.description,
    skill.id
  );

  // Only touch files if the client actually sent something file-related.
  if (Array.isArray(files) || typeof content === 'string') {
    const normalized = normalizeFiles(files, content);
    if (!normalized.ok) { res.status(400).json({ error: normalized.error }); return; }
    writeSkillFiles(skill.id, normalized.files);
  }

  if (Array.isArray(project_ids)) {
    const result = replaceSkillProjects(skill.id, req.userId!, project_ids);
    if (!result.ok) { res.status(400).json({ error: result.error }); return; }
  }

  const updated = db.prepare('SELECT * FROM skills WHERE id = ?').get(skill.id) as Skill;
  res.json(enrichSkill(updated, req.userId!));
});

// PATCH /skills/:id/visibility — toggle public/private (owner/admin only).
router.patch('/:id/visibility', requireAuth, (req: AuthRequest, res: Response): void => {
  const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(req.params['id']) as Skill | undefined;
  if (!skill) { res.status(404).json({ error: 'Skill not found' }); return; }
  if (!isAdmin(req.userId!) && skill.user_id !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

  const { is_public } = req.body as { is_public?: boolean };
  if (typeof is_public !== 'boolean') { res.status(400).json({ error: 'is_public boolean is required' }); return; }
  db.prepare('UPDATE skills SET is_public = ? WHERE id = ?').run(is_public ? 1 : 0, skill.id);
  const updated = db.prepare('SELECT * FROM skills WHERE id = ?').get(skill.id) as Skill;
  res.json(enrichSkill(updated, req.userId!));
});

// POST /skills/:id/star — toggle.
router.post('/:id/star', requireAuth, (req: AuthRequest, res: Response): void => {
  const skill = db.prepare('SELECT id, user_id, is_public FROM skills WHERE id = ?').get(req.params['id']) as { id: string; user_id: string; is_public: number } | undefined;
  if (!skill) { res.status(404).json({ error: 'Skill not found' }); return; }

  const isOwn = skill.user_id === req.userId;
  if (!isOwn && !skill.is_public) {
    const me = db.prepare('SELECT email FROM users WHERE id = ?').get(req.userId!) as { email: string } | undefined;
    const invited = me ? db.prepare(
      'SELECT 1 FROM skill_invitations WHERE skill_id = ? AND status != ? AND (invitee_user_id = ? OR LOWER(invitee_email) = LOWER(?))'
    ).get(skill.id, 'revoked', req.userId!, me.email) : null;
    if (!invited) { res.status(403).json({ error: 'Cannot star this skill' }); return; }
  }

  const existing = db.prepare('SELECT 1 FROM skill_stars WHERE skill_id = ? AND user_id = ?').get(skill.id, req.userId!);
  if (existing) {
    db.prepare('DELETE FROM skill_stars WHERE skill_id = ? AND user_id = ?').run(skill.id, req.userId!);
    const count = (db.prepare('SELECT COUNT(*) as n FROM skill_stars WHERE skill_id = ?').get(skill.id) as { n: number }).n;
    res.json({ is_starred: false, stars_count: count });
    return;
  }
  db.prepare('INSERT INTO skill_stars (user_id, skill_id, created_at) VALUES (?, ?, ?)').run(req.userId!, skill.id, Date.now());
  const count = (db.prepare('SELECT COUNT(*) as n FROM skill_stars WHERE skill_id = ?').get(skill.id) as { n: number }).n;
  res.json({ is_starred: true, stars_count: count });
});

// POST /skills/:id/invitations — owner invites by email.
router.post('/:id/invitations', requireAuth, (req: AuthRequest, res: Response): void => {
  const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(req.params['id']) as Skill | undefined;
  if (!skill) { res.status(404).json({ error: 'Skill not found' }); return; }
  if (skill.user_id !== req.userId) { res.status(403).json({ error: 'Only the owner can invite' }); return; }

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
    'SELECT * FROM skill_invitations WHERE skill_id = ? AND LOWER(invitee_email) = ? AND status = ?'
  ).get(skill.id, cleanEmail, 'pending');
  if (existing) { res.status(200).json(existing); return; }

  const inviteeUser = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(cleanEmail) as { id: string } | undefined;
  const id = uuidv4();
  db.prepare(
    'INSERT INTO skill_invitations (id, skill_id, inviter_user_id, invitee_email, invitee_user_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, skill.id, req.userId!, cleanEmail, inviteeUser?.id ?? null, 'pending', Date.now());
  res.status(201).json(db.prepare('SELECT * FROM skill_invitations WHERE id = ?').get(id));
});

// GET /skills/:id/invitations — owner lists invitations sent for this skill.
router.get('/:id/invitations', requireAuth, (req: AuthRequest, res: Response): void => {
  const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(req.params['id']) as Skill | undefined;
  if (!skill) { res.status(404).json({ error: 'Skill not found' }); return; }
  if (skill.user_id !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

  res.json(db.prepare(`
    SELECT i.*, u.nickname as invitee_nickname
    FROM skill_invitations i
    LEFT JOIN users u ON u.id = i.invitee_user_id
    WHERE i.skill_id = ?
    ORDER BY i.created_at DESC
  `).all(skill.id));
});

// POST /skills/:id/fork — clone skill (with all files) into caller's workspace.
router.post('/:id/fork', requireAuth, (req: AuthRequest, res: Response): void => {
  const source = db.prepare('SELECT * FROM skills WHERE id = ?').get(req.params['id']) as Skill | undefined;
  if (!source) { res.status(404).json({ error: 'Skill not found' }); return; }

  const me = db.prepare('SELECT email FROM users WHERE id = ?').get(req.userId!) as { email: string } | undefined;
  if (!me) { res.status(404).json({ error: 'User not found' }); return; }

  const isOwn = source.user_id === req.userId;
  const isPublic = !!source.is_public;
  const invitation = isOwn ? null : db.prepare(
    `SELECT * FROM skill_invitations WHERE skill_id = ? AND status IN ('pending','accepted')
     AND (invitee_user_id = ? OR LOWER(invitee_email) = LOWER(?)) LIMIT 1`
  ).get(source.id, req.userId!, me.email) as (SkillInvitation | undefined);
  if (!isOwn && !isPublic && !invitation) {
    res.status(403).json({ error: 'You cannot fork this skill' }); return;
  }

  const baseName = `${source.name} (fork)`;
  let candidate = baseName;
  let n = 2;
  while (db.prepare('SELECT 1 FROM skills WHERE user_id = ? AND name = ?').get(req.userId!, candidate)) {
    candidate = `${source.name} (fork ${n++})`;
  }

  const newSkillId = uuidv4();
  const now = Date.now();
  const sourceFiles = loadSkillFiles(source.id);

  const fork = db.transaction(() => {
    db.prepare(
      'INSERT INTO skills (id, user_id, name, description, content, is_public, forked_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(newSkillId, req.userId!, candidate, source.description, source.content, 0, source.id, now);

    const ins = db.prepare(
      'INSERT INTO skill_files (id, skill_id, name, description, content, is_entry, ordinal) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    sourceFiles.forEach((f, idx) => {
      ins.run(uuidv4(), newSkillId, f.name, f.description, f.content, f.is_entry, idx);
    });

    if (invitation && invitation.status === 'pending') {
      db.prepare('UPDATE skill_invitations SET status = ?, responded_at = ?, invitee_user_id = COALESCE(invitee_user_id, ?) WHERE id = ?').run(
        'accepted', now, req.userId!, invitation.id
      );
    }
  });

  try { fork(); }
  catch (err) { res.status(500).json({ error: 'Fork failed', detail: String(err) }); return; }

  const created = db.prepare('SELECT * FROM skills WHERE id = ?').get(newSkillId) as Skill;
  res.status(201).json(enrichSkill(created, req.userId!));
});

// DELETE /skills/:id — cascades to skill_files via FK.
router.delete('/:id', requireAuth, (req: AuthRequest, res: Response): void => {
  const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(req.params['id']) as Skill | undefined;
  if (!skill) { res.status(404).json({ error: 'Skill not found' }); return; }

  if (!isAdmin(req.userId!) && skill.user_id !== req.userId) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }

  db.prepare('DELETE FROM agent_skills WHERE skill_id = ?').run(skill.id);
  db.prepare('DELETE FROM project_skills WHERE skill_id = ?').run(skill.id);
  db.prepare('DELETE FROM skills WHERE id = ?').run(skill.id);
  res.status(204).end();
});

export default router;
