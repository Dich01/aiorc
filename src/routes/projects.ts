import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/client';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { Project, ProjectInvitation } from '../db/schema';
import { copyEntityFiles, AGENT_FILES, SKILL_FILES, CONTEXT_FILES } from '../lib/entityFiles';


export const EXECUTION_MODES = ['verified', 'compiled'];
const router = Router();

// Implicit-all rule: agents/skills with no project link belong to every project of the same owner.
// Used by both the dashboard list and the public repository to avoid N+1 round trips.
const agentSummaryStmt = db.prepare(`
  SELECT a.id, a.name FROM agents a
  WHERE a.user_id = ?
    AND (NOT EXISTS (SELECT 1 FROM project_agents WHERE agent_id = a.id)
         OR EXISTS (SELECT 1 FROM project_agents WHERE agent_id = a.id AND project_id = ?))
  ORDER BY a.created_at DESC LIMIT 6
`);
const skillSummaryStmt = db.prepare(`
  SELECT s.id, s.name FROM skills s
  WHERE s.user_id = ?
    AND (NOT EXISTS (SELECT 1 FROM project_skills WHERE skill_id = s.id)
         OR EXISTS (SELECT 1 FROM project_skills WHERE skill_id = s.id AND project_id = ?))
  ORDER BY s.name ASC LIMIT 6
`);
const agentCountStmt = db.prepare(`
  SELECT COUNT(*) as n FROM agents a
  WHERE a.user_id = ?
    AND (NOT EXISTS (SELECT 1 FROM project_agents WHERE agent_id = a.id)
         OR EXISTS (SELECT 1 FROM project_agents WHERE agent_id = a.id AND project_id = ?))
`);
const skillCountStmt = db.prepare(`
  SELECT COUNT(*) as n FROM skills s
  WHERE s.user_id = ?
    AND (NOT EXISTS (SELECT 1 FROM project_skills WHERE skill_id = s.id)
         OR EXISTS (SELECT 1 FROM project_skills WHERE skill_id = s.id AND project_id = ?))
`);
const flowStmt = db.prepare('SELECT flow_json FROM project_flows WHERE project_id = ?');
const starsCountStmt = db.prepare('SELECT COUNT(*) as n FROM project_stars WHERE project_id = ?');
const forksCountStmt = db.prepare('SELECT COUNT(*) as n FROM projects WHERE forked_from = ?');
const starredByStmt = db.prepare('SELECT 1 FROM project_stars WHERE project_id = ? AND user_id = ?');

import { normalizeTags } from '../lib/tags';
import { sendInvitationEmail } from '../lib/mailer';
import { validateMcpServer, sanitizeServerName } from '../lib/mcpServers';
import { assertSafeOutbound, postJsonPinned, OutboundError } from '../lib/outbound';
import { asyncHandler } from '../lib/asyncHandler';
import { checkOutputSchema } from '../lib/outputSchema';
import { newSecret, PROJECT_KEY_PREFIX } from '../lib/secrets';

// The key hash never leaves the server. The plaintext key is added to a
// response only right after it is created or regenerated.
function publicProject<T extends { api_key_hash?: string }>(p: T): Omit<T, 'api_key_hash'> {
  const { api_key_hash: _h, ...rest } = p;
  void _h;
  return rest;
}

