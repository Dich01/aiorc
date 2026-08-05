import { v4 as uuidv4 } from 'uuid';
import db from '../db/client';
import { Agent, FlowNode, FlowEdge, FlowDocument, FlowNodeType, Skill, Context } from '../db/schema';
import { loadEntityFiles, renderFilesToLines, SKILL_FILES, AGENT_FILES, CONTEXT_FILES } from '../lib/entityFiles';
import { recordPlannedUsage } from '../lib/usage';

// ── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_INVOCATIONS = 10;
const MAX_MAX_INVOCATIONS = 50;
const DIVIDER = '━'.repeat(56);

// ── Validation ──────────────────────────────────────────────────────────────
//
// Structural rules:
//   1. Exactly 1 Start node (with 0 incoming edges, 1 outgoing edge).
//   2. Every End node has 0 outgoing edges.
//   3. Every Agent node references an agent that exists in the project.
//   4. Every edge connects two existing nodes.
//   5. Every Parallel node has ≥1 incoming edge and ≥2 outgoing edges (fork).

export function validateFlow(
  nodes: FlowNode[],
  edges: FlowEdge[],
  agentsById: Map<string, Agent>
): string[] {
  const errors: string[] = [];

  if (nodes.length === 0) return [];

  const nodeIds = new Set(nodes.map(n => n.id));
  const startNodes = nodes.filter(n => n.type === 'start');
  const endNodes = nodes.filter(n => n.type === 'end');
  const agentNodes = nodes.filter(n => n.type === 'agent');
  const parallelNodes = nodes.filter(n => n.type === 'parallel');

  // Rule 1: exactly 1 Start
  if (startNodes.length === 0) {
    errors.push('The flow has no Start node. Add one from the toolbar and connect it to the first agent.');
  } else if (startNodes.length > 1) {
    errors.push(`The flow has ${startNodes.length} Start nodes. Delete all but one — a flow has a single entry point.`);
  }

  // Rule 1 cont: Start must have exactly 1 outgoing edge, 0 incoming
  for (const start of startNodes) {
    const incoming = edges.filter(e => e.to === start.id);
    const outgoing = edges.filter(e => e.from === start.id);
    if (incoming.length > 0) {
      errors.push(`The Start node cannot have incoming edges. Remove the edges pointing at it.`);
    }
    if (outgoing.length === 0) {
      errors.push(`The Start node must connect to the first agent. Draw an edge from Start to the agent the flow begins with.`);
    }
    if (outgoing.length > 1) {
      errors.push(`The Start node has ${outgoing.length} outgoing edges and may only have one. To fan out at the beginning, point Start at a Parallel node instead.`);
    }
  }

  // Rule 2: End has 0 outgoing edges
  for (const end of endNodes) {
    const outgoing = edges.filter(e => e.from === end.id);
    if (outgoing.length > 0) {
      const label = end.outcome ? `End "${end.outcome}"` : `End ${end.id}`;
      errors.push(`${label} cannot have outgoing edges — End terminates the flow. Remove them, or point them at an agent instead.`);
    }
  }

  // Rule 3: agent nodes reference real agents
  for (const node of agentNodes) {
    if (!node.agent_id) {
      errors.push(`Agent node ${node.id} has no agent assigned. Open the node and pick an agent, or delete the node.`);
    } else if (!agentsById.has(node.agent_id)) {
      errors.push(`Agent node ${node.id} references an agent that no longer exists (${node.agent_id}). Reassign the node to an existing agent, or delete it.`);
    }
  }

  // Rule 4: edges reference real nodes
  for (const edge of edges) {
    if (!nodeIds.has(edge.from)) {
      errors.push(`Edge ${edge.id} starts at a node that does not exist (${edge.from}). Delete the edge.`);
    }
    if (!nodeIds.has(edge.to)) {
      errors.push(`Edge ${edge.id} points at a node that does not exist (${edge.to}). Delete the edge.`);
    }
  }

  // Rule 5: parallel nodes need ≥1 incoming and ≥2 outgoing
  for (const par of parallelNodes) {
    const incoming = edges.filter(e => e.to === par.id);
    const outgoing = edges.filter(e => e.from === par.id);
    const label = par.label ? `Parallel "${par.label}"` : `Parallel ${par.id}`;
    if (incoming.length === 0) {
      errors.push(`${label} has no incoming edges, so it can never be reached. Connect an agent or Start to it, or delete it.`);
    }
    if (outgoing.length < 2) {
      errors.push(`${label} has ${outgoing.length} outgoing edge(s). A Parallel node is a fork and needs at least 2 — add another branch, or replace it with a direct edge.`);
    }
  }

  return errors;
}

