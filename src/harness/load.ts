// Load and validate a harness directory. No database access: everything that
// can be checked from the files alone is checked here, with the same
// validators the server uses (flow graph, output schemas, eval criteria).
//
// Layout:
//   harness.json                       projects, flows, evals, entity metadata
//   agents/<name>/AGENT.md             entry file (+ any supporting files)
//   agents/<name>/output.schema.json   the agent's output contract (optional)
//   skills/<name>/SKILL.md             (+ supporting files)
//   contexts/<name>/CONTEXT.md         (+ supporting files)
//
// JSON files may contain {"$include": "<relative path>"}; it is replaced by the
// JSON of that file (resolved relative to the file that contains it).
import fs from 'fs';
import path from 'path';
import { AgentInfo, FlowDocument, validateFlow } from '../shared/flow';
import { checkOutputSchema } from '../lib/outputSchema';
import { checkCriteria } from '../lib/evalGrading';
import { FILENAME_RE } from '../lib/entityFiles';
import { normalizeToolList } from '../lib/mcpServers';
import { normalizeFlow } from '../orchestrator';
import { ajv, formatAjvErrors } from '../mcp/validation';

export interface HarnessFile { name: string; description: string; content: string; is_entry: number }

export interface HarnessEntity {
  name: string;
  description: string;
  files: HarnessFile[];
}

export interface HarnessAgent extends HarnessEntity {
  output_schema: Record<string, unknown> | null;
  skills: string[];
  allowed_tools: string[];
}

export interface HarnessEval {
  name: string;
  input: Record<string, unknown>;
  expected_outcome: string;
  must_complete_agents: string[];
  expected_findings: Record<string, unknown>[];
  max_extra_findings: number | null;
}

export interface HarnessProject {
  name: string;
  description: string;
  input_schema: Record<string, unknown> | null;
  execution_mode: 'verified' | 'compiled' | null;  // null = not declared: apply leaves the owner's setting alone
  contexts: string[];
  agents: string[];            // agents the flow uses
  flow: FlowDocument;          // node.agent_id holds the agent NAME until apply
  evals: HarnessEval[];
}

export interface Harness {
  name: string;
  dir: string;
  agents: Map<string, HarnessAgent>;
  skills: Map<string, HarnessEntity>;
  contexts: Map<string, HarnessEntity>;
  projects: HarnessProject[];
}