interface ProjectRow { id: string; user_id: string; }
function enrichProject<T extends ProjectRow>(p: T, viewerId?: string): T & {
  agents: { id: string; name: string }[];
  skills: { id: string; name: string }[];
  agents_count: number;
  skills_count: number;
  stars_count: number;
  forks_count: number;
  is_starred?: boolean;
  flow: { nodes: unknown[]; edges: unknown[] };
} {
  const agents = agentSummaryStmt.all(p.user_id, p.id) as { id: string; name: string }[];
  const skills = skillSummaryStmt.all(p.user_id, p.id) as { id: string; name: string }[];
  const agents_count = (agentCountStmt.get(p.user_id, p.id) as { n: number }).n;
  const skills_count = (skillCountStmt.get(p.user_id, p.id) as { n: number }).n;
  const stars_count = (starsCountStmt.get(p.id) as { n: number }).n;
  const forks_count = (forksCountStmt.get(p.id) as { n: number }).n;
  const flowRow = flowStmt.get(p.id) as { flow_json: string } | undefined;
  let flow: { nodes: unknown[]; edges: unknown[] } = { nodes: [], edges: [] };
  if (flowRow?.flow_json) {
    try { flow = JSON.parse(flowRow.flow_json); } catch { /* keep empty */ }
  }
  const is_starred = viewerId ? !!starredByStmt.get(p.id, viewerId) : undefined;
  return { ...p, agents, skills, agents_count, skills_count, stars_count, forks_count, flow, is_starred };
}

// GET /projects/public — list public projects (no auth) with optional filters & sort.
// Query params: ?q=<text>, ?owner=<nickname>, ?sort=recent|stars|forks
router.get('/public', (req, res: Response): void => {
  const query = req.query as { q?: string; owner?: string; sort?: string };
  const q = String(query.q ?? '').trim();
  const owner = String(query.owner ?? '').trim();
  const sort = String(query.sort ?? 'recent');

  const orderBy = sort === 'stars'
    ? '(SELECT COUNT(*) FROM project_stars WHERE project_id = p.id) DESC, p.created_at DESC'
    : sort === 'forks'
      ? '(SELECT COUNT(*) FROM projects f WHERE f.forked_from = p.id) DESC, p.created_at DESC'
      : sort === 'usage'
        ? 'usage_runs DESC, p.created_at DESC'
        : 'p.created_at DESC';

  const where: string[] = ['p.is_public = 1'];
  const params: unknown[] = [];
  if (q) { where.push('(LOWER(p.name) LIKE LOWER(?) OR LOWER(p.description) LIKE LOWER(?) OR LOWER(p.tags) LIKE LOWER(?))'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (owner) { where.push('LOWER(u.nickname) = LOWER(?)'); params.push(owner); }

  const rows = db.prepare(`
    SELECT p.id, p.user_id, p.name, p.description, p.tags, p.created_at,
           u.email as owner_email, u.nickname as owner_nickname,
           (SELECT COUNT(*) FROM runs r WHERE r.project_id = p.id) as usage_runs,
           (SELECT COUNT(*) FROM runs r WHERE r.project_id = p.id AND r.status = 'completed') as usage_reported_runs
    FROM projects p JOIN users u ON u.id = p.user_id
    WHERE ${where.join(' AND ')}
    ORDER BY ${orderBy}
  `).all(...params) as {
    id: string; user_id: string; name: string; description: string; tags: string;
    created_at: number; owner_email: string; owner_nickname: string;
    usage_runs: number; usage_reported_runs: number;
  }[];

  // Drop user_id (internal). api_key is never selected here.
  const enriched = rows.map(r => {
    const e = enrichProject(r);
    const { user_id: _u, ...safe } = e;
    void _u;
    return safe;
  });
  res.json(enriched);
});

// GET /projects — list projects (admin sees all, users see their own)
router.get('/', requireAuth, (req: AuthRequest, res: Response): void => {
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId!) as { role: string } | undefined;
  const isAdmin = user?.role === 'admin';

  const projects = (isAdmin
    ? db.prepare('SELECT p.*, u.email as owner_email, u.nickname as owner_nickname FROM projects p JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC').all()
    : db.prepare('SELECT p.*, u.nickname as owner_nickname FROM projects p JOIN users u ON u.id = p.user_id WHERE p.user_id = ? ORDER BY p.created_at DESC').all(req.userId!)) as (Project & { owner_email?: string; owner_nickname?: string })[];

  res.json(projects.map(p => publicProject(enrichProject(p, req.userId))));
});

// GET /projects/:id — project detail
router.get('/:id', requireAuth, (req: AuthRequest, res: Response): void => {
  const project = db.prepare('SELECT p.*, u.email as owner_email FROM projects p JOIN users u ON u.id = p.user_id WHERE p.id = ?').get(req.params['id']) as (Project & { owner_email: string }) | undefined;
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }

  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId!) as { role: string } | undefined;
  if (user?.role !== 'admin' && project.user_id !== req.userId) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }

  res.json(publicProject(project));
});

