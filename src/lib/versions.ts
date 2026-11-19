import { v4 as uuidv4 } from 'uuid';
import db from '../db/client';
import { canonicalJson, sha256 } from './canonicalJson';
// forkSync imports this module too; upstreamStatus is only used at call time.
import { upstreamStatus } from './forkSync';
import { loadEntityFiles, AGENT_FILES, SKILL_FILES, CONTEXT_FILES } from './entityFiles';
import { displayName, notify, projectMembers } from './notify';
import { flowsReferencingAgents } from '../orchestrator';
import { hasLiveInvitation } from './access';

// Version history of agents, skills, contexts and projects.
//
// recordVersion() is called after every write. It computes what defines the
// entity now, and stores a new version only if that differs from the last
// one. When a version (other than the first) is stored, the people who depend
// on it are told: the members of every project that uses it, and the owners
// of every fork of those projects.

export type EntityKind = 'project' | 'agent' | 'skill' | 'context';
export const ENTITY_KINDS: EntityKind[] = ['project', 'agent', 'skill', 'context'];
const TABLE: Record<EntityKind, string> = { project: 'projects', agent: 'agents', skill: 'skills', context: 'contexts' };

const files = (rows: { name: string; description: string; content: string; is_entry: number }[]) =>
  rows.map(f => ({ name: f.name, description: f.description, content: f.content, is_entry: f.is_entry }));

