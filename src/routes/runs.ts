import { Router, Response } from 'express';
import db from '../db/client';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { Run } from '../db/schema';

const router = Router();

// GET /runs — list runs for current user's projects
router.get('/', requireAuth, (req: AuthRequest, res: Response): void => {
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId!) as { role: string } | undefined;
  const isAdmin = user?.role === 'admin';

  const runs = isAdmin
    ? db.prepare('SELECT r.*, p.name as project_name FROM runs r JOIN projects p ON p.id = r.project_id ORDER BY r.created_at DESC LIMIT 100').all()
    : db.prepare('SELECT r.*, p.name as project_name FROM runs r JOIN projects p ON p.id = r.project_id WHERE p.user_id = ? ORDER BY r.created_at DESC LIMIT 100').all(req.userId!);

  res.json(runs);
});

// GET /runs/:id — run detail
router.get('/:id', requireAuth, (req: AuthRequest, res: Response): void => {
  const run = db.prepare(`
    SELECT r.*, p.name as project_name, p.user_id
    FROM runs r JOIN projects p ON p.id = r.project_id
    WHERE r.id = ?
  `).get(req.params['id']) as (Run & { project_name: string; user_id: string }) | undefined;

  if (!run) { res.status(404).json({ error: 'Run not found' }); return; }

  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId!) as { role: string } | undefined;
  if (user?.role !== 'admin' && run.user_id !== req.userId) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }

  const parseOrRaw = (s: string) => { try { return JSON.parse(s); } catch { return s; } };
  const executionReport = run.execution_report ? parseOrRaw(run.execution_report) : null;
  const engineState = run.engine_state ? parseOrRaw(run.engine_state) : null;
  const evalReasons = run.eval_reasons ? parseOrRaw(run.eval_reasons) : null;

  let evalCase = null;
  if (run.eval_case_id) {
    evalCase = db.prepare('SELECT id, name, expected_outcome, must_run_agents FROM eval_cases WHERE id = ?')
      .get(run.eval_case_id) ?? null;
  }

  res.json({
    ...run,
    input: parseOrRaw(run.input),
    execution_report: executionReport,
    engine_state: engineState,
    eval_reasons: evalReasons,
    eval_case: evalCase,
  });
});

export default router;
