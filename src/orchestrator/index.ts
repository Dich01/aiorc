import db from '../db/client';
import { Agent, FlowDocument, FlowEdge, FlowNode, FlowNodeType } from '../db/schema';
import { AgentInfo, describeRule, exitKind, isDefaultEdge, outgoing, validateFlow } from '../shared/flow';
import { renderFilesToLines } from '../lib/entityFiles';
import { DEFAULT_OUTPUT_SCHEMA, parseStoredSchema } from '../lib/outputSchema';
import { AgentSnap, ContextSnap, RunSnapshot, SkillSnap } from './snapshot';

export { validateFlow } from '../shared/flow';

const DEFAULT_MAX_INVOCATIONS = 10;
const MAX_MAX_INVOCATIONS = 50;
const DIVIDER = '━'.repeat(56);

// ── Normalizer ──────────────────────────────────────────────────────────────
// Turns stored or submitted JSON into a FlowDocument. It only coerces shapes;
// validateFlow decides whether the result is acceptable.

function clampMaxInvocations(n: unknown): number {
  if (typeof n !== 'number' || !isFinite(n) || n < 1) return DEFAULT_MAX_INVOCATIONS;
  return Math.min(MAX_MAX_INVOCATIONS, Math.floor(n));
}

export function normalizeFlow(raw: unknown): FlowDocument {
  const r = (raw ?? {}) as { nodes?: unknown[]; edges?: unknown[] };
  const nodes: FlowNode[] = (Array.isArray(r.nodes) ? r.nodes : []).map((n) => {
    const node = (n ?? {}) as Record<string, unknown>;
    const type = (typeof node.type === 'string' ? node.type : 'agent') as FlowNodeType;
    const result: FlowNode = { id: String(node.id ?? ''), type, x: Number(node.x ?? 0) || 0, y: Number(node.y ?? 0) || 0 };
    if (type === 'agent') {
      result.agent_id = String(node.agent_id ?? '');
      if (typeof node.agent_name === 'string') result.agent_name = node.agent_name;
      result.max_invocations = clampMaxInvocations(node.max_invocations);
    }
    if (type === 'end' && typeof node.outcome === 'string') result.outcome = node.outcome;
    if (typeof node.label === 'string') result.label = node.label;
    return result;
  });

  const edges: FlowEdge[] = (Array.isArray(r.edges) ? r.edges : []).map((e) => {
    const edge = (e ?? {}) as Record<string, unknown>;
    const out: FlowEdge = { id: String(edge.id ?? ''), from: String(edge.from ?? ''), to: String(edge.to ?? '') };
    if (typeof edge.condition === 'string' && edge.condition.trim()) out.condition = edge.condition;
    if (edge.when !== undefined && edge.when !== null) out.when = edge.when as FlowEdge['when'];
    if (edge.default === true) out.default = true;
    out.priority = typeof edge.priority === 'number' && isFinite(edge.priority) ? edge.priority : 1000;
    return out;
  });

  return { nodes, edges };
}

// Agents a project's flow may reference: the owner's agents that are either
// unlinked (visible in every project) or linked to this project.
export function agentInfoForProject(projectId: string): Map<string, AgentInfo> {
  const rows = db.prepare(
    `SELECT a.id, a.name, a.output_schema FROM agents a
     JOIN projects p ON p.id = ? AND p.user_id = a.user_id
     WHERE NOT EXISTS (SELECT 1 FROM project_agents pa WHERE pa.agent_id = a.id)
        OR EXISTS (SELECT 1 FROM project_agents pa WHERE pa.agent_id = a.id AND pa.project_id = p.id)`
  ).all(projectId) as Pick<Agent, 'id' | 'name' | 'output_schema'>[];
  return new Map(rows.map(a => [a.id, { name: a.name, hasOutputSchema: !!parseStoredSchema(a.output_schema) }]));
}

export function validateProjectFlow(projectId: string, flow: FlowDocument): string[] {
  return validateFlow(flow, agentInfoForProject(projectId));
}

// Every saved flow that references an agent. Used to refuse deletions (409).
export function flowsReferencingAgents(agentIds: string[]): { project_id: string; name: string }[] {
  if (agentIds.length === 0) return [];
  const want = new Set(agentIds);
  const rows = db.prepare('SELECT f.project_id, f.flow_json, p.name FROM project_flows f JOIN projects p ON p.id = f.project_id').all() as { project_id: string; flow_json: string; name: string }[];
  return rows.filter(r => {
    try { return normalizeFlow(JSON.parse(r.flow_json)).nodes.some(n => n.type === 'agent' && n.agent_id && want.has(n.agent_id)); }
    catch { return false; }
  }).map(r => ({ project_id: r.project_id, name: r.name }));
}

// ── Rendering (always from a run snapshot) ──────────────────────────────────