// ── Normalizer ──────────────────────────────────────────────────────────────

function clampMaxInvocations(n: unknown): number {
  if (typeof n !== 'number' || !isFinite(n) || n < 1) return DEFAULT_MAX_INVOCATIONS;
  return Math.min(MAX_MAX_INVOCATIONS, Math.floor(n));
}

export function normalizeFlow(raw: unknown): FlowDocument {
  const r = (raw ?? {}) as { nodes?: unknown[]; edges?: unknown[] };
  const nodes: FlowNode[] = (r.nodes ?? []).map((n) => {
    const node = n as Record<string, unknown>;
    const type = (node.type as FlowNodeType) ?? 'agent';
    const result: FlowNode = {
      id: String(node.id ?? ''),
      type,
      x: Number(node.x ?? 0),
      y: Number(node.y ?? 0),
    };
    if (type === 'agent') {
      result.agent_id = String(node.agent_id ?? '');
      result.agent_name = typeof node.agent_name === 'string' ? node.agent_name : undefined;
      result.max_invocations = clampMaxInvocations(node.max_invocations);
    }
    if (type === 'end') {
      result.outcome = typeof node.outcome === 'string' ? node.outcome : undefined;
    }
    if (type === 'parallel') {
      result.label = typeof node.label === 'string' ? node.label : undefined;
    }
    return result;
  }).filter(n => n.id);

  const edges: FlowEdge[] = (r.edges ?? []).map((e) => {
    const edge = e as Record<string, unknown>;
    return {
      id: String(edge.id ?? ''),
      from: String(edge.from ?? ''),
      to: String(edge.to ?? ''),
      condition: typeof edge.condition === 'string' && edge.condition.trim() ? edge.condition : undefined,
      priority: typeof edge.priority === 'number' ? edge.priority : 1000,
    };
  }).filter(e => e.id && e.from && e.to);

  return { nodes, edges };
}

// ── Agent description helpers ───────────────────────────────────────────────

function loadSkillsForAgent(agentId: string): Skill[] {
  return db.prepare(
    `SELECT s.* FROM agent_skills ag
     JOIN skills s ON s.id = ag.skill_id
     WHERE ag.agent_id = ?
     ORDER BY ag.ordinal ASC`
  ).all(agentId) as Skill[];
}

export function buildAgentBlock(agent: Agent, maxInvocations: number): string {
  const skills = loadSkillsForAgent(agent.id);
  const lines: string[] = [];
  lines.push(`### Agent: ${agent.name}`);
  lines.push(`**Maximum invocations:** ${maxInvocations}`);
  if (agent.description) lines.push(`**Description:** ${agent.description}`);
  if (agent.expected_output_format) {
    lines.push(`**Expected output format:** ${agent.expected_output_format}`);
  }
  if (skills.length > 0) {
    lines.push(`**Skills that apply (see the "Skills" section above for the full rules):**`);
    for (const skill of skills) {
      lines.push(`- *${skill.name}*: ${skill.description}`);
    }
  }
  // Agent instructions = entry file (AGENT.md) + supporting files. Non-markdown
  // files (scripts/configs) are emitted in code fences so the agent can use them.
  const files = loadEntityFiles(agent.id, AGENT_FILES);
  const hasFileContent = files.some(f => f.content && f.content.trim());
  if (hasFileContent) {
    lines.push(`**Agent instructions:**`);
    renderFilesToLines(files, lines);
  } else if (agent.content && agent.content.trim()) {
    lines.push(`**Agent instructions:**`);
    lines.push(agent.content.trim());
  }
  if (skills.length > 0) {
    lines.push('');
    lines.push(`**Mandatory self-check:** before moving on, re-read your output and state explicitly that it satisfies every skill listed above, including the detailed rules in the "Skills" section. If it does not, fix it before taking the next step.`);
  }
  return lines.join('\n');
}

// ── Shared prompt sections (used by compileFlow and the stepped engine) ─────