// POST /projects — create project
router.post('/', requireAuth, (req: AuthRequest, res: Response): void => {
  const { name, description, tags, execution_mode } = req.body as { name?: string; description?: string; tags?: unknown; execution_mode?: unknown };
  if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return; }
  if (execution_mode !== undefined && !EXECUTION_MODES.includes(execution_mode as string)) {
    res.status(400).json({ error: `execution_mode must be one of ${EXECUTION_MODES.join(', ')}` }); return;
  }

  const id = uuidv4();
  const key = newSecret(PROJECT_KEY_PREFIX);

  db.prepare('INSERT INTO projects (id, user_id, name, description, tags, api_key_hash, api_key_hint, execution_mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, req.userId!, name.trim(), (description ?? '').trim(), normalizeTags(tags), key.hash, key.display, (execution_mode as string | undefined) ?? 'verified', Date.now()
  );
  // Create empty flow for the project
  db.prepare('INSERT INTO project_flows (project_id, flow_json, updated_at) VALUES (?, ?, ?)').run(
    id, '{"nodes":[],"edges":[]}', Date.now()
  );

  const created = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project;
  res.status(201).json({ ...publicProject(created), api_key: key.plaintext });
});

// PATCH /projects/:id — update editable fields (currently: description)
router.patch('/:id', requireAuth, (req: AuthRequest, res: Response): void => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params['id']) as Project | undefined;
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }

  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId!) as { role: string } | undefined;
  if (user?.role !== 'admin' && project.user_id !== req.userId) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }

  const { description, name, tags } = req.body as { description?: string; name?: string; tags?: unknown };
  if (typeof description === 'string') {
    db.prepare('UPDATE projects SET description = ? WHERE id = ?').run(description.trim(), project.id);
  }
  if (typeof name === 'string' && name.trim()) {
    db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name.trim(), project.id);
  }
  if (tags !== undefined) {
    db.prepare('UPDATE projects SET tags = ? WHERE id = ?').run(normalizeTags(tags), project.id);
  }

  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id) as Project;
  res.json(publicProject(updated));
});

// PATCH /projects/:id/execution-mode — 'verified' (server-driven steps) or
// 'compiled' (model-orchestrated mode: whole flow in one prompt, self-declared). Runs freeze
// the mode at workflow.start, so switching never affects runs in flight.
router.patch('/:id/execution-mode', requireAuth, (req: AuthRequest, res: Response): void => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params['id']) as Project | undefined;
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }

  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId!) as { role: string } | undefined;
  if (user?.role !== 'admin' && project.user_id !== req.userId) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }

  const { mode } = req.body as { mode?: unknown };
  if (!EXECUTION_MODES.includes(mode as string)) {
    res.status(400).json({ error: `mode must be one of ${EXECUTION_MODES.join(', ')}` }); return;
  }

  db.prepare('UPDATE projects SET execution_mode = ? WHERE id = ?').run(mode, project.id);
  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id) as Project;
  res.json(publicProject(updated));
});

// PATCH /projects/:id/visibility — toggle public/private
router.patch('/:id/visibility', requireAuth, (req: AuthRequest, res: Response): void => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params['id']) as Project | undefined;
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }

  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId!) as { role: string } | undefined;
  if (user?.role !== 'admin' && project.user_id !== req.userId) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }

  const { is_public } = req.body as { is_public?: boolean };
  if (typeof is_public !== 'boolean') { res.status(400).json({ error: 'is_public boolean is required' }); return; }

  db.prepare('UPDATE projects SET is_public = ? WHERE id = ?').run(is_public ? 1 : 0, project.id);
  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id) as Project;
  res.json(publicProject(updated));
});

