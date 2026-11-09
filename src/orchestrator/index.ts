import db from '../db/client';
import { Agent, FlowDocument, FlowEdge, FlowNode, FlowNodeType } from '../db/schema';
import { AgentInfo, describeRule, validateFlow } from '../shared/flow';
import { renderFilesToLines } from '../lib/entityFiles';
import { parseStoredSchema } from '../lib/outputSchema';
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
