// Flow model, transition rules and graph validation. Pure TypeScript with no
// imports: the server (src/) and the flow editor (src-frontend/, bundled by
// Vite) both import this file, so the editor can never accept a flow the
// server would reject, or the other way round.

// ── Model ────────────────────────────────────────────────────────────────────
//
// A flow is a directed graph of four node types:
// - start:    exactly one; one outgoing edge.
// - agent:    references an agent. Must have at least one outgoing edge.
// - parallel: a fork. Every outgoing edge goes to an agent node (a branch);
//             each branch has exactly one incoming edge (from the fork) and
//             exactly one unconditional outgoing edge, and all branches of a
//             fork point at the same join node. The server dispatches all
//             branches together and advances only when every branch output
//             has arrived.
// - end:      terminal. A run completes only by reaching an End node.
//
// Edges leaving a node with several exits are either
// - rule edges (`when`), evaluated by the server on the validated output, or
// - natural-language edges (`condition`), chosen by the client by edge id,
// never a mix of both, plus exactly one default edge (`default: true`, or an
// edge with neither `when` nor `condition`) that is taken when nothing else is.

export type FlowNodeType = 'start' | 'agent' | 'parallel' | 'end';

export interface FlowNode {
  id: string;
  type: FlowNodeType;
  agent_id?: string;          // type='agent'
  agent_name?: string;        // type='agent', denormalized for display
  max_invocations?: number;   // type='agent', default 10, capped to 50
  outcome?: string;           // type='end'
  label?: string;             // display label, mostly for 'parallel'
  x: number;
  y: number;
}

export type RuleOp = 'eq' | 'ne' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists';

export type Rule =
  | { path: string; op: RuleOp; value?: unknown }
  | { all: Rule[] }
  | { any: Rule[] };

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  condition?: string;   // natural language; the client picks the edge by id
  when?: Rule;          // deterministic rule over the source node's output
  default?: boolean;    // taken when no other edge applies
  priority?: number;    // ascending evaluation order for rule edges; default 1000
}

export interface FlowDocument {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export const RULE_OPS: RuleOp[] = ['eq', 'ne', 'in', 'gt', 'gte', 'lt', 'lte', 'exists'];
const MAX_RULE_DEPTH = 6;
const MAX_RULE_NODES = 64;

export function isDefaultEdge(e: FlowEdge): boolean {
  return e.default === true || (!e.when && !(e.condition && e.condition.trim()));
}

export function outgoing(flow: FlowDocument, nodeId: string): FlowEdge[] {
  return flow.edges
    .filter(e => e.from === nodeId)
    .sort((a, b) => (a.priority ?? 1000) - (b.priority ?? 1000) || a.id.localeCompare(b.id));
}

// ── Rules ────────────────────────────────────────────────────────────────────
//
// path: dot-separated keys into the output object ("verdict",
// "summary.blocking", "findings.0.severity"). The final segment `length`
// on an array or string yields its length. No eval, no regex.

export function resolvePath(value: unknown, path: string): { found: boolean; value: unknown } {
  let cur: unknown = value;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return { found: false, value: undefined };
    if (seg === 'length' && (Array.isArray(cur) || typeof cur === 'string')) { cur = cur.length; continue; }
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg)) return { found: false, value: undefined };
      const i = Number(seg);
      if (i >= cur.length) return { found: false, value: undefined };
      cur = cur[i];
      continue;
    }
    if (typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, seg)) return { found: false, value: undefined };
    cur = (cur as Record<string, unknown>)[seg];
  }
  return { found: true, value: cur };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function evaluateRule(rule: Rule, output: unknown): boolean {
  if ('all' in rule) return rule.all.every(r => evaluateRule(r, output));
  if ('any' in rule) return rule.any.some(r => evaluateRule(r, output));
  const { found, value } = resolvePath(output, rule.path);
  switch (rule.op) {
    case 'exists': return rule.value === false ? !found || value === null : found && value !== null;
    case 'eq': return found && sameValue(value, rule.value);
    case 'ne': return !found || !sameValue(value, rule.value);
    case 'in': return found && Array.isArray(rule.value) && rule.value.some(v => sameValue(v, value));
    case 'gt': case 'gte': case 'lt': case 'lte': {
      if (!found) return false;
      const bothNum = typeof value === 'number' && typeof rule.value === 'number';
      const bothStr = typeof value === 'string' && typeof rule.value === 'string';
      if (!bothNum && !bothStr) return false;
      const a = value as number | string, b = rule.value as number | string;
      return rule.op === 'gt' ? a > b : rule.op === 'gte' ? a >= b : rule.op === 'lt' ? a < b : a <= b;
    }
  }
  return false;
}