// PATCH /projects/:id/input-schema — JSON Schema that workflow.start's
// `input` must satisfy ({schema: null} clears it).
router.patch('/:id/input-schema', requireAuth, (req: AuthRequest, res: Response): void => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params['id']) as Project | undefined;
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId!) as { role: string } | undefined;
  if (user?.role !== 'admin' && project.user_id !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }
  const { schema } = req.body as { schema?: unknown };
  if (schema !== null) {
    const err = checkOutputSchema(schema);
    if (err) { res.status(400).json({ error: err.replace('output_schema', 'schema') }); return; }
  }
  db.prepare('UPDATE projects SET input_schema = ? WHERE id = ?').run(schema === null ? '' : JSON.stringify(schema), project.id);
  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id) as Project;
  res.json(publicProject(updated));
});

// PATCH /projects/:id/executable-files — opt in to delivering non-Markdown
// files (scripts, configs) of this project's agents, skills and contexts to the
// model. Off by default: those files are withheld from every prompt.
router.patch('/:id/executable-files', requireAuth, (req: AuthRequest, res: Response): void => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params['id']) as Project | undefined;
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId!) as { role: string } | undefined;
  if (user?.role !== 'admin' && project.user_id !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }
  const { allow } = req.body as { allow?: boolean };
  if (typeof allow !== 'boolean') { res.status(400).json({ error: 'allow boolean is required' }); return; }
  db.prepare('UPDATE projects SET allow_executable_files = ? WHERE id = ?').run(allow ? 1 : 0, project.id);
  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id) as Project;
  res.json(publicProject(updated));
});

// POST /projects/:id/reset-key — regenerate api_key
router.post('/:id/reset-key', requireAuth, (req: AuthRequest, res: Response): void => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params['id']) as Project | undefined;
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }

  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId!) as { role: string } | undefined;
  if (user?.role !== 'admin' && project.user_id !== req.userId) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }

  const key = newSecret(PROJECT_KEY_PREFIX);
  db.prepare('UPDATE projects SET api_key_hash = ?, api_key_hint = ? WHERE id = ?').run(key.hash, key.display, project.id);
  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id) as Project;
  res.json({ ...publicProject(updated), api_key: key.plaintext });
});

