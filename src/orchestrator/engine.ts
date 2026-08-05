import db from '../db/client';
import { Agent, EvalCase, FlowDocument, FlowNode } from '../db/schema';
import { gradeEval } from '../lib/evalGrading';
import { recordExecutedUsage, recordPlannedUsage } from '../lib/usage';
import {
  buildAgentBlock,
  normalizeFlow,
  renderContextsSection,
  renderSkillsSection,
  validateFlow,
} from './index';
import {
  EngineState,
  allowedEdges,
  capOf,
  chooseTransition,
  describeEdge,
  resolveDispatch,
} from './engineCore';
import { v4 as uuidv4 } from 'uuid';

// Outcome prefix used when a run is stopped by an invocation cap. Eval grading
// decides "clean completion" by testing for this prefix, so the text that is
// written and the text that is matched must never drift apart — that is the
// only reason it lives in a constant rather than inline.
export const CAP_OUTCOME_PREFIX = 'invocation cap reached';

// ── Stepped execution engine ─────────────────────────────────────────────────
//
// In compiled mode the whole workflow is delivered as one prompt and the LLM
// self-reports what it did. Here the SERVER drives the run instead:
//
//   workflow.start → engine dispatches the first agent(s), returns only their
//                    instructions plus the legal transitions out of them.
//   workflow.next  → the LLM hands back its output and the transition it wants;
//                    the engine validates it against the flow's edges, enforces
//                    per-agent invocation caps, records the dispatch as
//                    ground-truth usage, and returns the next agent.
//
// The LLM still interprets natural-language edge conditions (that's its job),
// but it can no longer skip agents, jump to illegal nodes, or exceed caps —
// every transition passes through the graph. Usage rows written here carry
// source='executed': verified by the server, not self-declared.

export { EngineState, PathStep, TransitionChoice } from './engineCore';

// ── DB-backed run lifecycle ──────────────────────────────────────────────────

export interface StepResult {
  runId: string;
  text: string;        // markdown delivered to the LLM
  done: boolean;
  error?: string;
}

interface RunRow { id: string; project_id: string; flow_json: string; engine_state: string; mode: string; eval_case_id: string }

// Grade a completed eval run against its case using server-verified facts.
// Returns a short verdict line to append to the LLM-facing text, '' otherwise.
function gradeIfEval(runId: string, evalCaseId: string, state: EngineState): string {
  if (!evalCaseId) return '';
  const evalCase = db.prepare('SELECT * FROM eval_cases WHERE id = ?').get(evalCaseId) as EvalCase | undefined;
  if (!evalCase) return '';

  const outcome = state.outcome ?? '';
  const cleanCompletion = state.status === 'completed' && !outcome.startsWith(CAP_OUTCOME_PREFIX);
  const verdict = gradeEval(
    { expected_outcome: evalCase.expected_outcome, must_run_agents: evalCase.must_run_agents },
    { completed: cleanCompletion, outcome, executedAgents: new Set(state.path.map(s => s.agent)) }
  );

  db.prepare('UPDATE runs SET eval_verdict = ?, eval_reasons = ? WHERE id = ?')
    .run(verdict.pass ? 'pass' : 'fail', verdict.pass ? '' : JSON.stringify(verdict.reasons), runId);

  return verdict.pass
    ? `\n\n**EVAL "${evalCase.name}": PASS** (graded by the server against the verified execution path).`
    : `\n\n**EVAL "${evalCase.name}": FAIL** — ${verdict.reasons.join('; ')}.`;
}