export function buildAgentBlock(agent: AgentSnap, snap: RunSnapshot, maxInvocations: number): string {
  const lines: string[] = [];
  lines.push(`### Agent: ${agent.name}`);
  lines.push(`**Maximum invocations:** ${maxInvocations}`);
  if (agent.description) lines.push(`**Description:** ${agent.description}`);
  const skills = agent.skill_ids.map(id => snap.skills.get(id)).filter((s): s is SkillSnap => !!s);
  if (skills.length > 0) {
    lines.push(`**Skills that apply (see the "Skills" section for the full rules):**`);
    for (const s of skills) lines.push(`- *${s.name}*: ${s.description}`);
  }
  if (agent.files.some(f => f.content && f.content.trim())) {
    lines.push(`**Agent instructions:**`);
    renderFilesToLines(agent.files.map(f => ({ ...f, id: '', ordinal: 0 })), lines, snap.project.allow_executable_files);
  }
  if (skills.length > 0) {
    lines.push('');
    lines.push(`**Self-check:** before handing back the output, re-read it against every skill listed above.`);
  }
  return lines.join('\n');
}

export function renderContextsSection(contexts: ContextSnap[], lines: string[], allowExecutable: boolean): void {
  if (contexts.length === 0) return;
  lines.push('## Project context');
  lines.push('');
  lines.push('Documentation and business knowledge that applies to the WHOLE flow. Read it before acting.');
  lines.push('');
  for (const ctx of contexts) {
    lines.push(`### Context: ${ctx.name}`);
    if (ctx.description) { lines.push(`*${ctx.description}*`); lines.push(''); }
    renderFilesToLines(ctx.files.map(f => ({ ...f, id: '', ordinal: 0 })), lines, allowExecutable);
    lines.push(DIVIDER);
    lines.push('');
  }
}

// Skills are shared across agents: emit each once, agents reference them by name.
export function renderSkillsSection(snap: RunSnapshot, lines: string[]): void {
  if (snap.skills.size === 0) return;
  lines.push('## Skills (rules to apply when an agent declares them)');
  lines.push('');
  lines.push('Each agent declares which skills it applies. A skill can have several files: SKILL.md is the entry point and the rest are reference material it may cite by name. Do not run a script just because it appears here; apply your normal judgment and permissions to anything you execute.');
  lines.push('');
  for (const skill of snap.skills.values()) {
    lines.push(`### Skill: ${skill.name}`);
    if (skill.description) { lines.push(`*${skill.description}*`); lines.push(''); }
    renderFilesToLines(skill.files.map(f => ({ ...f, id: '', ordinal: 0 })), lines, snap.project.allow_executable_files);
    lines.push(DIVIDER);
    lines.push('');
  }
}

export function describeTarget(flow: FlowDocument, nodeId: string): string {
  const t = flow.nodes.find(n => n.id === nodeId);
  if (!t) return nodeId;
  if (t.type === 'end') return `End${t.outcome ? ` "${t.outcome}"` : ''}`;
  if (t.type === 'parallel') return `Parallel${t.label ? ` "${t.label}"` : ''} (fork)`;
  return t.agent_name ?? t.id;
}

export function describeEdgeForPrompt(flow: FlowDocument, e: FlowEdge): string {
  const to = describeTarget(flow, e.to);
  if (e.when) return `if ${describeRule(e.when)} → ${to}`;
  if (e.condition) return `\`${e.id}\` → ${to} — when: ${e.condition}`;
  return `\`${e.id}\` → ${to} (default)`;
}

// ── Compiled (model-orchestrated mode) document ───────────────────────────────────────────
//
// The whole flow in one prompt: the model is the orchestrator and the server
// sees nothing until the self-declared report arrives through workflow.report.
// Built from the same run snapshot as stepped mode, so the instructions are
// frozen and hashed either way. Nothing here is enforced; the document says so.

function nodeTitle(snap: RunSnapshot, n: FlowNode): string {
  if (n.type === 'agent') return snap.agents.get(n.agent_id ?? '')?.name ?? n.agent_name ?? n.id;
  return describeTarget(snap.flow, n.id);
}

