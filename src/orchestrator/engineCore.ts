import { FlowDocument, FlowEdge, FlowNode } from '../db/schema';

// Pure transition logic for the stepped execution engine — no DB access, so it
// can be unit-tested in isolation. engine.ts wires this to persistence.

export const DEFAULT_MAX_INVOCATIONS = 10;

export interface PathStep {
  node: string;
  agent: string;
  at: number;
  via?: string;     // the transition hint the LLM gave to reach this step
  output?: string;  // truncated output summary of the PREVIOUS step
}

export interface EngineState {
  status: 'active' | 'completed';
  current: string[];                    // node ids dispatched and awaiting completion
  invocations: Record<string, number>;  // per node id
  path: PathStep[];
  outcome?: string;
}

export interface TransitionChoice {
  edge?: FlowEdge;
  end?: boolean;          // run is over (no edges / explicit none-match)
  error?: string;         // invalid hint — caller should re-prompt with allowed edges
}

export function allowedEdges(flow: FlowDocument, currentIds: string[]): FlowEdge[] {
  const out: FlowEdge[] = [];
  for (const id of currentIds) {
    for (const e of flow.edges) if (e.from === id) out.push(e);
  }
  return out.sort((a, b) => (a.priority ?? 1000) - (b.priority ?? 1000));
}

export function describeEdge(flow: FlowDocument, e: FlowEdge): string {
  const target = flow.nodes.find(n => n.id === e.to);
  const label = !target ? e.to
    : target.type === 'end' ? `End${target.outcome ? `: "${target.outcome}"` : ''}`
    : target.type === 'parallel' ? `Parallel${target.label ? `: "${target.label}"` : ''}`
    : target.agent_name ?? target.id;
  return e.condition ? `→ ${label} — cuando: ${e.condition}` : `→ ${label} (sin condición — fallback)`;
}

// Resolve the LLM's transition hint against the legal edges. The hint can be
// the target agent's name, "end", the end node's outcome, or (part of) the
// edge's condition text. "none" means no conditional edge matched.
export function chooseTransition(flow: FlowDocument, currentIds: string[], hint: string): TransitionChoice {
  const edges = allowedEdges(flow, currentIds);
  if (edges.length === 0) return { end: true };

  const norm = (s: string) => s.trim().toLowerCase();
  const h = norm(hint ?? '');

  if (h === 'none') {
    if (edges.every(e => e.condition)) return { end: true }; // legal stop: nothing matched
    const fallback = edges.find(e => !e.condition);
    return { edge: fallback! }; // an unconditional edge exists — it must be taken
  }

  if (!h) {
    if (edges.length === 1) return { edge: edges[0]! };
    // Join after a fork: several unconditional edges converging on the same
    // node (each parallel branch carries its own edge) — not a real choice.
    const targets = new Set(edges.map(e => e.to));
    if (targets.size === 1 && edges.every(e => !e.condition)) return { edge: edges[0]! };
    return { error: 'Transición ambigua: indicá `next` con el agente destino o la condición que se cumplió.' };
  }

  const matches = edges.filter(e => {
    const target = flow.nodes.find(n => n.id === e.to);
    const labels: string[] = [];
    if (target?.type === 'agent' && target.agent_name) labels.push(norm(target.agent_name));
    if (target?.type === 'end') { labels.push('end'); if (target.outcome) labels.push(norm(target.outcome)); }
    if (target?.type === 'parallel') { labels.push('parallel'); if (target.label) labels.push(norm(target.label)); }
    if (labels.some(l => l === h || l.includes(h) || h.includes(l))) return true;
    if (e.condition) {
      const c = norm(e.condition);
      if (c.includes(h) || h.includes(c)) return true;
    }
    return false;
  });

  if (matches.length === 1) return { edge: matches[0]! };
  if (matches.length > 1) {
    // Converging edges to the same node are equivalent — take the first.
    const targets = new Set(matches.map(e => e.to));
    if (targets.size === 1) return { edge: matches[0]! };
    return { error: `El hint "${hint}" matchea ${matches.length} transiciones. Sé más específico.` };
  }
  return { error: `"${hint}" no corresponde a ninguna transición permitida desde acá.` };
}

// Given a chosen target node, which agent nodes get dispatched?
// agent → itself; parallel → all its branch targets (a fork is mandatory).
export function resolveDispatch(flow: FlowDocument, target: FlowNode): { agents: FlowNode[]; end?: FlowNode } {
  if (target.type === 'end') return { agents: [], end: target };
  if (target.type === 'agent') return { agents: [target] };
  if (target.type === 'parallel') {
    const agents: FlowNode[] = [];
    for (const e of flow.edges.filter(e => e.from === target.id)) {
      const branch = flow.nodes.find(n => n.id === e.to);
      if (branch?.type === 'agent') agents.push(branch);
    }
    return { agents };
  }
  return { agents: [] };
}

export function capOf(node: FlowNode): number {
  return node.max_invocations ?? DEFAULT_MAX_INVOCATIONS;
}