function loadAgents(flow: FlowDocument): Map<string, Agent> {
  const ids = [...new Set(flow.nodes.filter(n => n.type === 'agent' && n.agent_id).map(n => n.agent_id!))];
  const agents = ids.length > 0
    ? db.prepare(`SELECT * FROM agents WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Agent[]
    : [];
  return new Map(agents.map(a => [a.id, a]));
}

function dispatchText(
  flow: FlowDocument,
  nodes: FlowNode[],
  agentsById: Map<string, Agent>,
  runId: string,
  state: EngineState,
  lines: string[]
): void {
  if (nodes.length > 1) {
    lines.push(`## Execute these ${nodes.length} agents NOW, IN PARALLEL (fork — every branch is mandatory)`);
    lines.push('');
    lines.push('Launch one Agent tool per branch in a single response so they run concurrently. Wait for ALL of them to finish before calling `workflow.next`.');
  } else {
    lines.push(`## Execute this agent NOW`);
  }
  lines.push('');
  for (const node of nodes) {
    const agent = agentsById.get(node.agent_id!);
    if (!agent) continue;
    lines.push(buildAgentBlock(agent, capOf(node)));
    lines.push('');
  }
  const edges = allowedEdges(flow, state.current);
  lines.push('## When you are done');
  lines.push('');
  lines.push(`Call \`workflow.next\` with \`{"runId": "${runId}", "output": "<summary of the result>", "next": "<target, or the condition that matched>"}\`.`);
  if (edges.length > 0) {
    lines.push('Allowed transitions — pick exactly ONE based on the output. If no condition holds and there is no fallback, pass `"next": "none"`:');
    for (const e of edges) lines.push(`- ${describeEdge(flow, e)}`);
  } else {
    lines.push('This agent has no outgoing transitions. When you finish, call `workflow.next` with your output and the run will close.');
  }
  lines.push('');
  lines.push('Do NOT execute any other agent in the flow on your own. The server hands you each step.');
}

function persistState(runId: string, state: EngineState): void {
  db.prepare('UPDATE runs SET engine_state = ?, status = ?, last_activity_at = ? WHERE id = ?')
    .run(JSON.stringify(state), state.status === 'completed' ? 'completed' : 'running', Date.now(), runId);
}

// Dispatch the given nodes: cap-check, count, record verified usage.
// Returns false when a cap was exceeded (state flips to completed).
function dispatchNodes(
  runId: string,
  projectId: string,
  state: EngineState,
  nodes: FlowNode[],
  agentsById: Map<string, Agent>,
  via?: string
): { ok: boolean; capped?: FlowNode } {
  for (const node of nodes) {
    const count = (state.invocations[node.id] ?? 0) + 1;
    if (count > capOf(node)) {
      state.status = 'completed';
      state.outcome = `${CAP_OUTCOME_PREFIX}: ${node.agent_name ?? node.id} hit its maximum of ${capOf(node)} invocation(s)`;
      return { ok: false, capped: node };
    }
    state.invocations[node.id] = count;
    const agent = agentsById.get(node.agent_id!);
    state.path.push({ node: node.id, agent: agent?.name ?? node.agent_name ?? node.id, at: Date.now(), via });
    recordExecutedUsage(runId, projectId, { id: node.agent_id ?? null, name: agent?.name ?? node.agent_name ?? node.id });
  }
  state.current = nodes.map(n => n.id);
  return { ok: true };
}

export function startRun(projectId: string, input: Record<string, unknown>, callerEmail = '', evalCaseId = ''): StepResult {
  const runId = uuidv4();
  const flowRecord = db.prepare('SELECT flow_json FROM project_flows WHERE project_id = ?')
    .get(projectId) as { flow_json: string } | undefined;
  if (!flowRecord) return { runId, text: 'This project has no flow configured. Draw one in the flow builder before starting a run.', done: true, error: 'no_flow' };

  const flow = normalizeFlow(JSON.parse(flowRecord.flow_json));
  if (flow.nodes.length === 0) return { runId, text: 'This project\'s flow is empty. Add a Start node and at least one agent in the flow builder.', done: true, error: 'empty_flow' };

  const agentsById = loadAgents(flow);
  const errors = validateFlow(flow.nodes, flow.edges, agentsById);
  if (errors.length > 0) {
    return { runId, text: 'This flow does not validate, so no run was started. Fix the following in the flow builder and try again:\n' + errors.map(e => `- ${e}`).join('\n'), done: true, error: 'invalid_flow' };
  }

  const start = flow.nodes.find(n => n.type === 'start')!;
  const startEdge = flow.edges.find(e => e.from === start.id)!;
  const target = flow.nodes.find(n => n.id === startEdge.to)!;

  const state: EngineState = { status: 'active', current: [], invocations: {}, path: [] };

  const lines: string[] = [];
  lines.push('# AIOrc — stepped workflow (server-verified mode)');
  lines.push('');
  lines.push('The server orchestrates this workflow: it hands you ONE step at a time and validates every transition against the flow graph. Execute only what you are given.');
  lines.push('');
  if (input && Object.keys(input).length > 0) {
    lines.push('## User input');
    lines.push('```json');
    lines.push(JSON.stringify(input, null, 2));
    lines.push('```');
    lines.push('');
  }
  renderContextsSection(projectId, lines);
  renderSkillsSection([...agentsById.values()], lines);

  const { agents: toDispatch, end } = resolveDispatch(flow, target);

  db.prepare(
    `INSERT INTO runs (id, project_id, input, workflow_snapshot, flow_json, execution_report, caller_email, mode, engine_state, eval_case_id, status, created_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?, '', ?, 'stepped', '', ?, 'running', ?, ?)`
  ).run(runId, projectId, JSON.stringify(input), '', JSON.stringify(flow), callerEmail, evalCaseId, Date.now(), Date.now());
  recordPlannedUsage(runId, projectId, [...agentsById.values()].map(a => ({ id: a.id, name: a.name })));

  if (end || toDispatch.length === 0) {
    state.status = 'completed';
    state.outcome = end?.outcome ?? 'flow has no reachable agents';
    persistState(runId, state);
    return { runId, text: `This flow terminates immediately (${state.outcome}). Nothing to execute — report back to the user.`, done: true };
  }

  dispatchNodes(runId, projectId, state, toDispatch, agentsById);
  dispatchText(flow, toDispatch, agentsById, runId, state, lines);
  persistState(runId, state);
  return { runId, text: lines.join('\n'), done: false };
}

