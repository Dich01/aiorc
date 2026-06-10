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
    errors.push('El flujo no tiene nodo Start. Agregá uno desde la toolbar.');
  } else if (startNodes.length > 1) {
    errors.push(`El flujo tiene ${startNodes.length} nodos Start. Solo puede haber uno.`);
  }

  // Rule 1 cont: Start must have exactly 1 outgoing edge, 0 incoming
  for (const start of startNodes) {
    const incoming = edges.filter(e => e.to === start.id);
    const outgoing = edges.filter(e => e.from === start.id);
    if (incoming.length > 0) {
      errors.push(`El nodo Start no puede tener aristas entrantes.`);
    }
    if (outgoing.length === 0) {
      errors.push(`El nodo Start tiene que conectarse al primer agente.`);
    }
    if (outgoing.length > 1) {
      errors.push(`El nodo Start tiene ${outgoing.length} aristas salientes. Solo puede tener una.`);
    }
  }

  // Rule 2: End has 0 outgoing edges
  for (const end of endNodes) {
    const outgoing = edges.filter(e => e.from === end.id);
    if (outgoing.length > 0) {
      const label = end.outcome ? `End "${end.outcome}"` : `End ${end.id}`;
      errors.push(`El nodo ${label} no puede tener aristas salientes.`);
    }
  }

  // Rule 3: agent nodes reference real agents
  for (const node of agentNodes) {
    if (!node.agent_id) {
      errors.push(`Nodo agente ${node.id} no tiene agent_id.`);
    } else if (!agentsById.has(node.agent_id)) {
      errors.push(`Nodo agente ${node.id} referencia un agente que no existe (${node.agent_id}).`);
    }
  }

  // Rule 4: edges reference real nodes
  for (const edge of edges) {
    if (!nodeIds.has(edge.from)) {
      errors.push(`Arista ${edge.id}: nodo origen (${edge.from}) no existe.`);
    }
    if (!nodeIds.has(edge.to)) {
      errors.push(`Arista ${edge.id}: nodo destino (${edge.to}) no existe.`);
    }
  }

  // Rule 5: parallel nodes need ≥1 incoming and ≥2 outgoing
  for (const par of parallelNodes) {
    const incoming = edges.filter(e => e.to === par.id);
    const outgoing = edges.filter(e => e.from === par.id);
    const label = par.label ? `Parallel "${par.label}"` : `Parallel ${par.id}`;
    if (incoming.length === 0) {
      errors.push(`El nodo ${label} no tiene aristas entrantes.`);
    }
    if (outgoing.length < 2) {
      errors.push(`El nodo ${label} tiene ${outgoing.length} arista(s) saliente(s). Un nodo Parallel necesita al menos 2 (es un fork).`);
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
  lines.push(`### Agente: ${agent.name}`);
  lines.push(`**Máximo de invocaciones:** ${maxInvocations}`);
  if (agent.description) lines.push(`**Descripción:** ${agent.description}`);
  if (agent.expected_output_format) {
    lines.push(`**Formato de output esperado:** ${agent.expected_output_format}`);
  }
  if (skills.length > 0) {
    lines.push(`**Skills aplicadas (consultá la sección "Skills" del prompt arriba para las reglas completas):**`);
    for (const skill of skills) {
      lines.push(`- *${skill.name}*: ${skill.description}`);
    }
  }
  // Agent instructions = entry file (AGENT.md) + supporting files. Non-markdown
  // files (scripts/configs) are emitted in code fences so the agent can use them.
  const files = loadEntityFiles(agent.id, AGENT_FILES);
  const hasFileContent = files.some(f => f.content && f.content.trim());
  if (hasFileContent) {
    lines.push(`**Instrucciones del agente:**`);
    renderFilesToLines(files, lines);
  } else if (agent.content && agent.content.trim()) {
    lines.push(`**Instrucciones del agente:**`);
    lines.push(agent.content.trim());
  }
  if (skills.length > 0) {
    lines.push('');
    lines.push(`**Verificación obligatoria:** antes de continuar, releé tu output y confirmá explícitamente que cumple cada skill aplicada arriba — incluyendo las reglas detalladas en la sección "Skills". Si no cumple, corregilo antes de pasar al siguiente paso.`);
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
  lines.push('## Contexto del proyecto');
  lines.push('');
  lines.push('Documentación y conocimiento del negocio que aplica a TODO el flujo. Leelo antes de actuar y mantenelo en mente al razonar sobre cada paso.');
  lines.push('');
  for (const ctx of contexts) {
    lines.push(`### Contexto: ${ctx.name}`);
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
  lines.push('## Skills (reglas obligatorias — consultalas antes y durante la invocación de cada agente)');
  lines.push('');
  lines.push('Cada agente declara qué skills aplica. Antes de actuar, leé las reglas de los skills declarados por el agente que estás invocando y validá tu output contra ellas. Una skill puede tener varios archivos: el primero (SKILL.md) es la entrada principal y los demás son material de soporte que la entrada puede referenciar por nombre. Los archivos de soporte pueden ser documentación o recursos ejecutables (scripts `.sh`, configs `.json`/`.yaml`, etc.); cuando un archivo viene en un bloque de código, usalo tal cual — es un recurso que la skill provee para que lo ejecutes o lo apliques.');
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
      workflow: 'No hay flujo configurado para este proyecto. Configurá el flow en el dashboard de AIOrc.',
      error: 'no_flow'
    };
  }

  const flow = normalizeFlow(JSON.parse(flowRecord.flow_json));

  if (flow.nodes.length === 0) {
    return {
      runId, nodeCount: 0, agentNames: [],
      workflow: 'El flujo está vacío. Agregá nodos en el flow builder.',
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
  lines.push('# AIOrc — Workflow Multi-Agente');
  lines.push('');
  lines.push('Sos el orquestador. Tenés disponibles los siguientes sub-agentes y una topología recomendada para invocarlos. Seguí la topología como guía; las condiciones en las aristas son hints en lenguaje natural — interpretalas con criterio.');
  lines.push('');

  if (input && Object.keys(input).length > 0) {
    lines.push('## Input del usuario');
    lines.push('```json');
    lines.push(JSON.stringify(input, null, 2));
    lines.push('```');
    lines.push('');
  }

  renderContextsSection(projectId, lines);
  renderSkillsSection(agents, lines);

  lines.push('## Sub-agentes disponibles');
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
  lines.push('## Topología del flujo');
  lines.push('');

  function nodeLabel(n: FlowNode): string {
    if (n.type === 'agent') return agentsById.get(n.agent_id!)?.name ?? n.agent_name ?? n.id;
    if (n.type === 'end') return n.outcome ? `🏁 End: "${n.outcome}"` : `🏁 End`;
    if (n.type === 'start') return '🟢 Start';
    if (n.type === 'parallel') return n.label ? `⫲ Parallel: "${n.label}"` : `⫲ Parallel`;
    return n.id;
  }

  const startNode = flow.nodes.find(n => n.type === 'start');
  const startEdge = startNode ? flow.edges.find(e => e.from === startNode.id) : null;
  const startTarget = startEdge ? flow.nodes.find(n => n.id === startEdge.to) : null;
  const startTargetLabel = startTarget ? nodeLabel(startTarget) : '(sin destino)';
  const startVerb = startTarget?.type === 'parallel'
    ? `dispará el fork *${startTargetLabel}* (todas sus ramas en paralelo).`
    : `comenzá invocando al sub-agente *${startTargetLabel}*.`;

  lines.push(`**Punto de entrada (Start):** ${startVerb}`);
  lines.push('');
  lines.push(`**Aristas (transiciones permitidas):**`);
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
      lines.push(`- *${fromLabel}* — sin aristas salientes (terminal: si llegás acá, terminás el workflow)`);
    } else if (node.type === 'parallel') {
      lines.push(`- Desde *${fromLabel}* (FORK — ejecutá TODAS las ramas siguientes en paralelo y esperá a que terminen antes de continuar):`);
      for (const eo of edgesOut) {
        const targetNode = flow.nodes.find(x => x.id === eo.to);
        const targetLabel = targetNode ? nodeLabel(targetNode) : eo.to;
        lines.push(`    ∥ → *${targetLabel}*`);
      }
    } else {
      lines.push(`- Desde *${fromLabel}*:`);
      for (const eo of edgesOut) {
        const targetNode = flow.nodes.find(x => x.id === eo.to);
        const targetLabel = targetNode ? nodeLabel(targetNode) : eo.to;
        const cond = eo.condition ? ` *cuando:* ${eo.condition}` : ' *(sin condición — fallback)*';
        lines.push(`    → *${targetLabel}*${cond}`);
      }
    }
  }

  lines.push('');
  lines.push('## Reglas de ejecución');
  lines.push('');
  lines.push(`1. Empezá por el punto de entrada (Start). El primer agente a invocar es el destino de la arista que sale de Start.`);
  lines.push(`2. Después de cada agente, evaluá las condiciones de sus aristas salientes y elegí UNA sola transición.`);
  lines.push(`3. Las condiciones son lenguaje natural — interpretalas según el output del agente anterior.`);
  lines.push(`4. Si una arista no tiene condición, es la transición default (fallback) cuando ninguna otra coincide.`);
  lines.push(`5. Si TODAS las aristas tienen condición y NINGUNA coincide, terminá el workflow exitosamente.`);
  lines.push(`6. Las aristas hacia un agente anterior son legítimas — implementan loops/reintentos.`);
  lines.push(`7. **Cap por agente:** llevá la cuenta de cuántas veces invocaste cada agente. Si llegás a su máximo y la topología te quiere mandar de nuevo a él, cortá el flujo y reportá al usuario.`);
  lines.push(`8. **Nodos Parallel (⫲):** cuando la topología te lleva a un nodo Parallel, NO elijás una rama — disparás TODAS las ramas concurrentemente. Idealmente, en una misma respuesta del LLM emití una llamada a la Agent tool por rama (\`subagent_type: "general-purpose"\` con la prescripción del agente correspondiente embebida en el prompt) para que corran con context windows separados en paralelo real. Si no es viable, ejecutá las prescripciones de las ramas de forma secuencial sin elegir — todas se ejecutan. Esperá a que TODAS las ramas terminen y consolidá sus outputs antes de avanzar al nodo común downstream. El cap por agente sigue aplicando dentro de cada rama.`);
  lines.push(`9. Si llegás a un nodo End, terminá el workflow y reportá su outcome (si tiene).`);
  lines.push(`10. Si llegás a un agente sin aristas salientes, terminá el workflow.`);
  lines.push(`11. Si no podés decidir entre varias transiciones (ambigüedad real), parar y consultar al usuario.`);
  lines.push('');

  // List the End nodes for clarity
  const ends = flow.nodes.filter(n => n.type === 'end');
  if (ends.length > 0) {
    lines.push('## Outcomes posibles del workflow');
    lines.push('');
    for (const end of ends) {
      const outcomeText = end.outcome ?? '(sin etiqueta)';
      lines.push(`- ${outcomeText}`);
    }
    lines.push('');
  }

  // Mandatory report — the audit trail that powers usage analytics and
  // skip detection. A run without a report can't be verified.
  lines.push('## Reporte obligatorio');
  lines.push('');
  lines.push('Cuando el workflow termine (por éxito, error o corte), llamá SIEMPRE a `workflow.report`. El workflow NO está completo hasta que lo hagas. Usá exactamente los nombres de agente tal como aparecen en este prompt:');
  lines.push('```json');
  lines.push(JSON.stringify({
    runId,
    report: {
      path: ['agent_name_1', 'agent_name_2'],
      invocations_per_agent: { 'agent_name_1': 1, 'agent_name_2': 3 },
      branches_taken: { 'agent_name_1': 'condición que se cumplió' },
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