// POST /projects/:id/star — toggle a star on a project.
// Owners can star their own. Public projects can be starred by anyone logged in.
// Private non-owned projects can only be starred if the caller has an invitation.
router.post('/:id/star', requireAuth, (req: AuthRequest, res: Response): void => {
  const project = db.prepare('SELECT id, user_id, is_public FROM projects WHERE id = ?').get(req.params['id']) as { id: string; user_id: string; is_public: number } | undefined;
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }

  const isOwn = project.user_id === req.userId;
  const isPublic = !!project.is_public;
  if (!isOwn && !isPublic) {
    const me = db.prepare('SELECT email FROM users WHERE id = ?').get(req.userId!) as { email: string } | undefined;
    const invited = me ? db.prepare(
      'SELECT 1 FROM project_invitations WHERE project_id = ? AND status != ? AND (invitee_user_id = ? OR LOWER(invitee_email) = LOWER(?))'
    ).get(project.id, 'revoked', req.userId!, me.email) : null;
    if (!invited) { res.status(403).json({ error: 'Cannot star this project' }); return; }
  }

  const existing = db.prepare('SELECT 1 FROM project_stars WHERE project_id = ? AND user_id = ?').get(project.id, req.userId!);
  if (existing) {
    db.prepare('DELETE FROM project_stars WHERE project_id = ? AND user_id = ?').run(project.id, req.userId!);
    const count = (db.prepare('SELECT COUNT(*) as n FROM project_stars WHERE project_id = ?').get(project.id) as { n: number }).n;
    res.json({ is_starred: false, stars_count: count });
    return;
  }

  db.prepare('INSERT INTO project_stars (user_id, project_id, created_at) VALUES (?, ?, ?)').run(req.userId!, project.id, Date.now());
  const count = (db.prepare('SELECT COUNT(*) as n FROM project_stars WHERE project_id = ?').get(project.id) as { n: number }).n;
  res.json({ is_starred: true, stars_count: count });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sharing & forking
// ─────────────────────────────────────────────────────────────────────────────

// POST /projects/:id/invitations — owner invites someone by email.
router.post('/:id/invitations', requireAuth, (req: AuthRequest, res: Response): void => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params['id']) as Project | undefined;
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  if (project.user_id !== req.userId) { res.status(403).json({ error: 'Only the project owner can invite' }); return; }

  const { email } = req.body as { email?: string };
  const cleanEmail = (email ?? '').trim().toLowerCase();
  if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    res.status(400).json({ error: 'A valid email is required' });
    return;
  }

  // Owner inviting themselves is silly
  const me = db.prepare('SELECT email FROM users WHERE id = ?').get(req.userId!) as { email: string } | undefined;
  if (me && me.email.toLowerCase() === cleanEmail) {
    res.status(400).json({ error: 'You cannot invite yourself' });
    return;
  }

  // Idempotent: if there's already a pending invitation for the same email, return it.
  const existing = db.prepare(
    'SELECT * FROM project_invitations WHERE project_id = ? AND LOWER(invitee_email) = ? AND status = ?'
  ).get(project.id, cleanEmail, 'pending');
  if (existing) { res.status(200).json(existing); return; }

  // Resolve invitee_user_id if the email already maps to a registered user.
  const inviteeUser = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(cleanEmail) as { id: string } | undefined;

  const id = uuidv4();
  db.prepare(
    'INSERT INTO project_invitations (id, project_id, inviter_user_id, invitee_email, invitee_user_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, project.id, req.userId!, cleanEmail, inviteeUser?.id ?? null, 'pending', Date.now());
  sendInvitationEmail({ inviterUserId: req.userId!, inviteeEmail: cleanEmail, entityType: 'project', entityName: project.name });

  const created = db.prepare('SELECT * FROM project_invitations WHERE id = ?').get(id);
  res.status(201).json(created);
});

// ── MCP server registry (inventory of external tools the project's agents use) ──
router.get('/:id/mcp-servers', requireAuth, (req: AuthRequest, res: Response): void => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params['id']) as Project | undefined;
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId!) as { role: string } | undefined;
  if (user?.role !== 'admin' && project.user_id !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }
  res.json(db.prepare('SELECT * FROM mcp_servers WHERE project_id = ? ORDER BY created_at ASC').all(project.id));
});

router.post('/:id/mcp-servers', requireAuth, asyncHandler<AuthRequest>(async (req, res: Response): Promise<void> => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params['id']) as Project | undefined;
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId!) as { role: string } | undefined;
  if (user?.role !== 'admin' && project.user_id !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

  const v = validateMcpServer(req.body as Record<string, unknown>);
  if (!v.ok) { res.status(400).json({ error: v.error }); return; }
  // Two names that collapse to the same namespace prefix would make tool routing
  // ambiguous, so the sanitized name must be unique within the project.
  const wantKey = sanitizeServerName(v.name!);
  const existing = db.prepare('SELECT name FROM mcp_servers WHERE project_id = ?').all(project.id) as { name: string }[];
  if (!wantKey || existing.some(e => sanitizeServerName(e.name) === wantKey)) {
    res.status(400).json({ error: `A server with the tool prefix "${wantKey}__" already exists in this project. Choose a distinct name.` });
    return;
  }
  // Resolve the host now (it is resolved again on every call) and probe it
  // once: a server that answers with a redirect is refused outright. A server
  // that is merely down can still be registered.
  try {
    const target = await assertSafeOutbound(v.url!);
    await postJsonPinned(target, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 2500).catch(err => {
      if (err instanceof OutboundError && /redirect/.test(err.message)) throw err;
    });
  } catch (err) {
    if (err instanceof OutboundError) { res.status(400).json({ error: err.message }); return; }
    throw err;
  }
  const id = uuidv4();
  db.prepare('INSERT INTO mcp_servers (id, project_id, name, url, description, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, project.id, v.name!, v.url!, v.description!, Date.now());
  res.status(201).json(db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id));
}));

