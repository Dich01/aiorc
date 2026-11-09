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