function json(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

// What defines the entity. Null when it does not exist.
export function currentContent(kind: EntityKind, id: string): Record<string, unknown> | null {
  if (kind === 'agent') {
    const a = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, string> | undefined;
    if (!a) return null;
    return {
      name: a.name, description: a.description, tags: a.tags ?? '',
      output_schema: json(a.output_schema), allowed_tools: json(a.allowed_tools) ?? [],
      skill_ids: (db.prepare('SELECT skill_id FROM agent_skills WHERE agent_id = ? ORDER BY ordinal').all(id) as { skill_id: string }[]).map(r => r.skill_id),
      context_ids: (db.prepare('SELECT context_id FROM agent_contexts WHERE agent_id = ? ORDER BY ordinal').all(id) as { context_id: string }[]).map(r => r.context_id),
      files: files(loadEntityFiles(id, AGENT_FILES)),
    };
  }
  if (kind === 'skill' || kind === 'context') {
    const e = db.prepare(`SELECT * FROM ${TABLE[kind]} WHERE id = ?`).get(id) as Record<string, string> | undefined;
    if (!e) return null;
    return { name: e.name, description: e.description, tags: e.tags ?? '', files: files(loadEntityFiles(id, kind === 'skill' ? SKILL_FILES : CONTEXT_FILES)) };
  }
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, string | number> | undefined;
  if (!p) return null;
  const flow = db.prepare('SELECT flow_json FROM project_flows WHERE project_id = ?').get(id) as { flow_json: string } | undefined;
  return {
    name: p.name, description: p.description, tags: p.tags ?? '',
    input_schema: json(p.input_schema as string), execution_mode: p.execution_mode,
    allow_executable_files: !!p.allow_executable_files, is_public: !!p.is_public,
    flow: json(flow?.flow_json) ?? { nodes: [], edges: [] },
    contexts: db.prepare('SELECT context_id, share_on_fork FROM project_contexts WHERE project_id = ? ORDER BY context_id').all(id),
    shared_agent_contexts: (db.prepare('SELECT context_id FROM project_context_sharing WHERE project_id = ? AND share = 1 ORDER BY context_id').all(id) as { context_id: string }[]).map(r => r.context_id),
  };
}

export interface VersionRow { version: number; sha256: string; author_user_id: string; note: string; created_at: number }

export function latestVersion(kind: EntityKind, id: string): VersionRow | null {
  return (db.prepare('SELECT version, sha256, author_user_id, note, created_at FROM entity_versions WHERE kind = ? AND entity_id = ? ORDER BY version DESC LIMIT 1')
    .get(kind, id) as VersionRow | undefined) ?? null;
}

export function versionNumber(kind: EntityKind, id: string): number {
  return latestVersion(kind, id)?.version ?? 0;
}

export function listVersions(kind: EntityKind, id: string): (VersionRow & { author: string })[] {
  const rows = db.prepare('SELECT version, sha256, author_user_id, note, created_at FROM entity_versions WHERE kind = ? AND entity_id = ? ORDER BY version DESC')
    .all(kind, id) as VersionRow[];
  return rows.map(r => ({ ...r, author: r.author_user_id ? displayName(r.author_user_id) : '' }));
}

export function getVersion(kind: EntityKind, id: string, version: number): (VersionRow & { content: unknown }) | null {
  const r = db.prepare('SELECT version, sha256, author_user_id, note, created_at, content_json FROM entity_versions WHERE kind = ? AND entity_id = ? AND version = ?')
    .get(kind, id, version) as (VersionRow & { content_json: string }) | undefined;
  if (!r) return null;
  const { content_json, ...rest } = r;
  return { ...rest, content: JSON.parse(content_json) };
}

// Store the entity's current content as a new version if it changed. Returns
// the current version number (0 if the entity does not exist).
export function recordVersion(kind: EntityKind, id: string, authorId: string, note = ''): number {
  const content = currentContent(kind, id);
  if (!content) return 0;
  const json = canonicalJson(content);
  const hash = sha256(json);
  const last = latestVersion(kind, id);
  if (last && last.sha256 === hash) return last.version;
  const version = (last?.version ?? 0) + 1;
  db.prepare('INSERT INTO entity_versions (id, kind, entity_id, version, content_json, sha256, author_user_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(uuidv4(), kind, id, version, json, hash, authorId ?? '', String(note ?? '').slice(0, 500), Date.now());
  if (version > 1) announce(kind, id, String(content.name ?? ''), version, authorId);
  return version;
}

// The first version of every entity that has none, with its content as it is
// now. Run once at startup, so an entity's state before its first edit is kept.
export function ensureBaselineVersions(): number {
  let n = 0;
  for (const kind of ENTITY_KINDS) {
    const rows = db.prepare(
      `SELECT id, user_id FROM ${TABLE[kind]} WHERE id NOT IN (SELECT entity_id FROM entity_versions WHERE kind = ?)`
    ).all(kind) as { id: string; user_id: string }[];
    for (const r of rows) { recordVersion(kind, r.id, r.user_id, 'baseline'); n++; }
  }
  return n;
}

// ── Who depends on an entity ────────────────────────────────────────────────

// Projects whose runs use the entity: the project itself, the projects whose
// flow has the agent, and through agents the skills and contexts they carry.
export function projectsUsing(kind: EntityKind, id: string): string[] {
  if (kind === 'project') return [id];
  let agentIds: string[] = [];
  const direct: string[] = [];
  if (kind === 'agent') agentIds = [id];
  if (kind === 'skill') agentIds = (db.prepare('SELECT agent_id FROM agent_skills WHERE skill_id = ?').all(id) as { agent_id: string }[]).map(r => r.agent_id);
  if (kind === 'context') {
    agentIds = (db.prepare('SELECT agent_id FROM agent_contexts WHERE context_id = ?').all(id) as { agent_id: string }[]).map(r => r.agent_id);
    direct.push(...(db.prepare('SELECT project_id FROM project_contexts WHERE context_id = ?').all(id) as { project_id: string }[]).map(r => r.project_id));
  }
  if (agentIds.length) direct.push(...flowsReferencingAgents(agentIds).map(p => p.project_id));
  return [...new Set(direct)];
}

const LABEL: Record<EntityKind, string> = { project: 'The project', agent: 'Agent', skill: 'Skill', context: 'Context' };

function announce(kind: EntityKind, id: string, name: string, version: number, authorId: string): void {
  const who = authorId ? displayName(authorId) : 'someone';
  const what = kind === 'project' ? `The project settings or flow are now v${version}` : `${LABEL[kind]} "${name}" is now v${version}`;
  for (const projectId of projectsUsing(kind, id)) {
    const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string } | undefined;
    if (!project) continue;
    for (const userId of projectMembers(projectId)) {
      if (userId === authorId) continue;
      notify({
        userId, kind: 'shared_changed', coalesce: true, projectId, entityKind: kind, entityId: id,
        title: `"${project.name}" changed`, body: `${what} (by ${who}).`, link: `history.html?kind=${kind}&id=${id}`,
      });
    }
    const forks = db.prepare('SELECT f.fork_project_id, p.user_id, p.name FROM fork_links f JOIN projects p ON p.id = f.fork_project_id WHERE f.source_project_id = ?')
      .all(projectId) as { fork_project_id: string; user_id: string; name: string }[];
    for (const f of forks) {
      // Nothing to take (e.g. the change was undone): no notice.
      if (!upstreamStatus(f.fork_project_id).changes.length) continue;
      notify({
        userId: f.user_id, kind: 'upstream_changed', coalesce: true, projectId: f.fork_project_id, entityKind: kind, entityId: id,
        title: `"${project.name}" has changes for your fork "${f.name}"`, body: `${what} (by ${who}).`, link: `project.html?id=${f.fork_project_id}#updates`,
      });
    }
  }
}

// An agent with the skills and contexts it carries (used after a fork, where
// all of them are new copies).
export function recordAgentTree(agentId: string, authorId: string, note: string): void {
  recordVersion('agent', agentId, authorId, note);
  for (const r of db.prepare('SELECT skill_id FROM agent_skills WHERE agent_id = ?').all(agentId) as { skill_id: string }[]) recordVersion('skill', r.skill_id, authorId, note);
  for (const r of db.prepare('SELECT context_id FROM agent_contexts WHERE agent_id = ?').all(agentId) as { context_id: string }[]) recordVersion('context', r.context_id, authorId, note);
}

// Tell the owner that someone forked something of theirs (not when they forked it themselves).
export function notifyForked(kind: EntityKind, sourceId: string, sourceName: string, ownerId: string, forkerId: string): void {
  if (!ownerId || ownerId === forkerId) return;
  const link = kind === 'project' ? `project.html?id=${sourceId}` : `history.html?kind=${kind}&id=${sourceId}`;
  notify({ userId: ownerId, kind: 'forked', title: `${displayName(forkerId)} forked your ${kind} "${sourceName}"`, link, entityKind: kind, entityId: sourceId, projectId: kind === 'project' ? sourceId : undefined });
}

// ── Access and restore ──────────────────────────────────────────────────────

function isAdminUser(userId: string): boolean {
  return (db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: string } | undefined)?.role === 'admin';
}

