import { Router, Response, Request } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { normalizeTags } from '../lib/tags';
import { sendInvitationEmail } from '../lib/mailer';
import db from '../db/client';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { Agent, AgentInvitation } from '../db/schema';
import { normalizeFiles, writeEntityFiles, loadEntityFiles, AGENT_FILES } from '../lib/entityFiles';

const router = Router();

// Stats helpers shared by every agent response.
const agentStarsCount = db.prepare('SELECT COUNT(*) as n FROM agent_stars WHERE agent_id = ?');
const agentForksCount = db.prepare('SELECT COUNT(*) as n FROM agents WHERE forked_from = ?');
const agentStarredBy = db.prepare('SELECT 1 FROM agent_stars WHERE agent_id = ? AND user_id = ?');

function enrichAgent(a: Agent, viewerId?: string) {
  return {
    ...a,
    input_schema: JSON.parse(a.input_schema),
    steps: JSON.parse(a.steps),
    files: loadEntityFiles(a.id, AGENT_FILES),
    skills: loadSkillsFor(a.id),
    project_ids: loadProjectIdsFor(a.id),
    stars_count: (agentStarsCount.get(a.id) as { n: number }).n,
    forks_count: (agentForksCount.get(a.id) as { n: number }).n,
    is_starred: viewerId ? !!agentStarredBy.get(a.id, viewerId) : undefined,
  };
}

interface SkillRow { id: string; name: string; description: string; ordinal: number; }

function loadSkillsFor(agentId: string): SkillRow[] {
  return db.prepare(
    `SELECT s.id, s.name, s.description, ag.ordinal
     FROM agent_skills ag
     JOIN skills s ON s.id = ag.skill_id
     WHERE ag.agent_id = ?
     ORDER BY ag.ordinal ASC`
  ).all(agentId) as SkillRow[];
}

function loadProjectIdsFor(agentId: string): string[] {
  const rows = db.prepare('SELECT project_id FROM project_agents WHERE agent_id = ?').all(agentId) as { project_id: string }[];
  return rows.map(r => r.project_id);
}

function isAdmin(userId: string): boolean {
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: string } | undefined;
  return u?.role === 'admin';
}

// Replace project_agents rows for an agent. Validates ownership: user must own each project (or be admin).
function replaceAgentProjects(agentId: string, userId: string, projectIds: string[]): { ok: true } | { ok: false; error: string } {
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
    db.prepare('DELETE FROM project_agents WHERE agent_id = ?').run(agentId);
    const ins = db.prepare('INSERT INTO project_agents (project_id, agent_id) VALUES (?, ?)');
    ids.forEach(pid => ins.run(pid, agentId));
  });
  tx(cleaned);

  return { ok: true };
}

// Replace agent_skills rows for an agent. Validates ownership: user must own each skill (or be admin).
function replaceAgentSkills(agentId: string, userId: string, skillIds: string[]): { ok: true } | { ok: false; error: string } {
  const admin = isAdmin(userId);
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const id of skillIds) {
    if (typeof id !== 'string' || !id.trim() || seen.has(id)) continue;
    seen.add(id);
    cleaned.push(id);
  }

  if (cleaned.length > 0) {
    const placeholders = cleaned.map(() => '?').join(',');
    const found = db.prepare(`SELECT id, user_id FROM skills WHERE id IN (${placeholders})`).all(...cleaned) as { id: string; user_id: string }[];
    if (found.length !== cleaned.length) {
      const foundIds = new Set(found.map(r => r.id));
      const missing = cleaned.filter(id => !foundIds.has(id));
      return { ok: false, error: `Unknown skill ids: ${missing.join(', ')}` };
    }
    if (!admin) {
      const foreign = found.find(r => r.user_id !== userId);
      if (foreign) return { ok: false, error: `Skill ${foreign.id} does not belong to this user` };
    }
  }

  const tx = db.transaction((ids: string[]) => {
    db.prepare('DELETE FROM agent_skills WHERE agent_id = ?').run(agentId);
    const ins = db.prepare('INSERT INTO agent_skills (agent_id, skill_id, ordinal) VALUES (?, ?, ?)');
    ids.forEach((skillId, i) => ins.run(agentId, skillId, i));
  });
  tx(cleaned);

  return { ok: true };
}

