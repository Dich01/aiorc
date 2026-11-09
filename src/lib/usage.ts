import { v4 as uuidv4 } from 'uuid';
import db from '../db/client';

// ── Agent usage telemetry ────────────────────────────────────────────────────
//
// Records two views of every run:
//   planned  — agents the compiled flow told the LLM to use (written at compile time)
//   reported — agents the LLM says it actually invoked (written when workflow.report arrives)
// The /analytics endpoint joins both to answer "which agents are actually used"
// and "which agents get skipped despite being in the flow".

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

// Server-verified dispatch (stepped mode): the engine itself sent this agent's
// instructions to the LLM, so the row is ground truth. Repeated dispatches of
// the same agent within a run increment the invocation count.
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

export function recordReportedUsage(
  runId: string,
  projectId: string,
  report: unknown,
  createdAt: number = Date.now()
): void {
  // Server-verified rows beat self-declaration: if the engine already recorded
  // executed rows for this run, the LLM's own account is redundant (and could
  // disagree) — keep only the ground truth.
  const hasExecuted = db.prepare(
    `SELECT 1 FROM agent_usage WHERE run_id = ? AND source = 'executed' LIMIT 1`
  ).get(runId);
  if (hasExecuted) return;

  const counts = extractReportedInvocations(report);
  if (counts.size === 0) return;

  // Resolve agent ids via this run's planned rows (exact name match);
  // names the report invents stay with agent_id = NULL but are still counted.
  const planned = db.prepare(
    `SELECT agent_id, agent_name FROM agent_usage WHERE run_id = ? AND source = 'planned'`
  ).all(runId) as { agent_id: string | null; agent_name: string }[];
  const idByName = new Map(planned.map(p => [p.agent_name, p.agent_id]));

  const tx = db.transaction(() => {
    for (const [name, invocations] of counts) {
      insertUsage.run(uuidv4(), runId, projectId, idByName.get(name) ?? null, name, 'reported', invocations, createdAt);
    }
  });
  tx();
}