// Project-level contexts: business knowledge ALL agents in the project see.
export function renderContextsSection(projectId: string, lines: string[]): void {
  const contexts = db.prepare(
    `SELECT c.* FROM project_contexts pc
     JOIN contexts c ON c.id = pc.context_id
     WHERE pc.project_id = ?
     ORDER BY c.name ASC`
  ).all(projectId) as Context[];

  if (contexts.length === 0) return;
  lines.push('## Project context');
  lines.push('');
  lines.push('Documentation and business knowledge that applies to the WHOLE flow. Read it before acting and keep it in mind when reasoning about each step.');
  lines.push('');
  for (const ctx of contexts) {
    lines.push(`### Context: ${ctx.name}`);
    if (ctx.description) {
      lines.push(`*${ctx.description}*`);
      lines.push('');
    }
    // Entry file (CONTEXT.md) + supporting files; non-markdown files in code fences.
    const files = loadEntityFiles(ctx.id, CONTEXT_FILES);
    if (files.some(f => f.content && f.content.trim())) {
      renderFilesToLines(files, lines);
    } else if (ctx.content && ctx.content.trim()) {
      lines.push(ctx.content.trim());
      lines.push('');
    }
    lines.push(DIVIDER);
    lines.push('');
  }
}

// Hoist unique skills referenced by the given agents into one deduplicated
// section — skills are shared across agents, emitting per-agent would multiply
// token cost. Agent blocks reference this section by name.
export function renderSkillsSection(agents: Agent[], lines: string[]): void {
  const skillsById = new Map<string, Skill>();
  for (const agent of agents) {
    for (const s of loadSkillsForAgent(agent.id)) {
      if (!skillsById.has(s.id)) skillsById.set(s.id, s);
    }
  }

  if (skillsById.size === 0) return;
  lines.push('## Skills (mandatory rules — consult them before and during every agent invocation)');
  lines.push('');
  lines.push('Each agent declares which skills it applies. Before acting, read the rules of the skills declared by the agent you are invoking and validate your output against them. A skill can have several files: the first (SKILL.md) is the entry point and the rest are supporting material the entry point may reference by name. Supporting files can be documentation or executable resources (`.sh` scripts, `.json`/`.yaml` configs, and so on); when a file arrives in a code fence, use it as-is — it is a resource the skill provides for you to run or apply.');
  lines.push('');
  for (const skill of skillsById.values()) {
    lines.push(`### Skill: ${skill.name}`);
    if (skill.description) {
      lines.push(`*${skill.description}*`);
      lines.push('');
    }
    renderFilesToLines(loadEntityFiles(skill.id, SKILL_FILES), lines);
    lines.push(DIVIDER);
    lines.push('');
  }
}

// ── Compile ─────────────────────────────────────────────────────────────────

export interface CompileResult {
  runId: string;
  workflow: string;
  nodeCount: number;
  agentNames: string[];
  error?: string;
}