// Returns an error message, or null when the rule is well-formed.
export function checkRule(rule: unknown, depth = 0, budget = { n: 0 }): string | null {
  budget.n += 1;
  if (budget.n > MAX_RULE_NODES) return `rule is too large (more than ${MAX_RULE_NODES} clauses)`;
  if (depth > MAX_RULE_DEPTH) return `rule is nested too deeply (more than ${MAX_RULE_DEPTH} levels)`;
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return 'rule must be an object';
  const r = rule as Record<string, unknown>;
  const keys = Object.keys(r);
  if ('all' in r || 'any' in r) {
    if (keys.length !== 1) return 'a combinator rule has exactly one key: "all" or "any"';
    const list = (r.all ?? r.any) as unknown;
    if (!Array.isArray(list) || list.length === 0) return '"all"/"any" must be a non-empty array of rules';
    for (const sub of list) { const err = checkRule(sub, depth + 1, budget); if (err) return err; }
    return null;
  }
  if (typeof r.path !== 'string' || !/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(r.path)) {
    return 'rule.path must be a dot-separated path of letters, digits, "_" or "-"';
  }
  if (!RULE_OPS.includes(r.op as RuleOp)) return `rule.op must be one of ${RULE_OPS.join(', ')}`;
  for (const k of keys) if (!['path', 'op', 'value'].includes(k)) return `unknown rule field "${k}"`;
  if (r.op === 'in' && !Array.isArray(r.value)) return 'rule.value must be an array for op "in"';
  if (['gt', 'gte', 'lt', 'lte'].includes(r.op as string) && typeof r.value !== 'number' && typeof r.value !== 'string') {
    return `rule.value must be a number or string for op "${r.op}"`;
  }
  if (r.op === 'exists' && r.value !== undefined && typeof r.value !== 'boolean') return 'rule.value must be true or false for op "exists"';
  if (!['exists'].includes(r.op as string) && !('value' in r)) return `rule.value is required for op "${r.op}"`;
  return null;
}

export function describeRule(rule: Rule): string {
  if ('all' in rule) return rule.all.map(describeRule).join(' AND ');
  if ('any' in rule) return '(' + rule.any.map(describeRule).join(' OR ') + ')';
  return rule.op === 'exists' ? `${rule.path} ${rule.value === false ? 'is absent' : 'exists'}` : `${rule.path} ${rule.op} ${JSON.stringify(rule.value)}`;
}

// ── Exits of a node ──────────────────────────────────────────────────────────

export type ExitKind = 'none' | 'single' | 'rules' | 'choice' | 'invalid';

export function exitKind(edges: FlowEdge[]): ExitKind {
  if (edges.length === 0) return 'none';
  if (edges.length === 1) return isDefaultEdge(edges[0]!) ? 'single' : 'invalid';
  const nonDefault = edges.filter(e => !isDefaultEdge(e));
  if (edges.length - nonDefault.length !== 1) return 'invalid';
  if (nonDefault.every(e => e.when && !(e.condition && e.condition.trim()))) return 'rules';
  if (nonDefault.every(e => !e.when && e.condition && e.condition.trim())) return 'choice';
  return 'invalid';
}

// ── Validation ───────────────────────────────────────────────────────────────

export interface AgentInfo {
  name: string;
  hasOutputSchema: boolean;
}

const KNOWN_TYPES: FlowNodeType[] = ['start', 'agent', 'parallel', 'end'];

function nodeLabel(n: FlowNode, agents?: Map<string, AgentInfo>): string {
  if (n.type === 'agent') return `Agent "${(n.agent_id && agents?.get(n.agent_id)?.name) || n.agent_name || n.id}"`;
  if (n.type === 'end') return n.outcome ? `End "${n.outcome}"` : `End ${n.id}`;
  if (n.type === 'parallel') return n.label ? `Parallel "${n.label}"` : `Parallel ${n.id}`;
  if (n.type === 'start') return 'The Start node';
  return `Node ${n.id}`;
}

