import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/client';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { EvalCase } from '../db/schema';

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

// POST /evals — create a case
router.post('/', requireAuth, (req: AuthRequest, res: Response): void => {
  const { project_id, name, input, expected_outcome, must_run_agents } = req.body as Record<string, unknown>;
  const projectId = String(project_id ?? '').trim();
  const caseName = String(name ?? '').trim();
  const caseInput = String(input ?? '').trim();

  if (!projectId || !caseName || !caseInput) {
    res.status(400).json({ error: 'project_id, name and input are required' });
    return;
  }
  if (!canAccessProject(req.userId!, projectId)) { res.status(403).json({ error: 'Forbidden' }); return; }

  const id = uuidv4();
  db.prepare(
    `INSERT INTO eval_cases (id, project_id, name, input, expected_outcome, must_run_agents, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, projectId, caseName, caseInput, String(expected_outcome ?? '').trim(), String(must_run_agents ?? '').trim(), Date.now());

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