// GET /agents/public — public agents (no auth) with optional filters & sort.
router.get('/public', (req: Request, res: Response): void => {
  const query = req.query as { q?: string; owner?: string; sort?: string };
  const q = String(query.q ?? '').trim();
  const owner = String(query.owner ?? '').trim();
  const sort = String(query.sort ?? 'recent');

  const orderBy = sort === 'stars'
    ? '(SELECT COUNT(*) FROM agent_stars WHERE agent_id = a.id) DESC, a.created_at DESC'
    : sort === 'forks'
      ? '(SELECT COUNT(*) FROM agents f WHERE f.forked_from = a.id) DESC, a.created_at DESC'
      : sort === 'usage'
        ? 'usage_invocations DESC, usage_runs DESC, a.created_at DESC'
        : 'a.created_at DESC';

  const where: string[] = ['a.is_public = 1'];
  const params: unknown[] = [];
  if (q) { where.push('(LOWER(a.name) LIKE LOWER(?) OR LOWER(a.description) LIKE LOWER(?) OR LOWER(a.tags) LIKE LOWER(?))'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (owner) { where.push('LOWER(u.nickname) = LOWER(?)'); params.push(owner); }

  // Usage = reported (actually executed) invocations across all runs, any project.
  const rows = db.prepare(`
    SELECT a.*, u.email as owner_email, u.nickname as owner_nickname,
           (SELECT COUNT(DISTINCT au.run_id) FROM agent_usage au WHERE au.agent_id = a.id AND au.source = 'reported') as usage_runs,
           (SELECT COALESCE(SUM(au.invocations), 0) FROM agent_usage au WHERE au.agent_id = a.id AND au.source = 'reported') as usage_invocations,
           (SELECT MAX(au.created_at) FROM agent_usage au WHERE au.agent_id = a.id AND au.source = 'reported') as usage_last_at
    FROM agents a JOIN users u ON u.id = a.user_id
    WHERE ${where.join(' AND ')}
    ORDER BY ${orderBy}
  `).all(...params) as (Agent & { owner_email: string; owner_nickname: string; usage_runs: number; usage_invocations: number; usage_last_at: number | null })[];

  res.json(rows.map(a => {
    const e = enrichAgent(a);
    const { user_id: _u, content: _c, input_schema: _is, files: _f, ...safe } = e as typeof e & { content?: string };
    void _u; void _c; void _is; void _f;
    // Exposing 'steps' (already parsed) and 'description' is fine; 'content'/'files' (full markdown + resources) are the IP and stay private until forked.
    return safe;
  }));
});

// GET /agents — list user's agents (admin sees all). Optional ?project_id= filter
// applies the implicit-all rule: agents with NO project links are visible everywhere
// (backwards-compat); agents with at least one link are visible only in those projects.
router.get('/', requireAuth, (req: AuthRequest, res: Response): void => {
  const admin = isAdmin(req.userId!);
  const projectId = typeof req.query['project_id'] === 'string' ? req.query['project_id'] : '';

  let agents: Agent[];
  if (projectId) {
    const ownerClause = admin ? '' : 'AND a.user_id = ?';
    const params: unknown[] = [projectId, projectId];
    if (!admin) params.push(req.userId!, req.userId!);
    agents = db.prepare(
      `SELECT a.* FROM agents a
       WHERE (
         NOT EXISTS (SELECT 1 FROM project_agents WHERE agent_id = a.id)
         OR EXISTS (SELECT 1 FROM project_agents WHERE agent_id = a.id AND project_id = ?)
       )
       AND EXISTS (SELECT 1 FROM projects p WHERE p.id = ? ${admin ? '' : 'AND p.user_id = ?'})
       ${ownerClause}
       ORDER BY a.created_at DESC`
    ).all(...params) as Agent[];
  } else {
    agents = admin
      ? db.prepare('SELECT * FROM agents ORDER BY created_at DESC').all() as Agent[]
      : db.prepare('SELECT * FROM agents WHERE user_id = ? ORDER BY created_at DESC').all(req.userId!) as Agent[];
  }

  res.json(agents.map(a => enrichAgent(a, req.userId!)));
});

// GET /agents/:id — single agent. Owner/admin always; others only if public or invited.
router.get('/:id', requireAuth, (req: AuthRequest, res: Response): void => {
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params['id']) as Agent | undefined;
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }

  const admin = isAdmin(req.userId!);
  const isOwn = agent.user_id === req.userId;
  if (!admin && !isOwn) {
    if (!agent.is_public) {
      const me = db.prepare('SELECT email FROM users WHERE id = ?').get(req.userId!) as { email: string } | undefined;
      const invited = me ? db.prepare(
        'SELECT 1 FROM agent_invitations WHERE agent_id = ? AND status != ? AND (invitee_user_id = ? OR LOWER(invitee_email) = LOWER(?))'
      ).get(agent.id, 'revoked', req.userId!, me.email) : null;
      if (!invited) { res.status(403).json({ error: 'Forbidden' }); return; }
    }
  }

  res.json(enrichAgent(agent, req.userId!));
});

