import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/client';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { EvalCase } from '../db/schema';
import { checkCriteria } from '../lib/evalGrading';
import { canonicalJson } from '../lib/canonicalJson';

const router = Router();

function canAccessProject(userId: string, projectId: string): boolean {
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: string } | undefined;
  if (user?.role === 'admin') return true;
  const project = db.prepare('SELECT user_id FROM projects WHERE id = ?').get(projectId) as { user_id: string } | undefined;
  return !!project && project.user_id === userId;
}

// GET /evals?project_id= — cases with run stats (runs, passes, last verdict)
router.get('/', requireAuth, (req: AuthRequest, res: Response): void => {
  const projectId = typeof req.query['project_id'] === 'string' ? req.query['project_id'].trim() : '';
  if (!projectId) { res.status(400).json({ error: 'project_id is required' }); return; }
  if (!canAccessProject(req.userId!, projectId)) { res.status(403).json({ error: 'Forbidden' }); return; }

  const cases = db.prepare(
    `SELECT c.*,
            (SELECT COUNT(*) FROM runs r WHERE r.eval_case_id = c.id AND r.eval_verdict != '') AS runs_graded,
            (SELECT COUNT(*) FROM runs r WHERE r.eval_case_id = c.id AND r.eval_verdict = 'pass') AS passes,
            (SELECT r.eval_verdict FROM runs r WHERE r.eval_case_id = c.id AND r.eval_verdict != '' ORDER BY r.created_at DESC LIMIT 1) AS last_verdict,
            (SELECT r.eval_reasons FROM runs r WHERE r.eval_case_id = c.id AND r.eval_verdict != '' ORDER BY r.created_at DESC LIMIT 1) AS last_reasons,
            (SELECT MAX(r.created_at) FROM runs r WHERE r.eval_case_id = c.id AND r.eval_verdict != '') AS last_run_at
     FROM eval_cases c
     WHERE c.project_id = ?
     ORDER BY c.created_at ASC`
  ).all(projectId);

  res.json(cases);
});

// Turn an API/harness case into column values, or an error.
export function normalizeEvalCase(body: Record<string, unknown>): { ok: true; value: { name: string; input: string; expected_outcome: string; must_complete_agents: string; expected_findings: string; max_extra_findings: number | null } } | { ok: false; error: string } {
  const name = String(body.name ?? '').trim();
  if (!name) return { ok: false, error: 'name is required' };
  let input: unknown = body.input;
  if (typeof input === 'string') {
    const t = input.trim();
    if (!t) return { ok: false, error: 'input is required' };
    try { const parsed = JSON.parse(t); input = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { request: t }; }
    catch { input = { request: t }; }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'input must be an object (or text, used as the request)' };
  // Accept a comma-separated string for the agent list (the analytics form).
  let agents = body.must_complete_agents;
  if (typeof agents === 'string') agents = agents.split(',').map(x => x.trim()).filter(Boolean);
  let findings = body.expected_findings;
  if (typeof findings === 'string') {
    if (!findings.trim()) findings = [];
    else { try { findings = JSON.parse(findings); } catch { return { ok: false, error: 'expected_findings must be valid JSON' }; } }
  }
  const max = body.max_extra_findings === '' ? null : body.max_extra_findings;
  const err = checkCriteria({ must_complete_agents: agents, expected_findings: findings, max_extra_findings: typeof max === 'string' ? Number(max) : max });
  if (err) return { ok: false, error: err };
  return { ok: true, value: {
    name,
    input: canonicalJson(input),
    expected_outcome: String(body.expected_outcome ?? '').trim(),
    must_complete_agents: JSON.stringify(agents ?? []),
    expected_findings: JSON.stringify(findings ?? []),
    max_extra_findings: max === undefined || max === null ? null : Number(max),
  } };
}

// POST /evals — create a case
router.post('/', requireAuth, (req: AuthRequest, res: Response): void => {
  const body = req.body as Record<string, unknown>;
  const projectId = String(body.project_id ?? '').trim();
  if (!projectId) { res.status(400).json({ error: 'project_id is required' }); return; }
  if (!canAccessProject(req.userId!, projectId)) { res.status(403).json({ error: 'Forbidden' }); return; }
  const c = normalizeEvalCase(body);
  if (!c.ok) { res.status(400).json({ error: c.error }); return; }
  if (db.prepare('SELECT 1 FROM eval_cases WHERE project_id = ? AND name = ?').get(projectId, c.value.name)) {
    res.status(409).json({ error: 'A case with this name already exists in the project' }); return;
  }

  const id = uuidv4();
  db.prepare(
    `INSERT INTO eval_cases (id, project_id, name, input, expected_outcome, must_complete_agents, expected_findings, max_extra_findings, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, projectId, c.value.name, c.value.input, c.value.expected_outcome, c.value.must_complete_agents, c.value.expected_findings, c.value.max_extra_findings, Date.now());

  res.status(201).json(db.prepare('SELECT * FROM eval_cases WHERE id = ?').get(id));
});

// DELETE /evals/:id
router.delete('/:id', requireAuth, (req: AuthRequest, res: Response): void => {
  const evalCase = db.prepare('SELECT * FROM eval_cases WHERE id = ?').get(req.params['id']) as EvalCase | undefined;
  if (!evalCase) { res.status(404).json({ error: 'Eval case not found' }); return; }
  if (!canAccessProject(req.userId!, evalCase.project_id)) { res.status(403).json({ error: 'Forbidden' }); return; }
  db.prepare('DELETE FROM eval_cases WHERE id = ?').run(evalCase.id);
  res.json({ ok: true });
});

export default router;
