import db from '../db/client';
import { canonicalJson, sha256 } from './canonicalJson';
import { loadEvents, checkChain } from './runEvents';
import { EvalRunFacts } from './evalGrading';

// Rebuild the facts an eval is graded on from the run's event chain. Outputs
// are read from run_step_outputs and accepted only if their hash is the one
// the chain recorded, so a row edited after the fact cannot pass an eval.
export function factsFromEvents(runId: string): { facts: EvalRunFacts; problems: string[] } {
  const events = loadEvents(runId);
  const problems = checkChain(runId, events);
  const agentByNode = new Map<string, string>();
  const completedAgents = new Set<string>();
  let status: EvalRunFacts['status'] = 'active';
  let outcome = '';
  let lastCompleted: { step: number; outputs: { node: string; sha256: string }[] } | null = null;

  for (const e of events) {
    const p = e.payload as Record<string, any>;
    if (e.type === 'step.dispatched') for (const n of p.nodes ?? []) agentByNode.set(`${p.step}:${n.node}`, n.agent);
    if (e.type === 'step.completed') {
      lastCompleted = { step: p.step, outputs: p.outputs ?? [] };
      for (const o of p.outputs ?? []) { const a = agentByNode.get(`${p.step}:${o.node}`); if (a) completedAgents.add(a); }
    }
    if (e.type === 'run.completed') { status = 'completed'; outcome = String(p.outcome ?? ''); }
    if (e.type === 'run.capped') { status = 'capped'; outcome = String(p.outcome ?? ''); }
    if (e.type === 'run.cancelled') status = 'cancelled';
    if (e.type === 'run.failed') { status = 'failed'; outcome = String(p.reason ?? ''); }
  }

  const findings: unknown[] = [];
  if (lastCompleted) {
    for (const o of lastCompleted.outputs) {
      const row = db.prepare('SELECT output_json FROM run_step_outputs WHERE run_id = ? AND step = ? AND node_id = ?').get(runId, lastCompleted.step, o.node) as { output_json: string } | undefined;
      if (!row) { problems.push(`output of step ${lastCompleted.step} (${o.node}) is missing`); continue; }
      const output = JSON.parse(row.output_json);
      if (sha256(canonicalJson(output)) !== o.sha256) { problems.push(`output of step ${lastCompleted.step} (${o.node}) does not match the chain`); continue; }
      if (output && Array.isArray(output.findings)) findings.push(...output.findings);
    }
  }
  return { facts: { status, outcome, completedAgents, findings }, problems };
}
