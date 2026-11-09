// ── Control plane primitives — pure, unit-tested ────────────────────────────
//
// Pause semantics are SURGICAL by design:
//   - Pausing a project blocks NEW runs only. Anyone mid-execution finishes
//     their run undisturbed — a pause never yanks the rug from a teammate.
//   - To stop a specific in-flight run there is per-run cancel, which affects
//     that run and nothing else.

export interface ExecutionGate {
  allowed: boolean;
  reason: string;
}

export function gateExecution(opts: {
  action: 'start' | 'step';
  projectPaused: boolean;
  runStatus: string | null;   // 'running' | 'completed' | 'cancelled' | null (no run yet)
}): ExecutionGate {
  if (opts.runStatus === 'cancelled') {
    return { allowed: false, reason: 'This run was cancelled by its owner or an admin. No further steps will execute. Stop here and tell the user the run was cancelled.' };
  }
  if (opts.action === 'start' && opts.projectPaused) {
    return { allowed: false, reason: 'This project is paused by its owner, so no new runs are accepted. Runs already in flight can finish. Tell the user the project is paused instead of retrying.' };
  }
  return { allowed: true, reason: '' };
}

// A stepped run with no activity for longer than the threshold is considered
// abandoned (the LLM went away — MCP has no heartbeat). Abandoned is SOFT:
// if the client comes back with workflow.next, the run resumes.
export const ABANDON_THRESHOLD_MS = 2 * 3600 * 1000;

export function isAbandoned(lastActivityAt: number, now: number, thresholdMs: number = ABANDON_THRESHOLD_MS): boolean {
  return now - lastActivityAt > thresholdMs;
}