// POST /agents — create agent
router.post('/', requireAuth, (req: AuthRequest, res: Response): void => {
  const { name, description, tags, input_schema, steps, content, files, expected_output_format, skill_ids, project_ids } = req.body as {
    name?: string; description?: string; tags?: unknown;
    input_schema?: unknown; steps?: unknown; content?: string; files?: unknown[];
    expected_output_format?: string; skill_ids?: string[]; project_ids?: string[];
  };

  if (!name?.trim() || !description?.trim()) {
    res.status(400).json({ error: 'name and description are required' }); return;
  }

  const normalized = normalizeFiles(files as never, content, AGENT_FILES);
  if (!normalized.ok) { res.status(400).json({ error: normalized.error }); return; }

  const id = uuidv4();
  const schemaStr = JSON.stringify(input_schema || { type: 'object', required: ['request'], properties: { request: { type: 'string' } } });
  const stepsStr = JSON.stringify(steps || []);
  const entryContent = normalized.files.find(f => f.is_entry)?.content ?? '';
  const outputFmt = expected_output_format || '';

  db.prepare(
    'INSERT INTO agents (id, user_id, name, description, tags, input_schema, steps, content, expected_output_format, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, req.userId!, name.trim(), description.trim(), normalizeTags(tags), schemaStr, stepsStr, entryContent, outputFmt, Date.now());
  writeEntityFiles(id, normalized.files, AGENT_FILES);

  if (Array.isArray(skill_ids) && skill_ids.length > 0) {
    const result = replaceAgentSkills(id, req.userId!, skill_ids);
    if (!result.ok) {
      db.prepare('DELETE FROM agents WHERE id = ?').run(id);
      res.status(400).json({ error: result.error });
      return;
    }
  }

  if (Array.isArray(project_ids) && project_ids.length > 0) {
    const result = replaceAgentProjects(id, req.userId!, project_ids);
    if (!result.ok) {
      db.prepare('DELETE FROM agents WHERE id = ?').run(id);
      res.status(400).json({ error: result.error });
      return;
    }
  }

  const created = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent;
  res.status(201).json(enrichAgent(created, req.userId!));
});

// PUT /agents/:id — update agent
router.put('/:id', requireAuth, (req: AuthRequest, res: Response): void => {
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params['id']) as Agent | undefined;
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }

  if (!isAdmin(req.userId!) && agent.user_id !== req.userId) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }

  const { name, description, tags, input_schema, steps, content, files, expected_output_format, skill_ids, project_ids } = req.body as {
    name?: string; description?: string; tags?: unknown;
    input_schema?: unknown; steps?: unknown; content?: string; files?: unknown[];
    expected_output_format?: string; skill_ids?: string[]; project_ids?: string[];
  };

  // Only touch files if the client sent something file-related; otherwise keep
  // the existing entry content in the legacy column unchanged.
  let entryContent = agent.content;
  const touchFiles = Array.isArray(files) || typeof content === 'string';
  if (touchFiles) {
    const normalized = normalizeFiles(files as never, content, AGENT_FILES);
    if (!normalized.ok) { res.status(400).json({ error: normalized.error }); return; }
    entryContent = normalized.files.find(f => f.is_entry)?.content ?? '';
    writeEntityFiles(agent.id, normalized.files, AGENT_FILES);
  }

  db.prepare(
    'UPDATE agents SET name=?, description=?, tags=?, input_schema=?, steps=?, content=?, expected_output_format=? WHERE id=?'
  ).run(
    name?.trim() || agent.name,
    description?.trim() || agent.description,
    tags !== undefined ? normalizeTags(tags) : agent.tags,
    input_schema ? JSON.stringify(input_schema) : agent.input_schema,
    steps ? JSON.stringify(steps) : agent.steps,
    entryContent,
    expected_output_format !== undefined ? expected_output_format : agent.expected_output_format,
    agent.id
  );

  if (Array.isArray(skill_ids)) {
    const result = replaceAgentSkills(agent.id, req.userId!, skill_ids);
    if (!result.ok) { res.status(400).json({ error: result.error }); return; }
  }

  if (Array.isArray(project_ids)) {
    const result = replaceAgentProjects(agent.id, req.userId!, project_ids);
    if (!result.ok) { res.status(400).json({ error: result.error }); return; }
  }

  const updated = db.prepare('SELECT * FROM agents WHERE id = ?').get(agent.id) as Agent;
  res.json(enrichAgent(updated, req.userId!));
});

