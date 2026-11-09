import { Router, Response } from 'express';
import db from '../db/client';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { Run } from '../db/schema';
import { ABANDON_THRESHOLD_MS } from '../lib/controlPlane';
import { buildSignedExport } from '../lib/auditBuild';
import { cancelRun } from '../orchestrator/engine';
import { snapshotHashes } from '../orchestrator/snapshot';

const router = Router();

// Shared abandon sweep: stepped runs idle past the threshold become 'abandoned'.
// Soft state — workflow.next resurrects them. Called by every reader so the
// audit page and analytics never disagree about the same run.
export function sweepAbandonedRuns(): void {
  db.prepare(
    `UPDATE runs SET status = 'abandoned' WHERE status = 'running' AND mode = 'stepped' AND last_activity_at < ?`
  ).run(Date.now() - ABANDON_THRESHOLD_MS);
}

// GET /runs — list runs for current user's projects. Server-side filters so the
// audit page never lies by filtering only the latest 100 client-side. The list
// SELECT is slim (no flow_json/engine_state/workflow_snapshot blobs); details
// come from GET /runs/:id.
router.get('/', requireAuth, (req: AuthRequest, res: Response): void => {
  sweepAbandonedRuns();

  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId!) as { role: string } | undefined;
  const isAdmin = user?.role === 'admin';

  const where: string[] = [];
  const args: unknown[] = [];
  if (!isAdmin) { where.push('p.user_id = ?'); args.push(req.userId!); }
  const projectName = typeof req.query['project'] === 'string' ? req.query['project'].trim() : '';
  const status = typeof req.query['status'] === 'string' ? req.query['status'].trim() : '';
  if (projectName) { where.push('p.name = ?'); args.push(projectName); }
  if (status) { where.push('r.status = ?'); args.push(status); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const cols = `r.id, r.project_id, r.status, r.mode, r.caller_email, r.eval_verdict, r.eval_case_id, r.created_at, p.name as project_name`;
  const runs = db.prepare(
    `SELECT ${cols} FROM runs r JOIN projects p ON p.id = r.project_id ${whereSql} ORDER BY r.created_at DESC LIMIT 200`
  ).all(...args);

  // Distinct project names in scope, so the filter dropdown is complete (not
  // limited to whatever appears in the latest page of rows).
  const projects = db.prepare(
    isAdmin
      ? 'SELECT DISTINCT p.name FROM projects p JOIN runs r ON r.project_id = p.id ORDER BY p.name'
      : 'SELECT DISTINCT p.name FROM projects p JOIN runs r ON r.project_id = p.id WHERE p.user_id = ? ORDER BY p.name'
  ).all(...(isAdmin ? [] : [req.userId!])) as { name: string }[];

  res.json({ runs, projects: projects.map(p => p.name) });
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
  const outputs = (db.prepare('SELECT step, node_id, agent_name, output_json, sha256, created_at FROM run_step_outputs WHERE run_id = ? ORDER BY step, node_id').all(run.id) as { step: number; node_id: string; agent_name: string; output_json: string; sha256: string; created_at: number }[])
    .map(o => ({ step: o.step, node: o.node_id, agent: o.agent_name, output: parseOrRaw(o.output_json), sha256: o.sha256, created_at: o.created_at }));
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
    step_outputs: outputs,
    snapshots: snapshotHashes(run.id),
    engine_state: engineState,
    eval_reasons: evalReasons,
    eval_case: evalCase,
  });
});

// POST /runs/:id/cancel — stop ONE in-flight run. Other runs and the project
// itself are untouched; the next workflow.next on this run is rejected.
router.post('/:id/cancel', requireAuth, (req: AuthRequest, res: Response): void => {
  const run = db.prepare(
    'SELECT r.id, r.status, p.user_id FROM runs r JOIN projects p ON p.id = r.project_id WHERE r.id = ?'
  ).get(req.params['id']) as { id: string; status: string; user_id: string } | undefined;
  if (!run) { res.status(404).json({ error: 'Run not found' }); return; }

  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId!) as { role: string } | undefined;
  if (user?.role !== 'admin' && run.user_id !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }
  if (!['running', 'abandoned'].includes(run.status)) {
    res.status(400).json({ error: `Run is already ${run.status}` }); return;
  }
  cancelRun(run.id);
  res.json({ id: run.id, status: 'cancelled' });
});

// GET /runs/:id/export — signed audit export (aiorc.audit.v1): the full
// hash-chained event log, the manifest of frozen entities, every accepted
// output and the review binding, signed with Ed25519. Verify it with
// POST /audit/verify or offline with npm run audit:verify.
router.get('/:id/export', requireAuth, (req: AuthRequest, res: Response): void => {
  const run = db.prepare('SELECT r.id, p.user_id FROM runs r JOIN projects p ON p.id = r.project_id WHERE r.id = ?')
    .get(req.params['id']) as { id: string; user_id: string } | undefined;
  if (!run) { res.status(404).json({ error: 'Run not found' }); return; }
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId!) as { role: string } | undefined;
  if (user?.role !== 'admin' && run.user_id !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

  const signed = buildSignedExport(run.id)!;
  res.setHeader('Content-Disposition', `attachment; filename="aiorc-audit-${run.id.slice(0, 8)}.json"`);
  res.json(signed);
});

export default router;