// Returns human-readable errors; an empty array means the flow is valid.
// `agents` maps agent ids to what the validator needs to know about them.
// Pass `undefined` to skip the checks that need agent data (editor previews).
export function validateFlow(flow: FlowDocument, agents?: Map<string, AgentInfo>): string[] {
  const errors: string[] = [];
  const { nodes, edges } = flow;
  if (nodes.length === 0) return ['The flow is empty. Add a Start node, at least one agent and an End node.'];

  // Identity and types.
  const ids = new Set<string>();
  for (const n of nodes) {
    if (!n.id) { errors.push('A node has no id.'); continue; }
    if (ids.has(n.id)) errors.push(`Two nodes share the id "${n.id}". Node ids must be unique.`);
    ids.add(n.id);
    if (!KNOWN_TYPES.includes(n.type)) errors.push(`Node ${n.id} has unknown type "${String(n.type)}".`);
  }
  const edgeIds = new Set<string>();
  for (const e of edges) {
    if (!e.id) { errors.push('An edge has no id.'); continue; }
    if (edgeIds.has(e.id)) errors.push(`Two edges share the id "${e.id}". Edge ids must be unique.`);
    edgeIds.add(e.id);
    if (!ids.has(e.from)) errors.push(`Edge ${e.id} starts at a node that does not exist (${e.from}).`);
    if (!ids.has(e.to)) errors.push(`Edge ${e.id} points at a node that does not exist (${e.to}).`);
    if (e.when !== undefined) {
      const err = checkRule(e.when);
      if (err) errors.push(`Edge ${e.id}: ${err}.`);
    }
    if (e.when !== undefined && e.condition && e.condition.trim()) {
      errors.push(`Edge ${e.id} has both a rule ("when") and a natural-language condition. Use one or the other.`);
    }
  }
  if (errors.length > 0) return errors; // the rest assumes a well-formed graph

  const byId = new Map(nodes.map(n => [n.id, n]));
  const starts = nodes.filter(n => n.type === 'start');
  const ends = nodes.filter(n => n.type === 'end');
  if (starts.length !== 1) errors.push(starts.length === 0 ? 'The flow has no Start node.' : `The flow has ${starts.length} Start nodes; it needs exactly one.`);
  if (ends.length === 0) errors.push('The flow has no End node. A run only completes by reaching an End.');

  for (const n of nodes) {
    const out = outgoing(flow, n.id);
    const inc = edges.filter(e => e.to === n.id);
    const label = nodeLabel(n, agents);

    if (n.type === 'start') {
      if (inc.length > 0) errors.push('The Start node cannot have incoming edges.');
      if (out.length !== 1) errors.push(`The Start node must have exactly one outgoing edge (it has ${out.length}).`);
      else if (!isDefaultEdge(out[0]!)) errors.push('The edge leaving Start cannot carry a condition or rule.');
      continue;
    }
    if (n.type === 'end') {
      if (out.length > 0) errors.push(`${label} cannot have outgoing edges.`);
      continue;
    }
    if (n.type === 'agent') {
      if (!n.agent_id) errors.push(`Agent node ${n.id} has no agent assigned.`);
      else if (agents && !agents.has(n.agent_id)) errors.push(`Agent node ${n.id} references an agent that does not exist or is not available to this project (${n.agent_id}).`);
    }
    if (out.length === 0) { errors.push(`${label} has no outgoing edge. Every node except End needs a way forward.`); continue; }

    if (n.type === 'parallel') {
      if (out.length < 2) errors.push(`${label} has ${out.length} branch(es); a fork needs at least 2.`);
      if (out.some(e => !isDefaultEdge(e))) errors.push(`${label}: branch edges of a fork cannot carry conditions or rules.`);
      const joins = new Set<string>();
      for (const e of out) {
        const b = byId.get(e.to)!;
        if (b.type !== 'agent') { errors.push(`${label}: every branch must be an agent node (edge ${e.id} goes to ${nodeLabel(b, agents)}).`); continue; }
        const bIn = edges.filter(x => x.to === b.id);
        const bOut = outgoing(flow, b.id);
        if (bIn.length !== 1) errors.push(`${nodeLabel(b, agents)} is a branch of ${label} and must have no other incoming edges.`);
        if (bOut.length !== 1 || !isDefaultEdge(bOut[0]!)) errors.push(`${nodeLabel(b, agents)} is a branch of ${label} and must have exactly one unconditional outgoing edge, to the join node.`);
        else joins.add(bOut[0]!.to);
      }
      if (joins.size > 1) errors.push(`${label}: all branches must converge on the same join node (they go to ${joins.size} different nodes).`);
      for (const j of joins) {
        const jn = byId.get(j)!;
        if (jn.type === 'parallel') errors.push(`${label}: the join node cannot itself be a Parallel node.`);
      }
      continue;
    }

    const kind = exitKind(out);
    if (kind === 'invalid') {
      const defaults = out.filter(isDefaultEdge).length;
      if (out.length === 1) errors.push(`${label} has a single outgoing edge with a condition or rule. A lone exit must be unconditional.`);
      else if (defaults !== 1) errors.push(`${label} has ${out.length} outgoing edges and ${defaults} default edge(s). Exactly one must be the default (no condition, no rule).`);
      else errors.push(`${label} mixes rule edges and natural-language edges. All non-default exits of a node must be of the same kind.`);
    }
    if (kind === 'rules' && n.type === 'agent' && agents && n.agent_id && agents.get(n.agent_id) && !agents.get(n.agent_id)!.hasOutputSchema) {
      errors.push(`${label} has rule edges, so its agent needs an output schema the rules can be evaluated against.`);
    }
  }
  if (errors.length > 0) return errors;

  // Reachability: every node reachable from Start, every node reaches an End.
  const start = starts[0]!;
  const reach = new Set<string>([start.id]);
  const queue = [start.id];
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of edges) if (e.from === id && !reach.has(e.to)) { reach.add(e.to); queue.push(e.to); }
  }
  for (const n of nodes) if (!reach.has(n.id)) errors.push(`${nodeLabel(n, agents)} cannot be reached from Start.`);

  const toEnd = new Set<string>(ends.map(n => n.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of edges) if (toEnd.has(e.to) && !toEnd.has(e.from)) { toEnd.add(e.from); changed = true; }
  }
  for (const n of nodes) if (!toEnd.has(n.id)) errors.push(`${nodeLabel(n, agents)} has no path to any End node.`);

  return errors;
}