// PATCH /agents/:id/visibility — toggle public/private (owner/admin only).
router.patch('/:id/visibility', requireAuth, (req: AuthRequest, res: Response): void => {
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params['id']) as Agent | undefined;
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
  if (!isAdmin(req.userId!) && agent.user_id !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

  const { is_public } = req.body as { is_public?: boolean };
  if (typeof is_public !== 'boolean') { res.status(400).json({ error: 'is_public boolean is required' }); return; }
  db.prepare('UPDATE agents SET is_public = ? WHERE id = ?').run(is_public ? 1 : 0, agent.id);
  const updated = db.prepare('SELECT * FROM agents WHERE id = ?').get(agent.id) as Agent;
  res.json(enrichAgent(updated, req.userId!));
});

// POST /agents/:id/star — toggle star.
router.post('/:id/star', requireAuth, (req: AuthRequest, res: Response): void => {
  const agent = db.prepare('SELECT id, user_id, is_public FROM agents WHERE id = ?').get(req.params['id']) as { id: string; user_id: string; is_public: number } | undefined;
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }

  const isOwn = agent.user_id === req.userId;
  if (!isOwn && !agent.is_public) {
    const me = db.prepare('SELECT email FROM users WHERE id = ?').get(req.userId!) as { email: string } | undefined;
    const invited = me ? db.prepare(
      'SELECT 1 FROM agent_invitations WHERE agent_id = ? AND status != ? AND (invitee_user_id = ? OR LOWER(invitee_email) = LOWER(?))'
    ).get(agent.id, 'revoked', req.userId!, me.email) : null;
    if (!invited) { res.status(403).json({ error: 'Cannot star this agent' }); return; }
  }

  const existing = db.prepare('SELECT 1 FROM agent_stars WHERE agent_id = ? AND user_id = ?').get(agent.id, req.userId!);
  if (existing) {
    db.prepare('DELETE FROM agent_stars WHERE agent_id = ? AND user_id = ?').run(agent.id, req.userId!);
    const count = (db.prepare('SELECT COUNT(*) as n FROM agent_stars WHERE agent_id = ?').get(agent.id) as { n: number }).n;
    res.json({ is_starred: false, stars_count: count });
    return;
  }
  db.prepare('INSERT INTO agent_stars (user_id, agent_id, created_at) VALUES (?, ?, ?)').run(req.userId!, agent.id, Date.now());
  const count = (db.prepare('SELECT COUNT(*) as n FROM agent_stars WHERE agent_id = ?').get(agent.id) as { n: number }).n;
  res.json({ is_starred: true, stars_count: count });
});

// POST /agents/:id/invitations — owner invites by email.
router.post('/:id/invitations', requireAuth, (req: AuthRequest, res: Response): void => {
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params['id']) as Agent | undefined;
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
  if (agent.user_id !== req.userId) { res.status(403).json({ error: 'Only the owner can invite' }); return; }

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
    'SELECT * FROM agent_invitations WHERE agent_id = ? AND LOWER(invitee_email) = ? AND status = ?'
  ).get(agent.id, cleanEmail, 'pending');
  if (existing) { res.status(200).json(existing); return; }

  const inviteeUser = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(cleanEmail) as { id: string } | undefined;
  const id = uuidv4();
  db.prepare(
    'INSERT INTO agent_invitations (id, agent_id, inviter_user_id, invitee_email, invitee_user_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, agent.id, req.userId!, cleanEmail, inviteeUser?.id ?? null, 'pending', Date.now());
  sendInvitationEmail({ inviterUserId: req.userId!, inviteeEmail: cleanEmail, entityType: 'agent', entityName: agent.name });
  res.status(201).json(db.prepare('SELECT * FROM agent_invitations WHERE id = ?').get(id));
});

// GET /agents/:id/invitations — owner lists invitations sent for this agent.
router.get('/:id/invitations', requireAuth, (req: AuthRequest, res: Response): void => {
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params['id']) as Agent | undefined;
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
  if (agent.user_id !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

  res.json(db.prepare(`
    SELECT i.*, u.nickname as invitee_nickname
    FROM agent_invitations i
    LEFT JOIN users u ON u.id = i.invitee_user_id
    WHERE i.agent_id = ?
    ORDER BY i.created_at DESC
  `).all(agent.id));
});

