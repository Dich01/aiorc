import { v4 as uuidv4 } from 'uuid';
import db from '../db/client';

// ── Agent usage telemetry ────────────────────────────────────────────────────
//
// Records two views of every run:
//   planned  — agents in the run's flow (written at workflow.start)
//   executed — agents that completed a step (written when their output is accepted)
// The /analytics endpoint joins both to show which agents are actually used.

const insertUsage = db.prepare(
  `INSERT OR IGNORE INTO agent_usage (id, run_id, project_id, agent_id, agent_name, source, invocations, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);

export function recordPlannedUsage(
  runId: string,
  projectId: string,
  agents: { id: string; name: string }[],
  createdAt: number = Date.now()
): void {
  const tx = db.transaction(() => {
    for (const a of agents) {
      insertUsage.run(uuidv4(), runId, projectId, a.id, a.name, 'planned', 1, createdAt);
    }
  });
  tx();
}

// A completed step: the server accepted an output for this agent that
// validates against its schema. Repeated completions within a run increment
// the invocation count. Dispatch alone is never recorded as execution.
const upsertExecuted = db.prepare(
  `INSERT INTO agent_usage (id, run_id, project_id, agent_id, agent_name, source, invocations, created_at)
   VALUES (?, ?, ?, ?, ?, 'executed', 1, ?)
   ON CONFLICT (run_id, agent_name, source) DO UPDATE SET invocations = invocations + 1, created_at = excluded.created_at`
);

export function recordExecutedUsage(
  runId: string,
  projectId: string,
  agent: { id: string | null; name: string },
  createdAt: number = Date.now()
): void {
  upsertExecuted.run(uuidv4(), runId, projectId, agent.id, agent.name, createdAt);
}

// ── Self-declared usage (compiled / model-orchestrated mode) ──────────────────────────────
// Extracts { name → invocation count } from a free-form execution report.
// Recognizes the shapes the compiled prompt asks for:
//   report.invocations_per_agent: { "name": n }   (authoritative when present)
//   report.path: ["name", "name", ...]            (fallback — count occurrences)
export function extractReportedInvocations(report: unknown): Map<string, number> {
  const counts = new Map<string, number>();
  if (!report || typeof report !== 'object') return counts;
  const r = report as Record<string, unknown>;

  const perAgent = r['invocations_per_agent'];
  if (perAgent && typeof perAgent === 'object' && !Array.isArray(perAgent)) {
    for (const [name, n] of Object.entries(perAgent as Record<string, unknown>)) {
      const count = typeof n === 'number' && isFinite(n) && n > 0 ? Math.floor(n) : 1;
      if (name.trim()) counts.set(name.trim(), count);
    }
    if (counts.size > 0) return counts;
  }

  const path = r['path'];
  if (Array.isArray(path)) {
    for (const step of path) {
      const name = typeof step === 'string' ? step.trim() : '';
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return counts;
}

// Record a compiled run's self-declared usage as source 'reported'. Counts are
// clamped to what the flow allows (`maxByName`: the sum of the caps of every
// node that uses that agent) so a report cannot inflate usage past the graph.
// Names the report invents are kept with agent_id NULL (capped at 1).
// Verified rows beat self-declaration: nothing is written if the run already
// has 'executed' rows.
export function recordReportedUsage(
  runId: string,
  projectId: string,
  report: unknown,
  maxByName: Map<string, number>,
  createdAt: number = Date.now()
): void {
  const hasExecuted = db.prepare(`SELECT 1 FROM agent_usage WHERE run_id = ? AND source = 'executed' LIMIT 1`).get(runId);
  if (hasExecuted) return;
  const counts = extractReportedInvocations(report);
  if (counts.size === 0) return;
  const planned = db.prepare(`SELECT agent_id, agent_name FROM agent_usage WHERE run_id = ? AND source = 'planned'`)
    .all(runId) as { agent_id: string | null; agent_name: string }[];
  const idByName = new Map(planned.map(p => [p.agent_name, p.agent_id]));
  for (const [name, n] of counts) {
    insertUsage.run(uuidv4(), runId, projectId, idByName.get(name) ?? null, name, 'reported', Math.min(n, maxByName.get(name) ?? 1), createdAt);
  }
}
