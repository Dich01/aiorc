import { Router, Response } from 'express';
import db from '../db/client';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { classifySkips } from '../lib/skipAnalysis';
import { extractReportedInvocations } from '../lib/usage';
import { FlowDocument } from '../db/schema';

const router = Router();

interface UsageRow {
  run_id: string;
  project_id: string;
  agent_id: string | null;
  agent_name: string;
  source: 'planned' | 'reported';
  invocations: number;
  created_at: number;
  has_report: number;
  project_name: string;
  owner_id: string;
  owner_nickname: string;
  caller_email: string;
}

// GET /analytics — agent usage aggregated across the current user's projects
// (admin sees all). Query params:
//   ?project_id=<id>   limit to one project
//   ?period=7|30|90    limit to the last N days (default: all)
// Answers what the registry alone can't:
//   1. Which agents are actually used (vs. registered noise)?
//   2. Which agents does the LLM skip even though the flow plans them?
//   3. Who is using them? (attribution = owner of the project the run came in through;
//      MCP calls authenticate with a project key, not a personal token)
router.get('/', requireAuth, (req: AuthRequest, res: Response): void => {
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId!) as { role: string } | undefined;
  const isAdmin = user?.role === 'admin';

  const projectId = typeof req.query['project_id'] === 'string' ? req.query['project_id'].trim() : '';
  const periodDays = Number(req.query['period']);
  const since = isFinite(periodDays) && periodDays > 0 ? Date.now() - periodDays * 86400_000 : 0;

  const where: string[] = [];
  const args: unknown[] = [];
  if (!isAdmin) { where.push('p.user_id = ?'); args.push(req.userId!); }
  if (projectId) { where.push('p.id = ?'); args.push(projectId); }
  if (since) { where.push('r.created_at >= ?'); args.push(since); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  // A run is auditable when it has a self-declared report OR was driven by the
  // stepped engine (engine_state) — the latter is server-verified ground truth.
  const rows = db.prepare(
    `SELECT u.run_id, u.project_id, u.agent_id, u.agent_name, u.source, u.invocations, u.created_at,
            CASE WHEN r.execution_report != '' OR r.engine_state != '' THEN 1 ELSE 0 END AS has_report,
            p.name AS project_name, p.user_id AS owner_id, ow.nickname AS owner_nickname,
            r.caller_email
     FROM agent_usage u
     JOIN runs r ON r.id = u.run_id
     JOIN projects p ON p.id = u.project_id
     JOIN users ow ON ow.id = p.user_id
     ${whereSql}`
  ).all(...args) as UsageRow[];

  // Per-run skip classification: replay each report against the flow graph the
  // run was compiled from. Only agents the taken path REQUIRED count as skips;
  // branches legitimately not taken are off-path.
  const reportedRuns = db.prepare(
    `SELECT r.id, r.project_id, r.flow_json, r.execution_report, r.engine_state
     FROM runs r JOIN projects p ON p.id = r.project_id
     ${whereSql ? whereSql + ' AND' : 'WHERE'} (r.execution_report != '' OR r.engine_state != '')`
  ).all(...args) as { id: string; project_id: string; flow_json: string; execution_report: string; engine_state: string }[];

  const currentFlowStmt = db.prepare('SELECT flow_json FROM project_flows WHERE project_id = ?');
  const plannedNamesByRun = new Map<string, Set<string>>();
  const executedNamesByRun = new Map<string, Set<string>>();
  for (const row of rows) {
    const target = row.source === 'planned' ? plannedNamesByRun : executedNamesByRun;
    let set = target.get(row.run_id);
    if (!set) { set = new Set(); target.set(row.run_id, set); }
    set.add(row.agent_name);
  }

  const realSkipsByRun = new Map<string, Set<string>>();
  for (const run of reportedRuns) {
    let flow: FlowDocument | null = null;
    try {
      // Prefer the compile-time snapshot; older runs fall back to the current flow.
      const raw = run.flow_json || (currentFlowStmt.get(run.project_id) as { flow_json: string } | undefined)?.flow_json || '';
      if (raw) flow = JSON.parse(raw) as FlowDocument;
    } catch { /* unparseable flow — treat all non-executed as off-path */ }

    const planned = plannedNamesByRun.get(run.id) ?? new Set<string>();
    let executed = executedNamesByRun.get(run.id) ?? new Set<string>();
    let orderedPath: string[] = [];
    if (run.engine_state) {
      // Stepped run: the engine's own path is the authoritative order.
      try {
        const engine = JSON.parse(run.engine_state) as { path?: { agent?: string }[] };
        orderedPath = (engine.path ?? []).map(s => s.agent ?? '').filter(Boolean);
      } catch { /* fall through to report */ }
    }
    try {
      const report = JSON.parse(run.execution_report);
      const fromReport = extractReportedInvocations(report);
      if (fromReport.size > 0) executed = new Set([...executed, ...fromReport.keys()]);
      if (orderedPath.length === 0 && Array.isArray(report?.path)) {
        orderedPath = report.path.filter((s: unknown) => typeof s === 'string');
      }
    } catch { /* keep usage-row data */ }

    realSkipsByRun.set(
      run.id,
      flow ? classifySkips(flow, planned, executed, orderedPath).realSkips : new Set()
    );
  }

  const runStats = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN r.execution_report != '' OR r.engine_state != '' THEN 1 ELSE 0 END) AS with_report,
            SUM(CASE WHEN r.mode = 'stepped' THEN 1 ELSE 0 END) AS verified
     FROM runs r JOIN projects p ON p.id = r.project_id ${whereSql}`
  ).get(...args) as { total: number; with_report: number | null; verified: number | null };

  const registeredAgents = db.prepare(
    isAdmin
      ? 'SELECT id, name, description FROM agents'
      : 'SELECT id, name, description FROM agents WHERE user_id = ?'
  ).all(...(isAdmin ? [] : [req.userId!])) as { id: string; name: string; description: string }[];

  // Group usage by agent. Rows matched to a registered agent group by id;
  // unmatched reported names group by name so they still show up.
  interface AgentAgg {
    agent_id: string | null;
    agent_name: string;
    runs_planned: number;
    runs_executed: number;        // distinct runs where the report names this agent
    invocations: number;          // total reported invocations (loops/retries included)
    planned_in_reported_runs: number;
    skipped: number;              // required by the taken path but never executed (real skips)
    off_path: number;             // planned but the taken branch legitimately excluded it
    last_used: number;
    projects: Set<string>;
    users: Map<string, number>;   // caller email (or project owner) → reported invocations
  }
  const byAgent = new Map<string, AgentAgg>();
  const runsSeen = new Map<string, { planned: Set<string>; reported: Set<string> }>();

  const keyOf = (r: { agent_id: string | null; agent_name: string }) => r.agent_id ?? `name:${r.agent_name}`;

  for (const row of rows) {
    const key = keyOf(row);
    let agg = byAgent.get(key);
    if (!agg) {
      agg = {
        agent_id: row.agent_id, agent_name: row.agent_name,
        runs_planned: 0, runs_executed: 0, invocations: 0,
        planned_in_reported_runs: 0, skipped: 0, off_path: 0, last_used: 0,
        projects: new Set(), users: new Map(),
      };
      byAgent.set(key, agg);
    }
    agg.projects.add(row.project_name);
    agg.last_used = Math.max(agg.last_used, row.created_at);

    if (row.source === 'planned') {
      agg.runs_planned += 1;
      if (row.has_report) agg.planned_in_reported_runs += 1;
    } else {
      agg.runs_executed += 1;
      agg.invocations += row.invocations;
      const who = row.caller_email || row.owner_nickname || row.owner_id;
      agg.users.set(who, (agg.users.get(who) ?? 0) + row.invocations);
    }

    let run = runsSeen.get(row.run_id);
    if (!run) { run = { planned: new Set(), reported: new Set() }; runsSeen.set(row.run_id, run); }
    (row.source === 'planned' ? run.planned : run.reported).add(key);
  }

  // Per run with a report, a planned agent that didn't execute is either a
  // real skip (the taken path required it — see skipAnalysis) or off-path
  // (its branch wasn't taken; that's correct routing, not a skip).
  for (const row of rows) {
    if (row.source !== 'planned' || !row.has_report) continue;
    const run = runsSeen.get(row.run_id)!;
    if (run.reported.has(keyOf(row))) continue;
    const agg = byAgent.get(keyOf(row))!;
    if (realSkipsByRun.get(row.run_id)?.has(row.agent_name)) agg.skipped += 1;
    else agg.off_path += 1;
  }

  const agents = [...byAgent.values()]
    .map(a => ({
      agent_id: a.agent_id,
      agent_name: a.agent_name,
      runs_planned: a.runs_planned,
      runs_executed: a.runs_executed,
      invocations: a.invocations,
      skipped: a.skipped,
      off_path: a.off_path,
      // Compliance only over runs where the taken path required the agent:
      // executed / (executed + real skips). Off-path runs don't count against it.
      compliance: (a.planned_in_reported_runs - a.off_path) > 0
        ? Math.round(((a.planned_in_reported_runs - a.off_path - a.skipped) / (a.planned_in_reported_runs - a.off_path)) * 100)
        : null,
      last_used: a.last_used,
      projects: [...a.projects],
      users: [...a.users.entries()].map(([nickname, invocations]) => ({ nickname, invocations }))
        .sort((x, y) => y.invocations - x.invocations),
      registered: a.agent_id !== null,
    }))
    .sort((x, y) => (y.invocations - x.invocations) || (y.runs_planned - x.runs_planned));

  // "Never executed" = registered agents with zero reported invocations in scope.
  // Two flavors: never part of any compiled flow at all, vs. planned in flows
  // but never actually invoked by the LLM (the suspicious ones).
  const plannedIds = new Set([...byAgent.values()].filter(a => a.runs_planned > 0).map(a => a.agent_id).filter(Boolean));
  const executedIds = new Set([...byAgent.values()].filter(a => a.runs_executed > 0).map(a => a.agent_id).filter(Boolean));
  const neverExecuted = registeredAgents
    .filter(a => !executedIds.has(a.id))
    .map(a => ({
      agent_id: a.id,
      agent_name: a.name,
      description: a.description,
      in_flows: plannedIds.has(a.id),  // true → planned but never invoked
    }))
    .sort((x, y) => Number(y.in_flows) - Number(x.in_flows));

  // Usage by user — who actually consumes the agents. Attribution prefers the
  // caller's email (x-user-email header, set per person via AIORC_USER_EMAIL
  // in the MCP bridge); runs without it fall back to the project owner.
  interface UserAgg { nickname: string; runs: Set<string>; invocations: number; agents: Set<string>; last_used: number }
  const byUser = new Map<string, UserAgg>();
  for (const row of rows) {
    const nick = row.caller_email || row.owner_nickname || row.owner_id;
    let agg = byUser.get(nick);
    if (!agg) { agg = { nickname: nick, runs: new Set(), invocations: 0, agents: new Set(), last_used: 0 }; byUser.set(nick, agg); }
    agg.runs.add(row.run_id);
    agg.last_used = Math.max(agg.last_used, row.created_at);
    if (row.source === 'reported') {
      agg.invocations += row.invocations;
      agg.agents.add(keyOf(row));
    }
  }
  const users = [...byUser.values()]
    .map(u => ({ nickname: u.nickname, runs: u.runs.size, invocations: u.invocations, agents_used: u.agents.size, last_used: u.last_used }))
    .sort((x, y) => y.invocations - x.invocations);

  const recentRuns = db.prepare(
    `SELECT r.id, r.created_at, r.status, p.name AS project_name, ow.nickname AS owner_nickname,
            r.caller_email,
            CASE WHEN r.execution_report != '' OR r.engine_state != '' THEN 1 ELSE 0 END AS has_report,
            CASE WHEN r.mode = 'stepped' THEN 1 ELSE 0 END AS verified,
            (SELECT COUNT(*) FROM agent_usage u WHERE u.run_id = r.id AND u.source = 'planned') AS agents_planned,
            (SELECT COUNT(*) FROM agent_usage u WHERE u.run_id = r.id AND u.source != 'planned') AS agents_reported
     FROM runs r JOIN projects p ON p.id = r.project_id JOIN users ow ON ow.id = p.user_id
     ${whereSql}
     ORDER BY r.created_at DESC LIMIT 15`
  ).all(...args);

  const projects = db.prepare(
    isAdmin
      ? 'SELECT id, name FROM projects ORDER BY name ASC'
      : 'SELECT id, name FROM projects WHERE user_id = ? ORDER BY name ASC'
  ).all(...(isAdmin ? [] : [req.userId!]));

  // ── Daily time series for the usage chart ─────────────────────────────────
  const runsByDay = db.prepare(
    `SELECT date(r.created_at / 1000, 'unixepoch') AS day,
            COUNT(*) AS runs,
            SUM(CASE WHEN r.mode = 'stepped' THEN 1 ELSE 0 END) AS verified
     FROM runs r JOIN projects p ON p.id = r.project_id
     ${whereSql}
     GROUP BY day ORDER BY day ASC`
  ).all(...args) as { day: string; runs: number; verified: number }[];

  const invByDay = db.prepare(
    `SELECT date(u.created_at / 1000, 'unixepoch') AS day,
            SUM(u.invocations) AS invocations
     FROM agent_usage u
     JOIN runs r ON r.id = u.run_id
     JOIN projects p ON p.id = u.project_id
     ${whereSql ? whereSql + ' AND' : 'WHERE'} u.source != 'planned'
     GROUP BY day ORDER BY day ASC`
  ).all(...args) as { day: string; invocations: number }[];

  const invMap = new Map(invByDay.map(d => [d.day, d.invocations]));
  const runMap = new Map(runsByDay.map(d => [d.day, d]));
  const allDays = [...new Set([...runMap.keys(), ...invMap.keys()])].sort();
  const timeseries: { day: string; runs: number; verified: number; invocations: number }[] = [];
  if (allDays.length > 0) {
    // Continuous daily buckets (zero-filled) so the chart has no gaps.
    const cursor = new Date(allDays[0]! + 'T00:00:00Z');
    const last = new Date(allDays[allDays.length - 1]! + 'T00:00:00Z');
    while (cursor <= last && timeseries.length < 366) {
      const day = cursor.toISOString().slice(0, 10);
      const r = runMap.get(day);
      timeseries.push({ day, runs: r?.runs ?? 0, verified: r?.verified ?? 0, invocations: invMap.get(day) ?? 0 });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  // ── Per-entity tabs ────────────────────────────────────────────────────────
  const projectFilterJoin = projectId ? 'AND r.project_id = ?' : '';
  const sinceFilterRuns = since ? 'AND r.created_at >= ?' : '';
  const entityArgs = (ownerArgs: unknown[]) => {
    const a = [...ownerArgs];
    if (projectId) a.push(projectId);
    if (since) a.push(since);
    return a;
  };

  const projectsStats = db.prepare(
    `SELECT p.id, p.name,
            COUNT(r.id) AS runs,
            SUM(CASE WHEN r.execution_report != '' OR r.engine_state != '' THEN 1 ELSE 0 END) AS audited,
            SUM(CASE WHEN r.mode = 'stepped' THEN 1 ELSE 0 END) AS verified,
            MAX(r.created_at) AS last_run_at,
            (SELECT COUNT(*) FROM eval_cases c WHERE c.project_id = p.id) AS eval_cases
     FROM projects p
     LEFT JOIN runs r ON r.project_id = p.id ${since ? 'AND r.created_at >= ?' : ''}
     WHERE ${isAdmin ? '1=1' : 'p.user_id = ?'} ${projectId ? 'AND p.id = ?' : ''}
     GROUP BY p.id ORDER BY runs DESC, p.name ASC`
  ).all(...[...(since ? [since] : []), ...(isAdmin ? [] : [req.userId!]), ...(projectId ? [projectId] : [])]);

  const skillsStats = db.prepare(
    `SELECT s.id, s.name,
            COUNT(DISTINCT u.run_id) AS runs_executed,
            COALESCE(SUM(u.invocations), 0) AS invocations,
            COUNT(DISTINCT ask.agent_id) AS agents_carrying,
            MAX(u.created_at) AS last_used
     FROM skills s
     LEFT JOIN agent_skills ask ON ask.skill_id = s.id
     LEFT JOIN agent_usage u ON u.agent_id = ask.agent_id AND u.source != 'planned'
       ${projectId ? 'AND u.project_id = ?' : ''} ${since ? 'AND u.created_at >= ?' : ''}
     ${isAdmin ? '' : 'WHERE s.user_id = ?'}
     GROUP BY s.id ORDER BY invocations DESC, s.name ASC`
  ).all(...entityArgs([]).concat(isAdmin ? [] : [req.userId!]));

  const contextsStats = db.prepare(
    `SELECT c.id, c.name,
            COUNT(DISTINCT pc.project_id) AS projects_linked,
            COUNT(r.id) AS runs_included,
            MAX(r.created_at) AS last_used
     FROM contexts c
     LEFT JOIN project_contexts pc ON pc.context_id = c.id
     LEFT JOIN runs r ON r.project_id = pc.project_id
       ${projectFilterJoin} ${sinceFilterRuns}
     ${isAdmin ? '' : 'WHERE c.user_id = ?'}
     GROUP BY c.id ORDER BY runs_included DESC, c.name ASC`
  ).all(...entityArgs([]).concat(isAdmin ? [] : [req.userId!]));

  const totalRuns = runStats.total ?? 0;
  const runsWithReport = runStats.with_report ?? 0;

  res.json({
    summary: {
      total_runs: totalRuns,
      runs_with_report: runsWithReport,
      runs_verified: runStats.verified ?? 0,
      report_rate: totalRuns > 0 ? Math.round((runsWithReport / totalRuns) * 100) : 0,
      agents_registered: registeredAgents.length,
      agents_executed: executedIds.size,
      agents_never_executed: neverExecuted.length,
    },
    agents,
    never_executed: neverExecuted,
    users,
    recent_runs: recentRuns,
    projects,  // for the project filter select
    timeseries,
    projects_stats: projectsStats,
    skills_stats: skillsStats,
    contexts_stats: contextsStats,
  });
});

// GET /analytics/timeseries?range=1h|1d|1w|1m|3m|6m|all&project_id=&breakdown=
// Lightweight bucketed series for the live chart — polled every few seconds,
// so it stays separate from the heavy aggregation above. The bucket size
// scales with the range (1-minute buckets for the last hour, daily buckets
// for months) and the window always ends at the current bucket, so the right
// edge keeps moving like a live market chart.
router.get('/timeseries', requireAuth, (req: AuthRequest, res: Response): void => {
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId!) as { role: string } | undefined;
  const isAdmin = user?.role === 'admin';
  const projectId = typeof req.query['project_id'] === 'string' ? req.query['project_id'].trim() : '';

  const RANGES: Record<string, { bucket: number; count: number }> = {
    '1h': { bucket: 60_000, count: 60 },          // 60 × 1 min
    '1d': { bucket: 300_000, count: 288 },        // 288 × 5 min
    '1w': { bucket: 3_600_000, count: 168 },      // 168 × 1 h
    '1m': { bucket: 21_600_000, count: 120 },     // 120 × 6 h
    '3m': { bucket: 86_400_000, count: 90 },      // 90 × 1 day
    '6m': { bucket: 86_400_000, count: 180 },     // 180 × 1 day
    'all': { bucket: 86_400_000, count: 0 },      // daily, span computed below
  };
  const range = String(req.query['range'] ?? '1h');
  const cfg = { ...(RANGES[range] ?? RANGES['1h']!) };

  const now = Date.now();
  const scopeOwner: string[] = [];
  const scopeArgs: unknown[] = [];
  if (!isAdmin) { scopeOwner.push('p.user_id = ?'); scopeArgs.push(req.userId!); }
  if (projectId) { scopeOwner.push('p.id = ?'); scopeArgs.push(projectId); }

  if (range === 'all') {
    const first = db.prepare(
      `SELECT MIN(r.created_at) AS first FROM runs r JOIN projects p ON p.id = r.project_id
       ${scopeOwner.length ? 'WHERE ' + scopeOwner.join(' AND ') : ''}`
    ).get(...scopeArgs) as { first: number | null };
    const span = first.first ? Math.ceil((now - first.first) / cfg.bucket) + 1 : 30;
    cfg.count = Math.max(2, Math.min(365, span));
  }

  const lastBucket = Math.floor(now / cfg.bucket) * cfg.bucket;
  const sinceMs = lastBucket - (cfg.count - 1) * cfg.bucket;

  const where: string[] = ['r.created_at >= ?', ...scopeOwner];
  const args: unknown[] = [sinceMs, ...scopeArgs];
  const whereSql = 'WHERE ' + where.join(' AND ');

  // Integer bucketing (SQLite integer division) — uniform for any bucket size.
  const bucketOf = (col: string) => `(${col} / ${cfg.bucket}) * ${cfg.bucket}`;

  const bucketKeys: number[] = [];
  for (let i = cfg.count - 1; i >= 0; i--) bucketKeys.push(lastBucket - i * cfg.bucket);

  // Labels in server-local time (server and browser share the machine).
  const pad = (n: number) => String(n).padStart(2, '0');
  const labelOf = (ms: number): string => {
    const d = new Date(ms);
    if (cfg.bucket >= 86_400_000) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (cfg.bucket >= 3_600_000) return `${pad(d.getDate())}/${pad(d.getHours())}h`;
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const labels = bucketKeys.map(labelOf);

  // breakdown: '' (totals) | 'agents' | 'projects' | 'skills' | 'contexts'
  // Entity breakdowns return one line per entity (top 6 by activity in window).
  const breakdown = String(req.query['breakdown'] ?? '');

  if (breakdown === 'agents' || breakdown === 'projects' || breakdown === 'skills' || breakdown === 'contexts') {
    const queries: Record<string, string> = {
      agents: `SELECT ${bucketOf('u.created_at')} AS bucket, u.agent_name AS name, SUM(u.invocations) AS value
               FROM agent_usage u JOIN runs r ON r.id = u.run_id JOIN projects p ON p.id = u.project_id
               ${whereSql} AND u.source != 'planned' GROUP BY bucket, u.agent_name`,
      projects: `SELECT ${bucketOf('u.created_at')} AS bucket, p.name AS name, SUM(u.invocations) AS value
                 FROM agent_usage u JOIN runs r ON r.id = u.run_id JOIN projects p ON p.id = u.project_id
                 ${whereSql} AND u.source != 'planned' GROUP BY bucket, p.name`,
      skills: `SELECT ${bucketOf('u.created_at')} AS bucket, s.name AS name, SUM(u.invocations) AS value
               FROM agent_usage u
               JOIN agent_skills ask ON ask.agent_id = u.agent_id
               JOIN skills s ON s.id = ask.skill_id
               JOIN runs r ON r.id = u.run_id JOIN projects p ON p.id = u.project_id
               ${whereSql} AND u.source != 'planned' GROUP BY bucket, s.name`,
      contexts: `SELECT ${bucketOf('r.created_at')} AS bucket, c.name AS name, COUNT(*) AS value
                 FROM runs r
                 JOIN project_contexts pc ON pc.project_id = r.project_id
                 JOIN contexts c ON c.id = pc.context_id
                 JOIN projects p ON p.id = r.project_id
                 ${whereSql} GROUP BY bucket, c.name`,
    };
    const rows = db.prepare(queries[breakdown]!).all(...args) as { bucket: number; name: string; value: number }[];

    const totals = new Map<string, number>();
    for (const r of rows) totals.set(r.name, (totals.get(r.name) ?? 0) + r.value);
    const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name]) => name);

    const byEntity = new Map<string, Map<number, number>>(top.map(n => [n, new Map()]));
    for (const r of rows) byEntity.get(r.name)?.set(r.bucket, r.value);

    res.json({
      range, breakdown, labels,
      series: top.map(name => ({
        name,
        values: bucketKeys.map(k => byEntity.get(name)!.get(k) ?? 0),
      })),
    });
    return;
  }

  // Totals mode: invocations / runs / verified
  const runRows = db.prepare(
    `SELECT ${bucketOf('r.created_at')} AS bucket,
            COUNT(*) AS runs,
            SUM(CASE WHEN r.mode = 'stepped' THEN 1 ELSE 0 END) AS verified
     FROM runs r JOIN projects p ON p.id = r.project_id
     ${whereSql} GROUP BY bucket`
  ).all(...args) as { bucket: number; runs: number; verified: number }[];

  const invRows = db.prepare(
    `SELECT ${bucketOf('u.created_at')} AS bucket,
            SUM(u.invocations) AS invocations
     FROM agent_usage u JOIN runs r ON r.id = u.run_id JOIN projects p ON p.id = u.project_id
     ${whereSql} AND u.source != 'planned' GROUP BY bucket`
  ).all(...args) as { bucket: number; invocations: number }[];

  const runMap = new Map(runRows.map(r => [r.bucket, r]));
  const invMap = new Map(invRows.map(r => [r.bucket, r.invocations]));

  res.json({
    range, breakdown: '', labels,
    series: [
      { name: 'Invocations', values: bucketKeys.map(k => invMap.get(k) ?? 0), area: true },
      { name: 'Runs', values: bucketKeys.map(k => runMap.get(k)?.runs ?? 0) },
      { name: 'Verified runs', values: bucketKeys.map(k => runMap.get(k)?.verified ?? 0) },
    ],
  });
});

export default router;