// POST /agents/:id/fork — clone agent (and its skills) into caller's workspace.
router.post('/:id/fork', requireAuth, (req: AuthRequest, res: Response): void => {
  const source = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params['id']) as Agent | undefined;
  if (!source) { res.status(404).json({ error: 'Agent not found' }); return; }

  const me = db.prepare('SELECT email FROM users WHERE id = ?').get(req.userId!) as { email: string } | undefined;
  if (!me) { res.status(404).json({ error: 'User not found' }); return; }

  const isOwn = source.user_id === req.userId;
  const isPublic = !!source.is_public;
  // Always look up a matching invitation, even when public — forking should close it out.
  const invitation = isOwn ? null : db.prepare(
    `SELECT * FROM agent_invitations WHERE agent_id = ? AND status IN ('pending','accepted')
     AND (invitee_user_id = ? OR LOWER(invitee_email) = LOWER(?)) LIMIT 1`
  ).get(source.id, req.userId!, me.email) as (AgentInvitation | undefined);
  if (!isOwn && !isPublic && !invitation) {
    res.status(403).json({ error: 'You cannot fork this agent' }); return;
  }

  // Compute non-colliding name in caller's workspace.
  const baseName = `${source.name} (fork)`;
  let candidate = baseName;
  let n = 2;
  while (db.prepare('SELECT 1 FROM agents WHERE user_id = ? AND name = ?').get(req.userId!, candidate)) {
    candidate = `${source.name} (fork ${n++})`;
  }

  // Cache existing skill names for collision suffix.
  const existingSkillNames = new Set(
    (db.prepare('SELECT name FROM skills WHERE user_id = ?').all(req.userId!) as { name: string }[]).map(r => r.name)
  );
  const renameIfNeeded = (name: string): string => {
    if (!existingSkillNames.has(name)) { existingSkillNames.add(name); return name; }
    let candidate = `${name} (fork)`;
    let m = 2;
    while (existingSkillNames.has(candidate)) candidate = `${name} (fork ${m++})`;
    existingSkillNames.add(candidate);
    return candidate;
  };

  const newAgentId = uuidv4();
  const now = Date.now();

  const fork = db.transaction(() => {
    db.prepare(
      'INSERT INTO agents (id, user_id, name, description, input_schema, steps, content, expected_output_format, is_public, forked_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(newAgentId, req.userId!, candidate, source.description, source.input_schema, source.steps, source.content, source.expected_output_format, 0, source.id, now);

    // Deep-copy the agent's files (entry + supporting).
    const srcFiles = loadEntityFiles(source.id, AGENT_FILES);
    if (srcFiles.length > 0) {
      writeEntityFiles(newAgentId, srcFiles.map(f => ({ name: f.name, description: f.description, content: f.content, is_entry: f.is_entry })), AGENT_FILES);
    }

    // Clone the agent's attached skills (deep copy + agent_skills binding with original ordinal).
    const skillRows = db.prepare(`
      SELECT s.*, ag.ordinal AS _ord
      FROM agent_skills ag
      JOIN skills s ON s.id = ag.skill_id
      WHERE ag.agent_id = ?
      ORDER BY ag.ordinal ASC
    `).all(source.id) as { id: string; user_id: string; name: string; description: string; content: string; created_at: number; _ord: number }[];

    for (const s of skillRows) {
      const newSkillId = uuidv4();
      const newName = renameIfNeeded(s.name);
      db.prepare(
        'INSERT INTO skills (id, user_id, name, description, content, is_public, forked_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(newSkillId, req.userId!, newName, s.description, s.content, 0, s.id, now);
      db.prepare('INSERT INTO agent_skills (agent_id, skill_id, ordinal) VALUES (?, ?, ?)').run(newAgentId, newSkillId, s._ord);
    }

    if (invitation && invitation.status === 'pending') {
      db.prepare('UPDATE agent_invitations SET status = ?, responded_at = ?, invitee_user_id = COALESCE(invitee_user_id, ?) WHERE id = ?').run(
        'accepted', now, req.userId!, invitation.id
      );
    }
  });

  try { fork(); }
  catch (err) { res.status(500).json({ error: 'Fork failed', detail: String(err) }); return; }

  const created = db.prepare('SELECT * FROM agents WHERE id = ?').get(newAgentId) as Agent;
  res.status(201).json(enrichAgent(created, req.userId!));
});

// DELETE /agents/:id
router.delete('/:id', requireAuth, (req: AuthRequest, res: Response): void => {
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params['id']) as Agent | undefined;
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }

  if (!isAdmin(req.userId!) && agent.user_id !== req.userId) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }

  db.prepare('DELETE FROM agent_skills WHERE agent_id = ?').run(agent.id);
  db.prepare('DELETE FROM project_agents WHERE agent_id = ?').run(agent.id);
  db.prepare('DELETE FROM agents WHERE id = ?').run(agent.id);
  res.status(204).end();
});

export default router;