function isMemberOf(userId: string, projectId: string): boolean {
  const u = db.prepare('SELECT email FROM users WHERE id = ?').get(userId) as { email: string } | undefined;
  if (!u) return false;
  return !!db.prepare(
    `SELECT 1 FROM project_invitations WHERE project_id = ? AND status IN ('pending', 'accepted')
     AND (invitee_user_id = ? OR LOWER(invitee_email) = LOWER(?))`
  ).get(projectId, userId, u.email);
}

export function entityOwner(kind: EntityKind, id: string): { user_id: string; name: string; is_public: number } | null {
  return (db.prepare(`SELECT user_id, name, is_public FROM ${TABLE[kind]} WHERE id = ?`).get(id) as { user_id: string; name: string; is_public: number } | undefined) ?? null;
}

// The history holds full content, so it follows content access, not visibility:
// the owner, an admin, someone with a live invitation to it, and the owner or
// members of a project that uses it (who receive it when they run the project).
// Being public is not enough: public content is read by forking it.
export function canViewHistory(kind: EntityKind, id: string, userId: string): boolean {
  const e = entityOwner(kind, id);
  if (!e) return false;
  if (e.user_id === userId || isAdminUser(userId)) return true;
  if (kind === 'project') return isMemberOf(userId, id);
  if (hasLiveInvitation(kind, id, userId)) return true;
  for (const pid of projectsUsing(kind, id)) {
    const p = db.prepare('SELECT user_id FROM projects WHERE id = ?').get(pid) as { user_id: string } | undefined;
    if (p && (p.user_id === userId || isMemberOf(userId, pid))) return true;
  }
  return false;
}

