import { FlowDocument, FlowEdge, FlowNode } from '../db/schema';
import { evaluateRule, exitKind, isDefaultEdge, outgoing } from '../shared/flow';

// Pure transition logic for the stepped engine: no DB access, unit-tested in
// isolation. engine.ts wires it to persistence.
//
// The server decides every transition:
// - one unconditional exit: taken;
// - rule exits: evaluated in priority order on the validated output, the
//   default edge when none matches; the client does not choose;
// - natural-language exits: the client names the edge id it chose, compared
//   exactly; the default edge is a legal choice too;
// - after a fork: every branch has one exit to the shared join node.
// There is no "none", and no substring or fuzzy matching of any kind.

export const DEFAULT_MAX_INVOCATIONS = 10;

export type RunStatus = 'active' | 'completed' | 'capped' | 'cancelled' | 'failed';

export interface StepRecord {
  step: number;
  nodes: string[];                 // node ids dispatched at this step
  agents: string[];                // agent names, same order as nodes
  dispatched_at: number;
  completed_at?: number;           // set when every output was accepted
  outputs?: { node: string; sha256: string }[];
  transition?: string;             // id of the edge taken after this step
}

export interface StepResponse {
  text: string;
  meta: Record<string, unknown>;
}

export interface EngineState {
  status: RunStatus;
  step: number;                    // the step awaiting outputs (0 when none)
  current: string[];               // node ids dispatched and awaiting outputs
  invocations: Record<string, number>;
  steps: StepRecord[];
  outcome?: string;
  end_node?: string;
  // Idempotent replay: the last accepted request and the answer it got.
  last?: { step: number; request_sha256: string; response: StepResponse };
}

export interface ExitChoice {
  edge?: FlowEdge;
  error?: string;
}

export function capOf(node: FlowNode): number {
  return node.max_invocations ?? DEFAULT_MAX_INVOCATIONS;
}

// The exits that matter after `currentIds` completed. For a single node, its
// own edges; for fork branches, their (identical-target) join edges.
export function exitsOf(flow: FlowDocument, currentIds: string[]): FlowEdge[] {
  return currentIds.flatMap(id => outgoing(flow, id));
}

export function resolveExit(
  flow: FlowDocument,
  currentIds: string[],
  outputs: Map<string, unknown>,
  transition: string | undefined
): ExitChoice {
  if (currentIds.length > 1) {
    const edges = exitsOf(flow, currentIds);
    const targets = new Set(edges.map(e => e.to));
    if (targets.size !== 1 || edges.length !== currentIds.length) return { error: 'fork branches do not converge on one join node' };
    if (transition !== undefined) return { error: 'a fork joins automatically; do not send `transition`' };
    return { edge: edges[0]! };
  }

  const nodeId = currentIds[0]!;
  const edges = outgoing(flow, nodeId);
  const kind = exitKind(edges);

  if (kind === 'single') {
    if (transition !== undefined && transition !== edges[0]!.id) {
      return { error: `there is only one way forward from here (edge \`${edges[0]!.id}\`); omit \`transition\`` };
    }
    return { edge: edges[0]! };
  }

  if (kind === 'rules') {
    if (transition !== undefined) return { error: 'the next step is decided by the server from your output; do not send `transition`' };
    const output = outputs.get(nodeId);
    const match = edges.find(e => !isDefaultEdge(e) && e.when && evaluateRule(e.when, output));
    return { edge: match ?? edges.find(isDefaultEdge)! };
  }

  if (kind === 'choice') {
    if (transition === undefined || transition === '') {
      return { error: `choose the next step: set \`transition\` to one of ${edges.map(e => `\`${e.id}\``).join(', ')}` };
    }
    const edge = edges.find(e => e.id === transition);
    if (!edge) return { error: `"${transition}" is not an edge id leaving this step. Allowed: ${edges.map(e => `\`${e.id}\``).join(', ')}` };
    return { edge };
  }

  return { error: kind === 'none' ? 'this step has no way forward (the flow should have been rejected by validation)' : 'the exits of this step are ambiguous (the flow should have been rejected by validation)' };
}

// Which agent nodes does reaching `target` dispatch? An agent dispatches
// itself, a fork dispatches all its branches, an End finishes the run.
export function resolveDispatch(flow: FlowDocument, target: FlowNode): { agents: FlowNode[]; end?: FlowNode } {
  if (target.type === 'end') return { agents: [], end: target };
  if (target.type === 'agent') return { agents: [target] };
  if (target.type === 'parallel') {
    const agents = outgoing(flow, target.id)
      .map(e => flow.nodes.find(n => n.id === e.to))
      .filter((n): n is FlowNode => !!n && n.type === 'agent');
    return { agents };
  }
  return { agents: [] };
}

// The set of nodes in `outputs` must be exactly the dispatched set.
export function checkOutputCoverage(current: string[], outputNodes: string[]): string | null {
  const seen = new Set<string>();
  for (const n of outputNodes) {
    if (seen.has(n)) return `node \`${n}\` appears twice in \`outputs\``;
    seen.add(n);
    if (!current.includes(n)) return `node \`${n}\` was not dispatched at this step (expected ${current.map(c => `\`${c}\``).join(', ')})`;
  }
  const missing = current.filter(c => !seen.has(c));
  if (missing.length) return `missing output for ${missing.map(c => `\`${c}\``).join(', ')}; every dispatched agent must hand back its output`;
  return null;
}
