import { FlowDocument, FlowNode, FlowEdge } from '../db/schema';

// ── Graph-aware skip classification ─────────────────────────────────────────
//
// A planned agent that doesn't appear in the execution report is NOT
// necessarily a bug: conditional branches legitimately divert the flow away
// from entire subgraphs. An agent only counts as a REAL skip when the taken
// path required it:
//
//   1. Dominator rule — the agent's node lies on EVERY path from Start to some
//      node that DID execute. If X ran and A dominates X, A had to run first;
//      a report naming X but not A means the LLM jumped over a mandatory step.
//   2. Truncation rule — after the last reported agent, the flow continues
//      through an unconditional (fallback) edge to another agent. Per the
//      execution rules the LLM may only stop when every outgoing edge is
//      conditional and none matches — so an unexecuted fallback target means
//      the run was cut short.
//
// Everything else planned-but-not-executed is classified as off-path
// (a branch that wasn't taken) and excluded from compliance.

export interface SkipClassification {
  realSkips: Set<string>;  // agent names required by the taken path but never executed
  offPath: Set<string>;    // agent names planned but legitimately not on the taken path
}

export function classifySkips(
  flow: FlowDocument,
  plannedNames: Set<string>,
  executedNames: Set<string>,
  orderedPath: string[]
): SkipClassification {
  const realSkips = new Set<string>();
  const nodes = flow.nodes ?? [];
  const edges = flow.edges ?? [];
  const nodesById = new Map<string, FlowNode>(nodes.map(n => [n.id, n]));

  const succs = new Map<string, FlowEdge[]>();
  const preds = new Map<string, string[]>();
  for (const n of nodes) { succs.set(n.id, []); preds.set(n.id, []); }
  for (const e of edges) {
    if (!nodesById.has(e.from) || !nodesById.has(e.to)) continue;
    succs.get(e.from)!.push(e);
    preds.get(e.to)!.push(e.from);
  }

  const start = nodes.find(n => n.type === 'start');
  if (!start) {
    return { realSkips, offPath: diff(plannedNames, executedNames, realSkips) };
  }

  // Reachable set from Start
  const reachable = new Set<string>();
  const queue = [start.id];
  while (queue.length) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const e of succs.get(id) ?? []) queue.push(e.to);
  }

  // Iterative dominator computation over the reachable subgraph
  const reachableIds = [...reachable];
  const dom = new Map<string, Set<string>>();
  for (const id of reachableIds) {
    dom.set(id, id === start.id ? new Set([id]) : new Set(reachableIds));
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of reachableIds) {
      if (id === start.id) continue;
      const ps = (preds.get(id) ?? []).filter(p => reachable.has(p));
      let inter = new Set<string>();
      let first = true;
      for (const p of ps) {
        const dp = dom.get(p)!;
        if (first) { inter = new Set(dp); first = false; }
        else {
          const merged = new Set<string>();
          for (const x of inter) if (dp.has(x)) merged.add(x);
          inter = merged;
        }
      }
      const next = inter;
      next.add(id);
      const cur = dom.get(id)!;
      if (next.size !== cur.size || [...next].some(x => !cur.has(x))) {
        dom.set(id, next);
        changed = true;
      }
    }
  }

  const nameOf = (n: FlowNode) => (n.type === 'agent' ? (n.agent_name ?? '') : '');
  const executedNodeIds = nodes
    .filter(n => n.type === 'agent' && executedNames.has(nameOf(n)))
    .map(n => n.id);

  // Rule 1: dominators of executed nodes
  const required = new Set<string>();
  for (const x of executedNodeIds) {
    for (const d of dom.get(x) ?? []) required.add(d);
  }
  // Parallel forks: every branch is mandatory (a fork is not a choice), so a
  // required parallel node makes all its direct targets required too.
  for (const id of [...required]) {
    const n = nodesById.get(id);
    if (n?.type !== 'parallel') continue;
    for (const e of succs.get(id) ?? []) required.add(e.to);
  }

  for (const id of required) {
    const n = nodesById.get(id);
    if (!n || n.type !== 'agent') continue;
    const name = nameOf(n);
    if (name && plannedNames.has(name) && !executedNames.has(name)) realSkips.add(name);
  }

  // Rule 2: truncation after the last reported agent
  const lastName = orderedPath.length > 0 ? orderedPath[orderedPath.length - 1] : '';
  const lastNodes = lastName ? nodes.filter(n => n.type === 'agent' && nameOf(n) === lastName) : [];
  for (const lastNode of lastNodes) {
    let cur: FlowNode | undefined = lastNode;
    const visited = new Set<string>();
    while (cur && !visited.has(cur.id)) {
      visited.add(cur.id);
      const unconditional = (succs.get(cur.id) ?? []).filter(e => !e.condition);
      if (unconditional.length === 0) break; // all edges conditional → stopping is legal
      const target = nodesById.get(unconditional[0]!.to);
      if (!target || target.type === 'end') break;
      if (target.type === 'parallel') {
        for (const be of succs.get(target.id) ?? []) {
          const branch = nodesById.get(be.to);
          if (branch?.type === 'agent') {
            const bn = nameOf(branch);
            if (bn && plannedNames.has(bn) && !executedNames.has(bn)) realSkips.add(bn);
          }
        }
        break;
      }
      if (target.type === 'agent') {
        const tn = nameOf(target);
        if (tn && executedNames.has(tn)) break; // it ran — path just isn't strictly ordered
        if (tn && plannedNames.has(tn)) realSkips.add(tn);
        cur = target; // whatever follows it unconditionally was also required
        continue;
      }
      break;
    }
  }

  return { realSkips, offPath: diff(plannedNames, executedNames, realSkips) };
}

function diff(planned: Set<string>, executed: Set<string>, real: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const name of planned) {
    if (!executed.has(name) && !real.has(name)) out.add(name);
  }
  return out;
}