router.delete('/:id/mcp-servers/:serverId', requireAuth, (req: AuthRequest, res: Response): void => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params['id']) as Project | undefined;
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId!) as { role: string } | undefined;
  if (user?.role !== 'admin' && project.user_id !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }
  db.prepare('DELETE FROM mcp_servers WHERE id = ? AND project_id = ?').run(req.params['serverId'], project.id);
  res.json({ ok: true });
});

// PATCH /projects/:id/pause — kill switch. Blocks NEW runs; in-flight runs finish.
router.patch('/:id/pause', requireAuth, (req: AuthRequest, res: Response): void => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params['id']) as Project | undefined;
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId!) as { role: string } | undefined;
  if (user?.role !== 'admin' && project.user_id !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

  const { paused } = req.body as { paused?: boolean };
  if (typeof paused !== 'boolean') { res.status(400).json({ error: 'paused boolean is required' }); return; }
  db.prepare('UPDATE projects SET paused = ? WHERE id = ?').run(paused ? 1 : 0, project.id);
  res.json({ id: project.id, paused });
});

// GET /projects/:id/invitations — list invitations sent for this project (owner only).
router.get('/:id/invitations', requireAuth, (req: AuthRequest, res: Response): void => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params['id']) as Project | undefined;
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
  if (project.user_id !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

  const rows = db.prepare(`
    SELECT i.*, u.nickname as invitee_nickname
    FROM project_invitations i
    LEFT JOIN users u ON u.id = i.invitee_user_id
    WHERE i.project_id = ?
    ORDER BY i.created_at DESC
  `).all(project.id);
  res.json(rows);
});