export function compileFlow(
  projectId: string,
  input: Record<string, unknown>,
  callerEmail = ''
): CompileResult {
  const runId = uuidv4();

  const flowRecord = db.prepare(
    'SELECT flow_json FROM project_flows WHERE project_id = ?'
  ).get(projectId) as { flow_json: string } | undefined;

  if (!flowRecord) {
    return {
      runId, nodeCount: 0, agentNames: [],
      workflow: 'This project has no flow configured. Draw one in the flow builder on the project page, then call this tool again.',
      error: 'no_flow'
    };
  }

  const flow = normalizeFlow(JSON.parse(flowRecord.flow_json));

  if (flow.nodes.length === 0) {
    return {
      runId, nodeCount: 0, agentNames: [],
      workflow: 'This project\'s flow is empty. Add a Start node and at least one agent in the flow builder, then call this tool again.',
      error: 'empty_flow'
    };
  }

  // Load referenced agents
  const agentIds = [...new Set(flow.nodes.filter(n => n.type === 'agent' && n.agent_id).map(n => n.agent_id!))];
  const agents = agentIds.length > 0
    ? db.prepare(`SELECT * FROM agents WHERE id IN (${agentIds.map(() => '?').join(',')})`).all(...agentIds) as Agent[]
    : [];
  const agentsById = new Map(agents.map(a => [a.id, a]));

  // Validate
  const errors = validateFlow(flow.nodes, flow.edges, agentsById);
  if (errors.length > 0) {
    return {
      runId, nodeCount: 0, agentNames: [],
      workflow: 'Errores de validación en el flujo:\n' + errors.map(e => `- ${e}`).join('\n'),
      error: 'invalid_flow',
    };
  }

  // Build the prompt
  const lines: string[] = [];
  lines.push('# AIOrc — multi-agent workflow');
  lines.push('');
  lines.push('You are the orchestrator. Below are the sub-agents available to you and the topology for invoking them. Follow the topology; the conditions on the edges are natural-language hints, so interpret them against the previous agent output.');
  lines.push('');

  if (input && Object.keys(input).length > 0) {
    lines.push('## User input');
    lines.push('```json');
    lines.push(JSON.stringify(input, null, 2));
    lines.push('```');
    lines.push('');
  }

  renderContextsSection(projectId, lines);
  renderSkillsSection(agents, lines);

  lines.push('## Available sub-agents');
  lines.push('');
  for (const node of flow.nodes.filter(n => n.type === 'agent')) {
    const agent = agentsById.get(node.agent_id!);
    if (!agent) continue;
    const maxInv = node.max_invocations ?? DEFAULT_MAX_INVOCATIONS;
    lines.push(buildAgentBlock(agent, maxInv));
    lines.push('');
    lines.push(DIVIDER);
    lines.push('');
  }

  // Topology
  lines.push('## Flow topology');
  lines.push('');

  function nodeLabel(n: FlowNode): string {
    if (n.type === 'agent') return agentsById.get(n.agent_id!)?.name ?? n.agent_name ?? n.id;
    if (n.type === 'end') return n.outcome ? `End: "${n.outcome}"` : `End`;
    if (n.type === 'start') return 'Start';
    if (n.type === 'parallel') return n.label ? `Parallel: "${n.label}"` : `Parallel`;
    return n.id;
  }

  const startNode = flow.nodes.find(n => n.type === 'start');
  const startEdge = startNode ? flow.edges.find(e => e.from === startNode.id) : null;
  const startTarget = startEdge ? flow.nodes.find(n => n.id === startEdge.to) : null;
  const startTargetLabel = startTarget ? nodeLabel(startTarget) : '(no target)';
  const startVerb = startTarget?.type === 'parallel'
    ? `fire the *${startTargetLabel}* fork — all of its branches, in parallel.`
    : `begin by invoking the *${startTargetLabel}* sub-agent.`;

  lines.push(`**Entry point (Start):** ${startVerb}`);
  lines.push('');
  lines.push(`**Edges (allowed transitions):**`);
  lines.push('');

  // Build outgoing adjacency
  const outgoing = new Map<string, FlowEdge[]>();
  for (const node of flow.nodes) outgoing.set(node.id, []);
  for (const edge of flow.edges) outgoing.get(edge.from)?.push(edge);

  // BFS from start to order nodes
  const visited = new Set<string>();
  const ordered: FlowNode[] = [];
  if (startNode) {
    const queue: FlowNode[] = [startNode];
    while (queue.length > 0) {
      const n = queue.shift()!;
      if (visited.has(n.id)) continue;
      visited.add(n.id);
      ordered.push(n);
      for (const eo of outgoing.get(n.id) ?? []) {
        const tn = flow.nodes.find(x => x.id === eo.to);
        if (tn && !visited.has(tn.id)) queue.push(tn);
      }
    }
  }
  for (const n of flow.nodes) if (!visited.has(n.id)) ordered.push(n);

  for (const node of ordered) {
    if (node.type === 'end') continue; // ends listed implicitly via incoming edges
    const fromLabel = nodeLabel(node);
    const edgesOut = (outgoing.get(node.id) ?? []).slice().sort((a, b) => (a.priority ?? 1000) - (b.priority ?? 1000));
    if (edgesOut.length === 0 && node.type !== 'start') {
      lines.push(`- *${fromLabel}* — no outgoing edges (terminal: if you reach it, end the workflow)`);
    } else if (node.type === 'parallel') {
      lines.push(`- From *${fromLabel}* (FORK — run ALL of the branches below in parallel and wait for them to finish before continuing):`);
      for (const eo of edgesOut) {
        const targetNode = flow.nodes.find(x => x.id === eo.to);
        const targetLabel = targetNode ? nodeLabel(targetNode) : eo.to;
        lines.push(`    ∥ → *${targetLabel}*`);
      }
    } else {
      lines.push(`- From *${fromLabel}*:`);
      for (const eo of edgesOut) {
        const targetNode = flow.nodes.find(x => x.id === eo.to);
        const targetLabel = targetNode ? nodeLabel(targetNode) : eo.to;
        const cond = eo.condition ? ` *when:* ${eo.condition}` : ' *(no condition — fallback)*';
        lines.push(`    → *${targetLabel}*${cond}`);
      }
    }
  }

  lines.push('');
  lines.push('## Execution rules');
  lines.push('');
  lines.push(`1. Begin at the entry point (Start). The first agent to invoke is the target of the edge leaving Start.`);
  lines.push(`2. After each agent, evaluate the conditions on its outgoing edges and take exactly ONE transition.`);
  lines.push(`3. Conditions are natural language. Interpret them against the output of the agent that just ran.`);
  lines.push(`4. An edge with no condition is the fallback: take it when no other condition matches.`);
  lines.push(`5. If EVERY edge has a condition and NONE matches, end the workflow successfully.`);
  lines.push(`6. Edges pointing back to an earlier agent are legitimate: they implement loops and retries.`);
  lines.push(`7. **Per-agent cap:** keep count of how many times you invoke each agent. If an agent reaches its maximum and the topology sends you back to it, stop the flow and tell the user which cap was hit.`);
  lines.push(`8. **Parallel nodes:** when the topology leads to a Parallel node, do NOT pick a branch — you fire ALL of them concurrently. Preferably emit one Agent tool call per branch in a single response (\`subagent_type: "general-purpose"\`, with that branch's agent instructions embedded in the prompt) so each runs in its own context window and the parallelism is real. If that is not possible, execute every branch sequentially without choosing between them — all of them run either way. Wait for ALL branches to finish and consolidate their outputs before advancing to the shared node downstream. Per-agent caps still apply inside each branch.`);
  lines.push(`9. When you reach an End node, end the workflow and report its outcome if it has one.`);
  lines.push(`10. When you reach an agent with no outgoing edges, end the workflow.`);
  lines.push(`11. If you genuinely cannot choose between transitions, stop and ask the user rather than guessing.`);
  lines.push('');

  // List the End nodes for clarity
  const ends = flow.nodes.filter(n => n.type === 'end');
  if (ends.length > 0) {
    lines.push('## Possible workflow outcomes');
    lines.push('');
    for (const end of ends) {
      const outcomeText = end.outcome ?? '(unlabelled)';
      lines.push(`- ${outcomeText}`);
    }
    lines.push('');
  }

  // Mandatory report — the audit trail that powers usage analytics and
  // skip detection. A run without a report can't be verified.
  lines.push('## Mandatory report');
  lines.push('');
  lines.push('When the workflow ends — success, failure or early stop — you MUST call `workflow.report`. The workflow is not complete, and the run is not auditable, until you do. Use the agent names exactly as they appear in this prompt:');
  lines.push('```json');
  lines.push(JSON.stringify({
    runId,
    report: {
      path: ['agent_name_1', 'agent_name_2'],
      invocations_per_agent: { 'agent_name_1': 1, 'agent_name_2': 3 },
      branches_taken: { 'agent_name_1': 'the condition that matched' },
      ended_at: 'End: success',
      final_summary: '...'
    }
  }, null, 2));
  lines.push('```');

  const compiled = lines.join('\n');

  // Record run. The normalized flow is snapshotted so skip analysis replays
  // the report against the graph as it was at compile time, not as it is now.
  const agentNames = agents.map(a => a.name);
  db.prepare(
    'INSERT INTO runs (id, project_id, input, workflow_snapshot, flow_json, execution_report, caller_email, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(runId, projectId, JSON.stringify(input), compiled, JSON.stringify(flow), '', callerEmail, 'delivered', Date.now());
  recordPlannedUsage(runId, projectId, agents.map(a => ({ id: a.id, name: a.name })));

  return {
    runId,
    workflow: compiled,
    nodeCount: flow.nodes.length,
    agentNames,
  };
}