export class HarnessError extends Error {
  constructor(public problems: string[]) { super(problems.join('\n')); }
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function readJson(file: string, problems: string[], depth = 0): unknown {
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { problems.push(`${file}: ${(err as Error).message}`); return null; }
  return resolveIncludes(value, path.dirname(file), problems, depth);
}

function resolveIncludes(v: unknown, base: string, problems: string[], depth: number): unknown {
  if (Array.isArray(v)) return v.map(x => resolveIncludes(x, base, problems, depth));
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  if (typeof o.$include === 'string' && Object.keys(o).length === 1) {
    if (depth > 8) { problems.push(`${base}: $include nested too deeply`); return null; }
    return readJson(path.resolve(base, o.$include), problems, depth + 1);
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) out[k] = resolveIncludes(x, base, problems, depth);
  return out;
}

// Read every file of an entity directory. The entry file goes first.
function readEntityFiles(dir: string, entryName: string, problems: string[], skip: string[] = []): HarnessFile[] {
  if (!fs.existsSync(dir)) { problems.push(`${dir}: missing directory`); return []; }
  const files: HarnessFile[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (skip.includes(name) || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (!fs.statSync(full).isFile()) { problems.push(`${full}: subdirectories are not supported`); continue; }
    if (!FILENAME_RE.test(name)) { problems.push(`${full}: invalid file name`); continue; }
    files.push({ name, description: '', content: fs.readFileSync(full, 'utf8'), is_entry: name === entryName ? 1 : 0 });
  }
  if (!files.some(f => f.is_entry)) problems.push(`${dir}: ${entryName} is required`);
  return files.sort((a, b) => b.is_entry - a.is_entry);
}

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function loadHarness(dirArg: string): Harness {
  const dir = path.resolve(dirArg);
  const problems: string[] = [];
  const doc = readJson(path.join(dir, 'harness.json'), problems) as Record<string, any> | null;
  if (!doc) throw new HarnessError(problems);

  const schemas = new Map<string, Record<string, unknown>>();
  for (const [key, rel] of Object.entries((doc.schemas ?? {}) as Record<string, string>)) {
    const s = readJson(path.join(dir, rel), problems) as Record<string, unknown> | null;
    if (s) schemas.set(key, s);
  }

  const loadGroup = (key: 'skills' | 'contexts', entry: string): Map<string, HarnessEntity> => {
    const out = new Map<string, HarnessEntity>();
    for (const [name, meta] of Object.entries((doc[key] ?? {}) as Record<string, { description?: string }>)) {
      if (!NAME_RE.test(name)) { problems.push(`${key}.${name}: names are lowercase letters, digits and "-"`); continue; }
      out.set(name, { name, description: String(meta?.description ?? ''), files: readEntityFiles(path.join(dir, key, name), entry, problems) });
    }
    return out;
  };
  const skills = loadGroup('skills', 'SKILL.md');
  const contexts = loadGroup('contexts', 'CONTEXT.md');

  const agents = new Map<string, HarnessAgent>();
  for (const [name, meta] of Object.entries((doc.agents ?? {}) as Record<string, { description?: string; skills?: unknown; allowed_tools?: unknown }>)) {
    if (!NAME_RE.test(name)) { problems.push(`agents.${name}: names are lowercase letters, digits and "-"`); continue; }
    const adir = path.join(dir, 'agents', name);
    const schemaFile = path.join(adir, 'output.schema.json');
    let output_schema: Record<string, unknown> | null = null;
    if (fs.existsSync(schemaFile)) {
      output_schema = readJson(schemaFile, problems) as Record<string, unknown> | null;
      const err = output_schema ? checkOutputSchema(output_schema) : null;
      if (err) problems.push(`${schemaFile}: ${err}`);
    }
    const agentSkills = asStrings(meta?.skills);
    for (const s of agentSkills) if (!skills.has(s)) problems.push(`agents.${name}: unknown skill "${s}"`);
    const tools = normalizeToolList(meta?.allowed_tools);
    if (!tools.ok) problems.push(`agents.${name}: ${tools.error}`);
    if (!meta?.description) problems.push(`agents.${name}: description is required`);
    agents.set(name, {
      name, description: String(meta?.description ?? ''), output_schema,
      skills: agentSkills, allowed_tools: tools.ok ? tools.value : [],
      files: readEntityFiles(adir, 'AGENT.md', problems, ['output.schema.json']),
    });
  }

  const projects: HarnessProject[] = [];
  const seenProjects = new Set<string>();
  for (const [i, p] of ((doc.projects ?? []) as Record<string, any>[]).entries()) {
    const where = `projects[${i}]${p?.name ? ` (${p.name})` : ''}`;
    const name = String(p?.name ?? '');
    if (!name) { problems.push(`${where}: name is required`); continue; }
    if (seenProjects.has(name)) problems.push(`${where}: duplicate project name`);
    seenProjects.add(name);

    let input_schema: Record<string, unknown> | null = null;
    if (typeof p.input_schema === 'string') {
      input_schema = schemas.get(p.input_schema) ?? null;
      if (!input_schema) problems.push(`${where}: unknown schema "${p.input_schema}"`);
    } else if (p.input_schema && typeof p.input_schema === 'object') input_schema = p.input_schema;
    if (input_schema) { const err = checkOutputSchema(input_schema); if (err) problems.push(`${where}: input schema: ${err.replace('output_schema', 'schema')}`); }

    let execution_mode: HarnessProject['execution_mode'] = null;
    if (p.execution_mode !== undefined) {
      if (p.execution_mode === 'verified' || p.execution_mode === 'compiled') execution_mode = p.execution_mode;
      else problems.push(`${where}: execution_mode must be "verified" or "compiled"`);
    }

    const ctx = asStrings(p.contexts);
    for (const c of ctx) if (!contexts.has(c)) problems.push(`${where}: unknown context "${c}"`);

    // Nodes name their agent with "agent"; validate with the real validator.
    const rawNodes = ((p.flow?.nodes ?? []) as Record<string, unknown>[]).map(n => ({ x: 0, y: 0, ...n, ...(n.type === 'agent' ? { agent_id: String(n.agent ?? ''), agent_name: String(n.agent ?? '') } : {}) }));
    const flow = normalizeFlow({ nodes: rawNodes, edges: p.flow?.edges ?? [] });
    const used = [...new Set(flow.nodes.filter(n => n.type === 'agent').map(n => n.agent_id!))];
    const info = new Map<string, AgentInfo>([...agents.values()].map(a => [a.name, { name: a.name, hasOutputSchema: !!a.output_schema }]));
    for (const err of validateFlow(flow, info)) problems.push(`${where} flow: ${err}`);

    const evals: HarnessEval[] = [];
    const seenEvals = new Set<string>();
    for (const [j, e] of ((p.evals ?? []) as Record<string, any>[]).entries()) {
      const ew = `${where} evals[${j}]${e?.name ? ` (${e.name})` : ''}`;
      if (!e?.name) { problems.push(`${ew}: name is required`); continue; }
      if (seenEvals.has(e.name)) problems.push(`${ew}: duplicate eval name`);
      seenEvals.add(e.name);
      if (!e.input || typeof e.input !== 'object' || Array.isArray(e.input)) problems.push(`${ew}: input must be an object`);
      else if (input_schema) {
        const check = ajv.compile(input_schema);
        if (!check(e.input)) problems.push(`${ew}: input does not match the project's input schema: ${formatAjvErrors(check.errors)}`);
      }
      const err = checkCriteria(e);
      if (err) problems.push(`${ew}: ${err}`);
      for (const a of asStrings(e.must_complete_agents)) if (!used.includes(a)) problems.push(`${ew}: must_complete_agents names "${a}", which is not in this flow`);
      const ends = flow.nodes.filter(n => n.type === 'end').map(n => n.outcome ?? '');
      if (e.expected_outcome && !ends.includes(e.expected_outcome)) problems.push(`${ew}: expected_outcome "${e.expected_outcome}" is not an End of this flow`);
      evals.push({
        name: e.name, input: e.input ?? {}, expected_outcome: String(e.expected_outcome ?? ''),
        must_complete_agents: asStrings(e.must_complete_agents), expected_findings: Array.isArray(e.expected_findings) ? e.expected_findings : [],
        max_extra_findings: e.max_extra_findings ?? null,
      });
    }
    projects.push({ name, description: String(p.description ?? ''), input_schema, execution_mode, contexts: ctx, agents: used, flow, evals });
  }

  if (problems.length) throw new HarnessError(problems);
  return { name: String(doc.name ?? path.basename(dir)), dir, agents, skills, contexts, projects };
}
