import { Router, Response } from 'express';
import db from '../db/client';
import { requireProjectKey, ProjectKeyRequest } from '../middleware/projectKey';
import { buildSignedExport } from '../lib/auditBuild';

// REST endpoints for runners (CI jobs, git hooks), authenticated like /mcp:
// the project key, or x-project-id plus a member's personal token.
const router = Router();

router.use(requireProjectKey, (req: ProjectKeyRequest, res: Response, next) => {
  if (req.projectAuth !== 'key') { res.status(401).json({ error: 'The project key, or a personal token with x-project-id (a member, or any user on a public project), is required' }); return; }
  next();
});

// GET /api/runs?head_sha=<sha>&since=<ms> — the project's runs for one commit,
// newest first. Lets a runner find the run it just drove without trusting
// whatever run id the model printed.
router.get('/runs', (req: ProjectKeyRequest, res: Response): void => {
  const headSha = typeof req.query['head_sha'] === 'string' ? req.query['head_sha'] : '';
  const since = Number(req.query['since'] ?? 0) || 0;
  if (!/^[0-9a-f]{40}$/.test(headSha)) { res.status(400).json({ error: 'head_sha (40 hex chars) is required' }); return; }
  // Someone running a public project they are not a member of sees only the
  // runs they started (other callers' runs and identities stay private).
  const own = req.authVia === 'public_token';
  const rows = db.prepare(
    `SELECT id, status, outcome, created_at FROM runs
     WHERE project_id = ? AND created_at >= ? AND json_extract(input, '$.head_sha') = ?
     ${own ? 'AND caller_user_id = ?' : ''}
     ORDER BY created_at DESC LIMIT 20`
  ).all(req.project!.id, since, headSha, ...(own ? [req.caller!.userId] : []));
  res.json({ runs: rows });
});

// GET /api/runs/:id/export — the signed audit export (same as /runs/:id/export).
router.get('/runs/:id/export', (req: ProjectKeyRequest, res: Response): void => {
  const run = db.prepare('SELECT id, caller_user_id FROM runs WHERE id = ? AND project_id = ?').get(req.params['id'], req.project!.id) as { id: string; caller_user_id: string } | undefined;
  if (!run || (req.authVia === 'public_token' && run.caller_user_id !== req.caller!.userId)) {
    res.status(404).json({ error: 'Run not found in this project' }); return;
  }
  res.json(buildSignedExport(run.id));
});

export default router;