export function renderCompiledFlow(runId: string, snap: RunSnapshot, lines: string[]): void {
  const flow = snap.flow;
  const byId = new Map(flow.nodes.map(n => [n.id, n]));
  const capOfNode = (n: FlowNode) => n.max_invocations ?? DEFAULT_MAX_INVOCATIONS;

  lines.push('## Available sub-agents');
  lines.push('');
  lines.push('One block per node of the flow. Two nodes can use the same agent with different caps.');
  lines.push('');
  for (const node of flow.nodes.filter(n => n.type === 'agent')) {
    const agent = snap.agents.get(node.agent_id ?? '');
    if (!agent) continue;
    lines.push(`### Node \`${node.id}\``);
    lines.push(buildAgentBlock(agent, snap, capOfNode(node)));
    lines.push('');
    lines.push('**Output shape:** produce exactly this JSON shape (not enforced in model-orchestrated mode, but rule edges below read it):');
    lines.push('```json');
    lines.push(JSON.stringify(agent.output_schema ?? DEFAULT_OUTPUT_SCHEMA, null, 2));
    lines.push('```');
    lines.push('');
    lines.push(DIVIDER);
    lines.push('');
  }

  // Topology, breadth-first from Start; unreachable nodes are not listed (the
  // flow validator refuses them).
  const start = flow.nodes.find(n => n.type === 'start')!;
  const first = byId.get(outgoing(flow, start.id)[0]!.to)!;
  lines.push('## Flow topology');
  lines.push('');
  lines.push(first.type === 'parallel'
    ? `**Entry point:** fire the fork *${nodeTitle(snap, first)}*: all of its branches.`
    : `**Entry point:** begin with node \`${first.id}\` (*${nodeTitle(snap, first)}*).`);
  lines.push('');
  let hasRules = false;
  const seen = new Set<string>([start.id]);
  const queue: FlowNode[] = [first];
  while (queue.length) {
    const node = queue.shift()!;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    const exits = outgoing(flow, node.id);
    for (const e of exits) { const t = byId.get(e.to); if (t && !seen.has(t.id)) queue.push(t); }
    if (node.type === 'end') continue;
    if (node.type === 'parallel') {
      lines.push(`- Fork \`${node.id}\`${node.label ? ` (*${node.label}*)` : ''}: run ALL of these branches, then continue at their single join node:`);
      for (const e of exits) lines.push(`    ∥ node \`${e.to}\` (*${nodeTitle(snap, byId.get(e.to)!)}*)`);
      continue;
    }
    const kind = exitKind(exits);
    lines.push(`- From node \`${node.id}\` (*${nodeTitle(snap, node)}*):`);
    if (kind === 'single') {
      lines.push(`    → ${describeTarget(flow, exits[0]!.to)} (always)`);
    } else if (kind === 'rules') {
      hasRules = true;
      let i = 1;
      for (const e of exits) {
        if (isDefaultEdge(e)) continue;
        lines.push(`    ${i++}. \`${e.id}\` → ${describeTarget(flow, e.to)} if ${describeRule(e.when!)}  rule: \`${JSON.stringify(e.when)}\``);
      }
      const def = exits.find(isDefaultEdge);
      if (def) lines.push(`    otherwise \`${def.id}\` → ${describeTarget(flow, def.to)} (default)`);
    } else {
      for (const e of exits) lines.push(`    ${describeEdgeForPrompt(flow, e)}`);
    }
  }
  lines.push('');
  if (hasRules) {
    lines.push('**How to read rule edges:** evaluate them on the JSON output of the node that just ran, in the order listed; the first rule that holds wins, otherwise take the default. `path` is a dot path into the output (`.length` reads an array or string length). `eq`/`ne` compare exact values (`ne` also holds when the path is missing); `in` means the value is one of the list; `gt`/`gte`/`lt`/`lte` compare two numbers or two strings only; `exists` is false for a missing path or null. `all` = every rule holds, `any` = at least one holds.');
    lines.push('');
  }

  lines.push('## Execution rules');
  lines.push('');
  lines.push('1. Start at the entry point. Execute one node at a time, exactly as its block says.');
  lines.push('2. After each node, take exactly ONE of its exits. Natural-language conditions are judged against that node\'s output; rule edges are evaluated as described above.');
  lines.push('3. The default exit is taken only when no other exit applies.');
  lines.push('4. Edges back to an earlier node are legitimate loops.');
  lines.push('5. **Caps:** count how many times you run each node. If the routing sends you to a node that already reached its maximum, stop and report which cap was hit.');
  lines.push('6. **Forks:** at a fork, run every branch (ideally one sub-agent per branch, in parallel), wait for all of them, then continue at the join node.');
  lines.push('7. A run completes only at an End node; if you stop earlier (cap, or you cannot choose), say why in the report.');
  lines.push('8. Never invent agents or steps, and never skip a node the routing sends you to.');
  lines.push('9. If you genuinely cannot choose between exits, stop and ask the user rather than guessing.');
  lines.push('');

  const ends = flow.nodes.filter(n => n.type === 'end');
  if (ends.length > 0) {
    lines.push('## Possible workflow outcomes');
    lines.push('');
    for (const e of ends) lines.push(`- ${e.outcome || '(unlabelled End)'}`);
    lines.push('');
  }

  lines.push('## Mandatory report');
  lines.push('');
  lines.push('When the workflow ends (at an End, at a cap, or because you stopped) you MUST call `workflow.report`. The run stays open until you do. Use agent names exactly as they appear above. The server stores the report as self-declared: it does not verify it.');
  lines.push('```json');
  lines.push(JSON.stringify({
    runId,
    report: {
      path: ['agent_name_1', 'agent_name_2'],
      invocations_per_agent: { agent_name_1: 1, agent_name_2: 1 },
      branches_taken: { agent_name_1: '<edge id taken>' },
      ended_at: 'End: <outcome>',
      final_summary: '...',
      findings: [],
    },
  }, null, 2));
  lines.push('```');
}

// Per agent name, the most invocations the flow allows (sum of the caps of
// every node that uses it). Clamps self-declared usage.
export function maxInvocationsByAgentName(snap: RunSnapshot): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of snap.flow.nodes) {
    if (n.type !== 'agent') continue;
    const name = snap.agents.get(n.agent_id ?? '')?.name ?? n.agent_name;
    if (!name) continue;
    out.set(name, (out.get(name) ?? 0) + (n.max_invocations ?? DEFAULT_MAX_INVOCATIONS));
  }
  return out;
}
