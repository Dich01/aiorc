import db from '../db/client';
import { Agent, Context, FlowDocument, Skill } from '../db/schema';
import { loadEntityFiles, AGENT_FILES, SKILL_FILES, CONTEXT_FILES } from '../lib/entityFiles';
import { canonicalJson, sha256 } from '../lib/canonicalJson';
import { parseStoredSchema } from '../lib/outputSchema';

// Everything a run's prompts are built from, frozen at workflow.start and
// stored in run_snapshots with a SHA-256 per entity. Steps are always rendered
// from the snapshot, never from the live tables (F6).

export interface SnapFile { name: string; description: string; content: string; is_entry: number }

export interface AgentSnap {
  id: string;
  name: string;
  description: string;
  output_schema: Record<string, unknown> | null;
  allowed_tools: string[];   // external tools this agent may call ("server__tool" or "server__*")
  skill_ids: string[];
  files: SnapFile[];
}

export interface SkillSnap { id: string; name: string; description: string; files: SnapFile[] }
export interface ContextSnap { id: string; name: string; description: string; files: SnapFile[] }

export interface ProjectSnap {
  id: string;
  name: string;
  allow_executable_files: boolean;
  input_schema: Record<string, unknown> | null;
}

export interface RunSnapshot {
  flow: FlowDocument;
  project: ProjectSnap;
  agents: Map<string, AgentSnap>;
  skills: Map<string, SkillSnap>;
  contexts: ContextSnap[];
}

export interface SnapshotHash { kind: string; entity_id: string; name: string; sha256: string }

function parseToolList(raw: string): string[] {
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; } catch { return []; }
}

const files = (rows: { name: string; description: string; content: string; is_entry: number }[]): SnapFile[] =>
  rows.map(f => ({ name: f.name, description: f.description, content: f.content, is_entry: f.is_entry }));

export function captureSnapshot(projectId: string, flow: FlowDocument): RunSnapshot {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<string, unknown>;
  const agentIds = [...new Set(flow.nodes.filter(n => n.type === 'agent' && n.agent_id).map(n => n.agent_id!))];
  const agentRows = agentIds.length
    ? db.prepare(`SELECT * FROM agents WHERE id IN (${agentIds.map(() => '?').join(',')})`).all(...agentIds) as Agent[]
    : [];

  const agents = new Map<string, AgentSnap>();
  const skillIds = new Set<string>();
  for (const a of agentRows) {
    const ids = (db.prepare('SELECT skill_id FROM agent_skills WHERE agent_id = ? ORDER BY ordinal ASC').all(a.id) as { skill_id: string }[]).map(r => r.skill_id);
    ids.forEach(i => skillIds.add(i));
    agents.set(a.id, {
      id: a.id, name: a.name, description: a.description,
      output_schema: parseStoredSchema(a.output_schema),
      allowed_tools: parseToolList(a.allowed_tools),
      skill_ids: ids,
      files: files(loadEntityFiles(a.id, AGENT_FILES)),
    });
  }

  const skills = new Map<string, SkillSnap>();
  if (skillIds.size) {
    const rows = db.prepare(`SELECT * FROM skills WHERE id IN (${[...skillIds].map(() => '?').join(',')})`).all(...skillIds) as Skill[];
    for (const s of rows) skills.set(s.id, { id: s.id, name: s.name, description: s.description, files: files(loadEntityFiles(s.id, SKILL_FILES)) });
  }

  const contextRows = db.prepare(
    `SELECT c.* FROM project_contexts pc JOIN contexts c ON c.id = pc.context_id WHERE pc.project_id = ? ORDER BY c.name ASC`
  ).all(projectId) as Context[];
  const contexts = contextRows.map(c => ({ id: c.id, name: c.name, description: c.description, files: files(loadEntityFiles(c.id, CONTEXT_FILES)) }));

  return {
    flow,
    project: {
      id: projectId,
      name: String(project.name ?? ''),
      allow_executable_files: !!project.allow_executable_files,
      input_schema: parseStoredSchema(String(project.input_schema ?? '')),
    },
    agents, skills, contexts,
  };
}

function entries(snap: RunSnapshot): { kind: string; entity_id: string; name: string; content: unknown }[] {
  return [
    { kind: 'flow', entity_id: 'flow', name: '', content: snap.flow },
    { kind: 'project', entity_id: snap.project.id, name: snap.project.name, content: snap.project },
    ...[...snap.agents.values()].map(a => ({ kind: 'agent', entity_id: a.id, name: a.name, content: a })),
    ...[...snap.skills.values()].map(s => ({ kind: 'skill', entity_id: s.id, name: s.name, content: s })),
    ...snap.contexts.map(c => ({ kind: 'context', entity_id: c.id, name: c.name, content: c })),
  ];
}

// Persist inside the caller's transaction. Returns the per-entity hashes.
export function persistSnapshot(runId: string, snap: RunSnapshot): SnapshotHash[] {
  const ins = db.prepare('INSERT INTO run_snapshots (run_id, kind, entity_id, name, content_json, sha256) VALUES (?, ?, ?, ?, ?, ?)');
  const out: SnapshotHash[] = [];
  for (const e of entries(snap)) {
    const json = canonicalJson(e.content);
    const hash = sha256(json);
    ins.run(runId, e.kind, e.entity_id, e.name, json, hash);
    out.push({ kind: e.kind, entity_id: e.entity_id, name: e.name, sha256: hash });
  }
  return out;
}

export function loadSnapshot(runId: string): RunSnapshot | null {
  const rows = db.prepare('SELECT kind, entity_id, content_json FROM run_snapshots WHERE run_id = ?').all(runId) as { kind: string; entity_id: string; content_json: string }[];
  if (rows.length === 0) return null;
  const snap: RunSnapshot = { flow: { nodes: [], edges: [] }, project: { id: '', name: '', allow_executable_files: false, input_schema: null }, agents: new Map(), skills: new Map(), contexts: [] };
  for (const r of rows) {
    const c = JSON.parse(r.content_json);
    if (r.kind === 'flow') snap.flow = c;
    else if (r.kind === 'project') snap.project = c;
    else if (r.kind === 'agent') snap.agents.set(r.entity_id, c);
    else if (r.kind === 'skill') snap.skills.set(r.entity_id, c);
    else if (r.kind === 'context') snap.contexts.push(c);
  }
  snap.contexts.sort((a, b) => a.name.localeCompare(b.name));
  return snap;
}

export function snapshotHashes(runId: string): SnapshotHash[] {
  return db.prepare('SELECT kind, entity_id, name, sha256 FROM run_snapshots WHERE run_id = ? ORDER BY kind, entity_id').all(runId) as SnapshotHash[];
}
