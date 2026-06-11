import { Router, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import db from '../db/client';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { sweepAbandonedRuns } from './runs';

const router = Router();

function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId!) as { role: string } | undefined;
  if (user?.role !== 'admin') { res.status(403).json({ error: 'Admin only' }); return; }
  next();
}

const count = (sql: string, ...args: unknown[]): number =>
  (db.prepare(sql).get(...args) as { n: number }).n;

// GET /admin/overview — platform-wide KPIs, adoption funnel, per-user activity,
// top projects, community and system health. Everything an operator needs to
// answer "is this app being used, by whom, and is it healthy?".
router.get('/overview', requireAuth, requireAdmin, (_req: AuthRequest, res: Response): void => {
  sweepAbandonedRuns();
  const now = Date.now();
  const d1 = now - 86_400_000;
  const d7 = now - 7 * 86_400_000;
  const d30 = now - 30 * 86_400_000;

  // ── Core KPIs ──────────────────────────────────────────────────────────────
  const usersTotal = count('SELECT COUNT(*) n FROM users');
  const usersNew7d = count('SELECT COUNT(*) n FROM users WHERE created_at >= ?', d7);
  // Active = owns a project with runs in window, or logged in within it.
  const usersActive7d = count(
    `SELECT COUNT(DISTINCT u.id) n FROM users u
     WHERE EXISTS (SELECT 1 FROM projects p JOIN runs r ON r.project_id = p.id WHERE p.user_id = u.id AND r.created_at >= ?)
        OR (u.last_login IS NOT NULL AND u.last_login >= ?)`, d7, d7);

  const projectsTotal = count('SELECT COUNT(*) n FROM projects');
  const projectsPublic = count('SELECT COUNT(*) n FROM projects WHERE is_public = 1');
  const projectsWithFlow = count(
    `SELECT COUNT(*) n FROM project_flows WHERE flow_json != '' AND flow_json != '{"nodes":[],"edges":[]}'`);
  const projectsActive7d = count(
    'SELECT COUNT(DISTINCT project_id) n FROM runs WHERE created_at >= ?', d7);

  const runsTotal = count('SELECT COUNT(*) n FROM runs');
  const runs24h = count('SELECT COUNT(*) n FROM runs WHERE created_at >= ?', d1);
  const runs7d = count('SELECT COUNT(*) n FROM runs WHERE created_at >= ?', d7);
  const runsAudited = count(`SELECT COUNT(*) n FROM runs WHERE (execution_report != '' OR engine_state != '') AND status NOT IN ('cancelled','abandoned')`);
  const runsVerified = count(`SELECT COUNT(*) n FROM runs WHERE mode = 'stepped' AND status NOT IN ('cancelled','abandoned')`);
  const invocationsTotal = (db.prepare(
    `SELECT COALESCE(SUM(invocations), 0) s FROM agent_usage WHERE source != 'planned'`
  ).get() as { s: number }).s;

  const evalCases = count('SELECT COUNT(*) n FROM eval_cases');
  const evalGraded = count(`SELECT COUNT(*) n FROM runs WHERE eval_verdict != ''`);
  const evalPasses = count(`SELECT COUNT(*) n FROM runs WHERE eval_verdict = 'pass'`);

  // ── Community ──────────────────────────────────────────────────────────────
  const starsTotal =
    count('SELECT COUNT(*) n FROM project_stars') + count('SELECT COUNT(*) n FROM agent_stars') +
    count('SELECT COUNT(*) n FROM skill_stars') + count('SELECT COUNT(*) n FROM context_stars');
  const forksTotal =
    count('SELECT COUNT(*) n FROM projects WHERE forked_from IS NOT NULL') +
    count('SELECT COUNT(*) n FROM agents WHERE forked_from IS NOT NULL') +
    count('SELECT COUNT(*) n FROM skills WHERE forked_from IS NOT NULL') +
    count('SELECT COUNT(*) n FROM contexts WHERE forked_from IS NOT NULL');
  const invitationsSent =
    count('SELECT COUNT(*) n FROM project_invitations') + count('SELECT COUNT(*) n FROM agent_invitations') +
    count('SELECT COUNT(*) n FROM skill_invitations') + count('SELECT COUNT(*) n FROM context_invitations');
  const invitationsAccepted =
    count(`SELECT COUNT(*) n FROM project_invitations WHERE status = 'accepted'`) +
    count(`SELECT COUNT(*) n FROM agent_invitations WHERE status = 'accepted'`) +
    count(`SELECT COUNT(*) n FROM skill_invitations WHERE status = 'accepted'`) +
    count(`SELECT COUNT(*) n FROM context_invitations WHERE status = 'accepted'`);
  const issuesOpen = count(`SELECT COUNT(*) n FROM issues WHERE status = 'open'`);
  const issuesClosed = count(`SELECT COUNT(*) n FROM issues WHERE status = 'closed'`);

  // ── Adoption funnel ────────────────────────────────────────────────────────
  const usersWithProject = count('SELECT COUNT(DISTINCT user_id) n FROM projects');
  const usersWithFlow = count(
    `SELECT COUNT(DISTINCT p.user_id) n FROM projects p
     JOIN project_flows f ON f.project_id = p.id
     WHERE f.flow_json != '' AND f.flow_json != '{"nodes":[],"edges":[]}'`);
  const usersWithRuns = count(
    'SELECT COUNT(DISTINCT p.user_id) n FROM projects p JOIN runs r ON r.project_id = p.id');
  const usersWithAudited = count(
    `SELECT COUNT(DISTINCT p.user_id) n FROM projects p JOIN runs r ON r.project_id = p.id
     WHERE r.execution_report != '' OR r.engine_state != ''`);
  const usersWithEvals = count(
    'SELECT COUNT(DISTINCT p.user_id) n FROM projects p JOIN eval_cases c ON c.project_id = p.id');

  const funnel = [
    { label: 'Registered', value: usersTotal },
    { label: 'Created a project', value: usersWithProject },
    { label: 'Designed a flow', value: usersWithFlow },
    { label: 'Ran a workflow', value: usersWithRuns },
    { label: 'Audited runs', value: usersWithAudited },
    { label: 'Defined evals', value: usersWithEvals },
  ];

  // ── Per-user activity ──────────────────────────────────────────────────────
  const users = db.prepare(
    `SELECT u.id, u.email, u.nickname, u.role, u.created_at, u.last_login,
            (SELECT COUNT(*) FROM projects p WHERE p.user_id = u.id) AS projects,
            (SELECT COUNT(*) FROM agents a WHERE a.user_id = u.id) AS agents,
            (SELECT COUNT(*) FROM skills s WHERE s.user_id = u.id) AS skills,
            (SELECT COUNT(*) FROM runs r JOIN projects p ON p.id = r.project_id WHERE p.user_id = u.id) AS runs,
            (SELECT COUNT(*) FROM runs r JOIN projects p ON p.id = r.project_id WHERE p.user_id = u.id AND r.created_at >= ?) AS runs_7d,
            (SELECT COALESCE(SUM(au.invocations), 0) FROM agent_usage au
               JOIN projects p ON p.id = au.project_id
               WHERE p.user_id = u.id AND au.source != 'planned') AS invocations,
            (SELECT MAX(r.created_at) FROM runs r JOIN projects p ON p.id = r.project_id WHERE p.user_id = u.id) AS last_run_at
     FROM users u ORDER BY runs DESC, u.created_at ASC`
  ).all(d7);

  // ── Top projects ───────────────────────────────────────────────────────────
  const topProjects = db.prepare(
    `SELECT p.id, p.name, p.is_public, p.paused, ow.nickname AS owner,
            COUNT(r.id) AS runs,
            SUM(CASE WHEN r.mode = 'stepped' AND r.status NOT IN ('cancelled','abandoned') THEN 1 ELSE 0 END) AS verified,
            SUM(CASE WHEN (r.execution_report != '' OR r.engine_state != '') AND r.status NOT IN ('cancelled','abandoned') THEN 1 ELSE 0 END) AS audited,
            MAX(r.created_at) AS last_run_at
     FROM projects p
     JOIN users ow ON ow.id = p.user_id
     LEFT JOIN runs r ON r.project_id = p.id
     GROUP BY p.id ORDER BY runs DESC, p.created_at DESC LIMIT 10`
  ).all();

  // ── Signups per week (last 12 weeks) ──────────────────────────────────────
  const WEEK = 7 * 86_400_000;
  const signupRows = db.prepare(
    `SELECT (created_at / ${WEEK}) * ${WEEK} AS wk, COUNT(*) AS n
     FROM users WHERE created_at >= ? GROUP BY wk ORDER BY wk ASC`
  ).all(now - 12 * WEEK) as { wk: number; n: number }[];
  const signupMap = new Map(signupRows.map(r => [r.wk, r.n]));
  const lastWk = Math.floor(now / WEEK) * WEEK;
  const signups: { label: string; value: number }[] = [];
  for (let i = 11; i >= 0; i--) {
    const wk = lastWk - i * WEEK;
    const d = new Date(wk);
    signups.push({
      label: `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      value: signupMap.get(wk) ?? 0,
    });
  }

  // ── System health ─────────────────────────────────────────────────────────
  let dbSize = 0;
  try { dbSize = fs.statSync(path.join(process.cwd(), 'data', 'aiorc.db')).size; } catch { /* fine */ }

  res.json({
    kpis: {
      users_total: usersTotal,
      users_new_7d: usersNew7d,
      users_active_7d: usersActive7d,
      projects_total: projectsTotal,
      projects_public: projectsPublic,
      projects_with_flow: projectsWithFlow,
      projects_active_7d: projectsActive7d,
      agents_total: count('SELECT COUNT(*) n FROM agents'),
      skills_total: count('SELECT COUNT(*) n FROM skills'),
      contexts_total: count('SELECT COUNT(*) n FROM contexts'),
      runs_total: runsTotal,
      runs_24h: runs24h,
      runs_7d: runs7d,
      invocations_total: invocationsTotal,
      audited_rate: runsTotal > 0 ? Math.round((runsAudited / runsTotal) * 100) : 0,
      verified_rate: runsTotal > 0 ? Math.round((runsVerified / runsTotal) * 100) : 0,
      eval_cases: evalCases,
      eval_graded: evalGraded,
      eval_pass_rate: evalGraded > 0 ? Math.round((evalPasses / evalGraded) * 100) : null,
      stars_total: starsTotal,
      forks_total: forksTotal,
      invitations_sent: invitationsSent,
      invitations_accept_rate: invitationsSent > 0 ? Math.round((invitationsAccepted / invitationsSent) * 100) : null,
      issues_open: issuesOpen,
      issues_closed: issuesClosed,
    },
    funnel,
    users,
    top_projects: topProjects,
    signups,
    system: {
      db_size_bytes: dbSize,
      runs_rows: runsTotal,
      usage_rows: count('SELECT COUNT(*) n FROM agent_usage'),
      uptime_s: Math.round(process.uptime()),
      node_version: process.version,
    },
  });
});

export default router;