export function nextStep(runRow: RunRow, output: string, hint: string): StepResult {
  const runId = runRow.id;
  if (runRow.mode !== 'stepped' || !runRow.engine_state) {
    return { runId, text: 'This run is not in stepped mode, so `workflow.next` does not apply to it. Call `workflow.start` to begin a server-verified run.', done: true, error: 'not_stepped' };
  }
  const state = JSON.parse(runRow.engine_state) as EngineState;
  if (state.status === 'completed') {
    return { runId, text: 'This run has already finished. Call `workflow.report` with the final summary if you have not done so yet.', done: true };
  }

  const flow = normalizeFlow(JSON.parse(runRow.flow_json));
  const agentsById = loadAgents(flow);

  // Attach the LLM's output summary to the last dispatched step (audit trail).
  if (state.path.length > 0 && output) {
    state.path[state.path.length - 1]!.output = output.slice(0, 500);
  }

  const choice = chooseTransition(flow, state.current, hint);
  if (choice.error) {
    const edges = allowedEdges(flow, state.current);
    const text = [
      `Transition rejected: ${choice.error}`,
      '',
      'Allowed transitions from the current step:',
      ...edges.map(e => `- ${describeEdge(flow, e)}`),
      '',
      'The run is still open and no step was consumed. Call `workflow.next` again with the same `runId` and `output`, setting `next` to one of the transitions above. Pass `"next": "none"` if no condition matched.',
    ].join('\n');
    persistState(runId, state); // keep the output summary even on a rejected hop
    return { runId, text, done: false, error: 'invalid_transition' };
  }

  if (choice.end || !choice.edge) {
    state.status = 'completed';
    state.outcome = state.outcome ?? 'end of flow (no applicable transitions)';
    persistState(runId, state);
    const evalText = gradeIfEval(runId, runRow.eval_case_id, state);
    return { runId, text: `Workflow completed: ${state.outcome}. Now call \`workflow.report\` with {runId, report: {final_summary}} — the run is not auditable until you do.${evalText}`, done: true };
  }

  const target = flow.nodes.find(n => n.id === choice.edge!.to)!;
  const { agents: toDispatch, end } = resolveDispatch(flow, target);

  if (end) {
    state.status = 'completed';
    state.outcome = end.outcome ?? 'success';
    persistState(runId, state);
    const evalText = gradeIfEval(runId, runRow.eval_case_id, state);
    return { runId, text: `Workflow completed — reached End: ${state.outcome}. Now call \`workflow.report\` with {runId, report: {final_summary}} — the run is not auditable until you do.${evalText}`, done: true };
  }

  const dispatched = dispatchNodes(runId, runRow.project_id, state, toDispatch, agentsById, hint || undefined);
  if (!dispatched.ok) {
    persistState(runId, state);
    const evalText = gradeIfEval(runId, runRow.eval_case_id, state);
    return { runId, text: `Workflow stopped early: ${state.outcome}. Tell the user why it stopped, then call \`workflow.report\` with what did run.${evalText}`, done: true };
  }

  const lines: string[] = [];
  dispatchText(flow, toDispatch, agentsById, runId, state, lines);
  persistState(runId, state);
  return { runId, text: lines.join('\n'), done: false };
}