// POST /projects/:id/fork — clone a project into the caller's workspace.
// Source must be public, owned by caller, or have a non-revoked invitation for caller.
router.post('/:id/fork', requireAuth, (req: AuthRequest, res: Response): void => {
  const source = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params['id']) as Project | undefined;
  if (!source) { res.status(404).json({ error: 'Project not found' }); return; }

  const me = db.prepare('SELECT email FROM users WHERE id = ?').get(req.userId!) as { email: string } | undefined;
  if (!me) { res.status(404).json({ error: 'User not found' }); return; }

  // Authorization: public OR mine OR invited
  const isOwn = source.user_id === req.userId;
  const isPublic = !!source.is_public;
  // Always look up a matching invitation — even when the project is public, an outstanding
  // pending invitation should be auto-accepted by the act of forking.
  const invitation = isOwn ? null : db.prepare(
    `SELECT * FROM project_invitations
     WHERE project_id = ?
       AND status IN ('pending', 'accepted')
       AND (invitee_user_id = ? OR LOWER(invitee_email) = LOWER(?))
     LIMIT 1`
  ).get(source.id, req.userId!, me.email) as (ProjectInvitation | undefined);

  if (!isOwn && !isPublic && !invitation) {
    res.status(403).json({ error: 'You cannot fork this project' });
    return;
  }

  // Reject empty flows — nothing useful to fork.
  const flowRow = db.prepare('SELECT flow_json FROM project_flows WHERE project_id = ?').get(source.id) as { flow_json: string } | undefined;
  let flow: { nodes: Array<Record<string, unknown> & { agent_id?: string }>; edges: unknown[] } = { nodes: [], edges: [] };
  if (flowRow?.flow_json) {
    try { flow = JSON.parse(flowRow.flow_json); } catch { /* keep empty */ }
  }

  // Compute a non-colliding fork name within the caller's workspace.
  const baseName = `Fork: ${source.name}`;
  let candidate = baseName;
  let n = 2;
  while (db.prepare('SELECT 1 FROM projects WHERE user_id = ? AND name = ?').get(req.userId!, candidate)) {
    candidate = `${baseName} (${n++})`;
  }

  const newProjectId = uuidv4();
  const newKey = newSecret(PROJECT_KEY_PREFIX);
  const now = Date.now();

  // Cache existing names in caller's workspace for collision suffixes on agents/skills.
  const existingAgentNames = new Set(
    (db.prepare('SELECT name FROM agents WHERE user_id = ?').all(req.userId!) as { name: string }[]).map(r => r.name)
  );
  const existingSkillNames = new Set(
    (db.prepare('SELECT name FROM skills WHERE user_id = ?').all(req.userId!) as { name: string }[]).map(r => r.name)
  );
  const existingContextNames = new Set(
    (db.prepare('SELECT name FROM contexts WHERE user_id = ?').all(req.userId!) as { name: string }[]).map(r => r.name)
  );
  const renameIfNeeded = (name: string, existing: Set<string>): string => {
    if (!existing.has(name)) { existing.add(name); return name; }
    let candidate = `${name} (fork)`;
    let m = 2;
    while (existing.has(candidate)) candidate = `${name} (fork ${m++})`;
    existing.add(candidate);
    return candidate;
  };

  // Skill ID dedup map — keyed by source skill id, value is new skill id.
  const skillIdMap = new Map<string, string>();

  // Run everything in a single transaction so a partial fork is impossible.
  const fork = db.transaction(() => {
    db.prepare(
      'INSERT INTO projects (id, user_id, name, description, tags, api_key_hash, api_key_hint, is_public, forked_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(newProjectId, req.userId!, candidate, source.description, (source as Project).tags ?? '', newKey.hash, newKey.display, 0, source.id, now);

    // Map agent_id → newAgentId so we can rewrite the flow's nodes.
    const agentIdsInFlow = [...new Set(flow.nodes.filter(n => (n.type ?? 'agent') === 'agent' && n.agent_id).map(n => String(n.agent_id)))];
    const agentIdMap = new Map<string, string>();

    for (const aid of agentIdsInFlow) {
      const a = db.prepare('SELECT * FROM agents WHERE id = ?').get(aid) as {
        id: string; user_id: string; name: string; description: string;
        tags: string; output_schema: string; allowed_tools: string; created_at: number;
      } | undefined;
      if (!a) continue; // orphan reference, skip; the resulting flow will compile with a warning
      const newAgentId = uuidv4();
      agentIdMap.set(aid, newAgentId);
      const newName = renameIfNeeded(a.name, existingAgentNames);
      db.prepare(
        'INSERT INTO agents (id, user_id, name, description, tags, output_schema, allowed_tools, forked_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(newAgentId, req.userId!, newName, a.description, a.tags, a.output_schema, a.allowed_tools, a.id, now);
      copyEntityFiles(a.id, newAgentId, AGENT_FILES);
      db.prepare('INSERT INTO project_agents (project_id, agent_id) VALUES (?, ?)').run(newProjectId, newAgentId);

      // Clone skills attached to this agent (deduped — same skill could be on multiple agents).
      const skillRows = db.prepare(`
        SELECT s.*, ag.ordinal AS _ord
        FROM agent_skills ag
        JOIN skills s ON s.id = ag.skill_id
        WHERE ag.agent_id = ?
        ORDER BY ag.ordinal ASC
      `).all(aid) as { id: string; user_id: string; name: string; description: string; content: string; created_at: number; _ord: number }[];

      for (const s of skillRows) {
        // Reuse skill clone if we already cloned this skill within this fork.
        let newSkillId = (skillIdMap.get(s.id) as string | undefined);
        if (!newSkillId) {
          newSkillId = uuidv4();
          skillIdMap.set(s.id, newSkillId);
          const newSkillName = renameIfNeeded(s.name, existingSkillNames);
          db.prepare(
            'INSERT INTO skills (id, user_id, name, description, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(newSkillId, req.userId!, newSkillName, s.description, s.content, now);
          copyEntityFiles(s.id, newSkillId, SKILL_FILES);
          db.prepare('INSERT INTO project_skills (project_id, skill_id) VALUES (?, ?)').run(newProjectId, newSkillId);
        }
        db.prepare('INSERT INTO agent_skills (agent_id, skill_id, ordinal) VALUES (?, ?, ?)').run(newAgentId, newSkillId, s._ord);
      }
    }

    // Rewrite flow node agent_ids to the new ids.
    const rewritten = {
      nodes: flow.nodes.map(n => (n.type ?? 'agent') === 'agent' && n.agent_id
        ? { ...n, agent_id: agentIdMap.get(String(n.agent_id)) ?? n.agent_id }
        : n),
      edges: flow.edges,
    };
    db.prepare('INSERT INTO project_flows (project_id, flow_json, updated_at) VALUES (?, ?, ?)').run(
      newProjectId, JSON.stringify(rewritten), now
    );

    // Clone project contexts where share_on_fork = 1. Contexts with share_on_fork = 0
    // stay private to the source project and don't travel with the fork — this is the
    // explicit business-knowledge isolation mechanism contexts were built for.
    const ctxRows = db.prepare(`
      SELECT c.id, c.name, c.description, c.content
      FROM project_contexts pc
      JOIN contexts c ON c.id = pc.context_id
      WHERE pc.project_id = ? AND pc.share_on_fork = 1
    `).all(source.id) as { id: string; name: string; description: string; content: string }[];

    for (const c of ctxRows) {
      const newContextId = uuidv4();
      const newContextName = renameIfNeeded(c.name, existingContextNames);
      db.prepare(
        'INSERT INTO contexts (id, user_id, name, description, content, is_public, forked_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(newContextId, req.userId!, newContextName, c.description, c.content, 0, c.id, now);
      copyEntityFiles(c.id, newContextId, CONTEXT_FILES);
      // share_on_fork defaults to 0 in the fork; the new owner re-decides whether their
      // own fork would propagate this context further.
      db.prepare('INSERT INTO project_contexts (project_id, context_id, share_on_fork) VALUES (?, ?, ?)').run(newProjectId, newContextId, 0);
    }

    // If we forked from a pending invitation, mark it accepted.
    if (invitation && invitation.status === 'pending') {
      db.prepare('UPDATE project_invitations SET status = ?, responded_at = ?, invitee_user_id = COALESCE(invitee_user_id, ?) WHERE id = ?').run(
        'accepted', now, req.userId!, invitation.id
      );
    }
  });

  try {
    fork();
  } catch (err) {
    res.status(500).json({ error: 'Fork failed', detail: String(err) });
    return;
  }

  const created = db.prepare('SELECT * FROM projects WHERE id = ?').get(newProjectId) as Project;
  res.status(201).json({ ...publicProject(created), api_key: newKey.plaintext });
});

// DELETE /projects/:id
router.delete('/:id', requireAuth, (req: AuthRequest, res: Response): void => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params['id']) as Project | undefined;
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }

  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId!) as { role: string } | undefined;
  if (user?.role !== 'admin' && project.user_id !== req.userId) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }

  // project_agents / project_skills / project_contexts / project_stars /
  // project_invitations cascade automatically. project_flows, runs and
  // agent_usage reference projects(id) WITHOUT ON DELETE CASCADE, so they must be
  // cleared explicitly — otherwise the final DELETE hits a FOREIGN KEY constraint.
  // agent_usage before runs (it also FKs runs(id)); all in one transaction.
  const removeProject = db.transaction(() => {
    db.prepare('DELETE FROM agent_usage WHERE project_id = ?').run(project.id);
    db.prepare('DELETE FROM runs WHERE project_id = ?').run(project.id);
    db.prepare('DELETE FROM project_flows WHERE project_id = ?').run(project.id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
  });
  removeProject();
  res.status(204).end();
});

export default router;