export function canEdit(kind: EntityKind, id: string, userId: string): boolean {
  const e = entityOwner(kind, id);
  return !!e && (e.user_id === userId || isAdminUser(userId));
}

// Put an entity back to an earlier version's content, as a new version. A
// project gets back its flow and settings (not its visibility or attached
// contexts); links to skills or contexts that no longer exist are dropped.
export function restoreVersion(kind: EntityKind, id: string, version: number, authorId: string): number {
  const v = getVersion(kind, id, version);
  if (!v) return 0;
  const c = v.content as Record<string, any>;
  const writeFiles = (table: string, fk: string, fileList: { name: string; description: string; content: string; is_entry: number }[]) => {
    db.prepare(`DELETE FROM ${table} WHERE ${fk} = ?`).run(id);
    const ins = db.prepare(`INSERT INTO ${table} (id, ${fk}, name, description, content, is_entry, ordinal) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    fileList.forEach((f, i) => ins.run(uuidv4(), id, f.name, f.description ?? '', f.content, f.is_entry ? 1 : 0, i));
  };
  db.transaction(() => {
    if (kind === 'agent') {
      db.prepare('UPDATE agents SET name = ?, description = ?, tags = ?, output_schema = ?, allowed_tools = ? WHERE id = ?')
        .run(c.name, c.description, c.tags ?? '', c.output_schema ? JSON.stringify(c.output_schema) : '', JSON.stringify(c.allowed_tools ?? []), id);
      writeFiles('agent_files', 'agent_id', c.files ?? []);
      db.prepare('DELETE FROM agent_skills WHERE agent_id = ?').run(id);
      (c.skill_ids ?? []).filter((s: string) => db.prepare('SELECT 1 FROM skills WHERE id = ?').get(s))
        .forEach((s: string, i: number) => db.prepare('INSERT INTO agent_skills (agent_id, skill_id, ordinal) VALUES (?, ?, ?)').run(id, s, i));
      db.prepare('DELETE FROM agent_contexts WHERE agent_id = ?').run(id);
      (c.context_ids ?? []).filter((x: string) => db.prepare('SELECT 1 FROM contexts WHERE id = ?').get(x))
        .forEach((x: string, i: number) => db.prepare('INSERT INTO agent_contexts (agent_id, context_id, ordinal) VALUES (?, ?, ?)').run(id, x, i));
    } else if (kind === 'skill' || kind === 'context') {
      const entry = (c.files ?? []).find((f: { is_entry: number }) => f.is_entry)?.content ?? '';
      db.prepare(`UPDATE ${TABLE[kind]} SET name = ?, description = ?, tags = ?, content = ? WHERE id = ?`).run(c.name, c.description, c.tags ?? '', entry, id);
      writeFiles(kind === 'skill' ? 'skill_files' : 'context_files', kind === 'skill' ? 'skill_id' : 'context_id', c.files ?? []);
    } else {
      db.prepare('UPDATE projects SET name = ?, description = ?, tags = ?, input_schema = ?, execution_mode = ?, allow_executable_files = ? WHERE id = ?')
        .run(c.name, c.description, c.tags ?? '', c.input_schema ? JSON.stringify(c.input_schema) : '', c.execution_mode ?? 'verified', c.allow_executable_files ? 1 : 0, id);
      db.prepare('UPDATE project_flows SET flow_json = ?, updated_at = ? WHERE project_id = ?').run(JSON.stringify(c.flow ?? { nodes: [], edges: [] }), Date.now(), id);
    }
  })();
  return recordVersion(kind, id, authorId, `restored v${version}`);
}
