import { v4 as uuidv4 } from 'uuid';
import db from '../db/client';
import { copyEntityFiles, loadEntityFiles, writeEntityFiles, AGENT_FILES, SKILL_FILES, CONTEXT_FILES } from './entityFiles';
import { newSecret, PROJECT_KEY_PREFIX } from './secrets';
import { EntityKind, getVersion, recordVersion, versionNumber, notifyForked, latestVersion } from './versions';
import { displayName } from './notify';

// Forked projects that stay connected to the project they came from.
//
// A fork records which entity of the source became which entity of the fork
// (entity_map) and the versions it last took from the source (base). When the
// source moves on, upstreamStatus() lists what changed, and syncFromUpstream()
// brings the whole project up to date while keeping what the fork made its
// own: contexts it attached, files it added to a skill or context, its name,
// key, settings and description.
//
// Contexts are business knowledge and private by default: only those the
// source's owner marked as shared travel with a fork, and only those the
// person forking chose to copy.

type Key = string;  // "<kind>:<source id>"
interface Base { src: number; fork: number }
interface Link { fork_project_id: string; source_project_id: string; entity_map: Record<Key, string>; base: Record<Key, Base>; synced_at: number }

const k = (kind: EntityKind, id: string): Key => `${kind}:${id}`;

function readFlow(projectId: string): { nodes: Array<Record<string, unknown> & { id: string; type?: string; agent_id?: string; agent_name?: string }>; edges: unknown[] } {
  const row = db.prepare('SELECT flow_json FROM project_flows WHERE project_id = ?').get(projectId) as { flow_json: string } | undefined;
  try { const f = JSON.parse(row?.flow_json ?? ''); return { nodes: f.nodes ?? [], edges: f.edges ?? [] }; } catch { return { nodes: [], edges: [] }; }
}

const flowAgentIds = (projectId: string) =>
  [...new Set(readFlow(projectId).nodes.filter(n => (n.type ?? 'agent') === 'agent' && n.agent_id).map(n => String(n.agent_id)))];

// ── Which contexts a project shares with forks ──────────────────────────────

export interface SharingRow { id: string; name: string; description: string; scope: 'project' | 'agent'; agents: string[]; shared: boolean }

export function contextSharing(projectId: string): SharingRow[] {
  const rows: SharingRow[] = [];
  for (const c of db.prepare(
    'SELECT c.id, c.name, c.description, pc.share_on_fork FROM project_contexts pc JOIN contexts c ON c.id = pc.context_id WHERE pc.project_id = ? ORDER BY c.name'
  ).all(projectId) as { id: string; name: string; description: string; share_on_fork: number }[]) {
    rows.push({ id: c.id, name: c.name, description: c.description, scope: 'project', agents: [], shared: !!c.share_on_fork });
  }
  const agentIds = flowAgentIds(projectId);
  if (agentIds.length) {
    const ctx = db.prepare(
      `SELECT c.id, c.name, c.description, a.name AS agent FROM agent_contexts ac
       JOIN contexts c ON c.id = ac.context_id JOIN agents a ON a.id = ac.agent_id
       WHERE ac.agent_id IN (${agentIds.map(() => '?').join(',')}) ORDER BY c.name, a.name`
    ).all(...agentIds) as { id: string; name: string; description: string; agent: string }[];
    const shared = new Set((db.prepare('SELECT context_id FROM project_context_sharing WHERE project_id = ? AND share = 1').all(projectId) as { context_id: string }[]).map(r => r.context_id));
    const byId = new Map<string, SharingRow>();
    for (const c of ctx) {
      if (rows.some(r => r.id === c.id)) continue;   // attached to the project too: the project row decides
      const row = byId.get(c.id) ?? { id: c.id, name: c.name, description: c.description, scope: 'agent' as const, agents: [], shared: shared.has(c.id) };
      row.agents.push(c.agent);
      byId.set(c.id, row);
    }
    rows.push(...byId.values());
  }
  return rows;
}

// Set exactly which contexts are shared (every other one becomes private).
export function setContextSharing(projectId: string, sharedIds: string[]): void {
  const want = new Set(sharedIds);
  db.transaction(() => {
    for (const r of contextSharing(projectId)) {
      if (r.scope === 'project') db.prepare('UPDATE project_contexts SET share_on_fork = ? WHERE project_id = ? AND context_id = ?').run(want.has(r.id) ? 1 : 0, projectId, r.id);
      else db.prepare('INSERT INTO project_context_sharing (project_id, context_id, share) VALUES (?, ?, ?) ON CONFLICT(project_id, context_id) DO UPDATE SET share = excluded.share').run(projectId, r.id, want.has(r.id) ? 1 : 0);
    }
  })();
}

export function forkPreview(projectId: string): { shared: SharingRow[]; private_count: number; private_agents: string[] } {
  const all = contextSharing(projectId);
  const priv = all.filter(r => !r.shared);
  return { shared: all.filter(r => r.shared), private_count: priv.length, private_agents: [...new Set(priv.flatMap(r => r.agents))].sort() };
}

// ── Copying ─────────────────────────────────────────────────────────────────

function uniqueName(userId: string, table: 'agents' | 'skills' | 'contexts' | 'projects', name: string, prefix = ''): string {
  const base = prefix ? `${prefix}${name}` : name;
  const taken = (n: string) => !!db.prepare(`SELECT 1 FROM ${table} WHERE user_id = ? AND name = ?`).get(userId, n);
  if (!taken(base)) return base;
  if (prefix) { let i = 2; while (taken(`${base} (${i})`)) i++; return `${base} (${i})`; }
  let cand = `${name} (fork)`; let i = 2;
  while (taken(cand)) cand = `${name} (fork ${i++})`;
  return cand;
}

function copySkill(srcId: string, userId: string, now: number): string {
  const s = db.prepare('SELECT * FROM skills WHERE id = ?').get(srcId) as Record<string, string>;
  const id = uuidv4();
  db.prepare('INSERT INTO skills (id, user_id, name, description, tags, content, is_public, forked_from, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)')
    .run(id, userId, uniqueName(userId, 'skills', s.name), s.description, s.tags ?? '', s.content ?? '', srcId, now);
  copyEntityFiles(srcId, id, SKILL_FILES);
  return id;
}

function copyContext(srcId: string, userId: string, now: number): string {
  const c = db.prepare('SELECT * FROM contexts WHERE id = ?').get(srcId) as Record<string, string>;
  const id = uuidv4();
  db.prepare('INSERT INTO contexts (id, user_id, name, description, tags, content, is_public, forked_from, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)')
    .run(id, userId, uniqueName(userId, 'contexts', c.name), c.description, c.tags ?? '', c.content ?? '', srcId, now);
  copyEntityFiles(srcId, id, CONTEXT_FILES);
  return id;
}

function copyAgentRow(srcId: string, userId: string, projectId: string, now: number): string {
  const a = db.prepare('SELECT * FROM agents WHERE id = ?').get(srcId) as Record<string, string>;
  const id = uuidv4();
  db.prepare('INSERT INTO agents (id, user_id, name, description, tags, output_schema, allowed_tools, is_public, forked_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)')
    .run(id, userId, uniqueName(userId, 'agents', a.name), a.description, a.tags ?? '', a.output_schema ?? '', a.allowed_tools ?? '[]', srcId, now);
  copyEntityFiles(srcId, id, AGENT_FILES);
  db.prepare('INSERT OR IGNORE INTO project_agents (project_id, agent_id) VALUES (?, ?)').run(projectId, id);
  return id;
}

// The skills and (copied) contexts of a fork agent, in the source agent's order,
// followed by the contexts the fork attached on its own.
function linkAgent(srcAgentId: string, forkAgentId: string, map: Record<Key, string>, userId: string, forkProjectId: string, now: number, copyContexts: Set<string> | null): void {
  db.prepare('DELETE FROM agent_skills WHERE agent_id = ?').run(forkAgentId);
  const skills = db.prepare('SELECT skill_id, ordinal FROM agent_skills WHERE agent_id = ? ORDER BY ordinal').all(srcAgentId) as { skill_id: string; ordinal: number }[];
  for (const s of skills) {
    let forkSkill = map[k('skill', s.skill_id)];
    if (!forkSkill || !db.prepare('SELECT 1 FROM skills WHERE id = ?').get(forkSkill)) { forkSkill = copySkill(s.skill_id, userId, now); map[k('skill', s.skill_id)] = forkSkill; }
    db.prepare('INSERT OR IGNORE INTO project_skills (project_id, skill_id) VALUES (?, ?)').run(forkProjectId, forkSkill);
    db.prepare('INSERT OR IGNORE INTO agent_skills (agent_id, skill_id, ordinal) VALUES (?, ?, ?)').run(forkAgentId, forkSkill, s.ordinal);
  }
  const upstreamCopies = new Set(Object.entries(map).filter(([key]) => key.startsWith('context:')).map(([, v]) => v));
  const own = (db.prepare('SELECT context_id FROM agent_contexts WHERE agent_id = ? ORDER BY ordinal').all(forkAgentId) as { context_id: string }[])
    .map(r => r.context_id).filter(id => !upstreamCopies.has(id));
  const wanted: string[] = [];
  for (const c of db.prepare('SELECT context_id FROM agent_contexts WHERE agent_id = ? ORDER BY ordinal').all(srcAgentId) as { context_id: string }[]) {
    let forkCtx = map[k('context', c.context_id)];
    if (!forkCtx && copyContexts?.has(c.context_id)) { forkCtx = copyContext(c.context_id, userId, now); map[k('context', c.context_id)] = forkCtx; }
    if (forkCtx && db.prepare('SELECT 1 FROM contexts WHERE id = ?').get(forkCtx)) wanted.push(forkCtx);
  }
  db.prepare('DELETE FROM agent_contexts WHERE agent_id = ?').run(forkAgentId);
  [...new Set([...wanted, ...own])].forEach((id, i) => db.prepare('INSERT INTO agent_contexts (agent_id, context_id, ordinal) VALUES (?, ?, ?)').run(forkAgentId, id, i));
}

function rewriteFlow(sourceId: string, forkId: string, map: Record<Key, string>): void {
  const flow = readFlow(sourceId);
  const nodes = flow.nodes.map(n => {
    if ((n.type ?? 'agent') !== 'agent' || !n.agent_id) return n;
    // The node keeps the source's label (as a fork always did): only the id
    // moves to the fork's copy, so an update does not rename every step.
    return { ...n, agent_id: map[k('agent', String(n.agent_id))] ?? n.agent_id };
  });
  const json = JSON.stringify({ nodes, edges: flow.edges });
  if (db.prepare('SELECT 1 FROM project_flows WHERE project_id = ?').get(forkId)) db.prepare('UPDATE project_flows SET flow_json = ?, updated_at = ? WHERE project_id = ?').run(json, Date.now(), forkId);
  else db.prepare('INSERT INTO project_flows (project_id, flow_json, updated_at) VALUES (?, ?, ?)').run(forkId, json, Date.now());
}

function saveLink(l: Link): void {
  db.prepare(
    `INSERT INTO fork_links (fork_project_id, source_project_id, entity_map_json, base_versions_json, synced_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(fork_project_id) DO UPDATE SET source_project_id = excluded.source_project_id, entity_map_json = excluded.entity_map_json,
       base_versions_json = excluded.base_versions_json, synced_at = excluded.synced_at`
  ).run(l.fork_project_id, l.source_project_id, JSON.stringify(l.entity_map), JSON.stringify(l.base), l.synced_at);
}

export function readLink(forkId: string): Link | null {
  const r = db.prepare('SELECT * FROM fork_links WHERE fork_project_id = ?').get(forkId) as { fork_project_id: string; source_project_id: string; entity_map_json: string; base_versions_json: string; synced_at: number } | undefined;
  if (!r) return null;
  return { fork_project_id: r.fork_project_id, source_project_id: r.source_project_id, entity_map: JSON.parse(r.entity_map_json), base: JSON.parse(r.base_versions_json), synced_at: r.synced_at };
}

const kindOfKey = (key: Key) => key.split(':')[0] as EntityKind;
const idOfKey = (key: Key) => key.slice(key.indexOf(':') + 1);

// Record a version of everything the fork holds and remember, per mapped
// entity, the source and fork versions it is now at.
function rebase(l: Link, authorId: string, note: string): void {
  l.base = {};
  for (const [key, forkEntity] of Object.entries(l.entity_map)) {
    const kind = kindOfKey(key);
    if (!db.prepare(`SELECT 1 FROM ${kind === 'agent' ? 'agents' : kind === 'skill' ? 'skills' : 'contexts'} WHERE id = ?`).get(forkEntity)) { delete l.entity_map[key]; continue; }
    l.base[key] = { src: versionNumber(kind, idOfKey(key)) || recordVersion(kind, idOfKey(key), '', 'baseline'), fork: recordVersion(kind, forkEntity, authorId, note) };
  }
  l.base[k('project', l.source_project_id)] = { src: versionNumber('project', l.source_project_id) || recordVersion('project', l.source_project_id, '', 'baseline'), fork: recordVersion('project', l.fork_project_id, authorId, note) };
  l.synced_at = Date.now();
  saveLink(l);
}

// Fork a project. copyContextIds: which shared contexts to copy (null = all shared ones).
export function forkProject(sourceId: string, userId: string, copyContextIds: string[] | null): { id: string; api_key: string } {
  const source = db.prepare('SELECT * FROM projects WHERE id = ?').get(sourceId) as Record<string, string>;
  const shared = contextSharing(sourceId).filter(r => r.shared).map(r => r.id);
  const copy = new Set(copyContextIds === null ? shared : copyContextIds.filter(id => shared.includes(id)));
  const id = uuidv4();
  const key = newSecret(PROJECT_KEY_PREFIX);
  const now = Date.now();
  const map: Record<Key, string> = {};
  db.transaction(() => {
    db.prepare('INSERT INTO projects (id, user_id, name, description, tags, api_key_hash, api_key_hint, is_public, forked_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)')
      .run(id, userId, uniqueName(userId, 'projects', source.name, 'Fork: '), source.description, source.tags ?? '', key.hash, key.display, sourceId, now);
    for (const a of flowAgentIds(sourceId)) {
      if (!db.prepare('SELECT 1 FROM agents WHERE id = ?').get(a)) continue;
      map[k('agent', a)] = copyAgentRow(a, userId, id, now);
    }
    for (const a of flowAgentIds(sourceId)) if (map[k('agent', a)]) linkAgent(a, map[k('agent', a)]!, map, userId, id, now, copy);
    rewriteFlow(sourceId, id, map);
    for (const c of contextSharing(sourceId).filter(r => r.scope === 'project' && copy.has(r.id))) {
      const forkCtx = copyContext(c.id, userId, now);
      map[k('context', c.id)] = forkCtx;
      db.prepare('INSERT INTO project_contexts (project_id, context_id, share_on_fork) VALUES (?, ?, 0)').run(id, forkCtx);
    }
  })();
  const link: Link = { fork_project_id: id, source_project_id: sourceId, entity_map: map, base: {}, synced_at: now };
  rebase(link, userId, `forked from "${source.name}"`);
  notifyForked('project', sourceId, source.name, source.user_id, userId);
  return { id, api_key: key.plaintext };
}

// ── What changed in the source ──────────────────────────────────────────────

export interface UpstreamChange {
  kind: EntityKind; change: 'changed' | 'added' | 'removed';
  name: string; source_id: string; fork_id: string | null;
  from: number | null; to: number | null; by: string;
  local_changes: boolean;   // the fork changed it too: syncing replaces those changes
}

function nameOf(kind: EntityKind, id: string): string {
  const t = kind === 'agent' ? 'agents' : kind === 'skill' ? 'skills' : kind === 'context' ? 'contexts' : 'projects';
  return (db.prepare(`SELECT name FROM ${t} WHERE id = ?`).get(id) as { name: string } | undefined)?.name ?? '';
}

export function upstreamStatus(forkId: string): { linked: boolean; source?: { id: string; name: string; owner: string }; changes: UpstreamChange[]; synced_at?: number } {
  const l = readLink(forkId);
  if (!l) return { linked: false, changes: [] };
  const src = db.prepare('SELECT id, name, user_id FROM projects WHERE id = ?').get(l.source_project_id) as { id: string; name: string; user_id: string } | undefined;
  if (!src) return { linked: false, changes: [] };
  const changes: UpstreamChange[] = [];
  const by = (kind: EntityKind, id: string) => { const v = latestVersion(kind, id); return v?.author_user_id ? displayName(v.author_user_id) : ''; };
  const consider = (kind: EntityKind, srcId: string) => {
    const key = k(kind, srcId);
    const forkEntity = kind === 'project' ? forkId : l.entity_map[key];
    const cur = versionNumber(kind, srcId);
    if (!forkEntity) { changes.push({ kind, change: 'added', name: nameOf(kind, srcId), source_id: srcId, fork_id: null, from: null, to: cur, by: by(kind, srcId), local_changes: false }); return; }
    const base = l.base[key];
    // A newer version whose content is back to what the fork took is no change.
    if (base && cur > base.src && getVersion(kind, srcId, base.src)?.sha256 !== latestVersion(kind, srcId)?.sha256) {
      changes.push({ kind, change: 'changed', name: nameOf(kind, srcId), source_id: srcId, fork_id: forkEntity, from: base.src, to: cur, by: by(kind, srcId), local_changes: versionNumber(kind, forkEntity) > base.fork });
    }
  };
  const agents = flowAgentIds(src.id).filter(a => db.prepare('SELECT 1 FROM agents WHERE id = ?').get(a));
  for (const a of agents) {
    consider('agent', a);
    for (const s of db.prepare('SELECT skill_id FROM agent_skills WHERE agent_id = ?').all(a) as { skill_id: string }[]) if (l.entity_map[k('skill', s.skill_id)] || !changes.some(c => c.source_id === s.skill_id)) consider('skill', s.skill_id);
  }
  for (const key of Object.keys(l.entity_map).filter(key => key.startsWith('context:'))) {
    if (db.prepare('SELECT 1 FROM contexts WHERE id = ?').get(idOfKey(key))) consider('context', idOfKey(key));
  }
  consider('project', src.id);
  for (const key of Object.keys(l.entity_map).filter(key => key.startsWith('agent:'))) {
    if (!agents.includes(idOfKey(key))) changes.push({ kind: 'agent', change: 'removed', name: nameOf('agent', l.entity_map[key]!), source_id: idOfKey(key), fork_id: l.entity_map[key]!, from: null, to: null, by: '', local_changes: false });
  }
  const seen = new Set<string>();
  return {
    linked: true, synced_at: l.synced_at, source: { id: src.id, name: src.name, owner: displayName(src.user_id) },
    changes: changes.filter(c => { const key = `${c.kind}:${c.source_id}:${c.change}`; if (seen.has(key)) return false; seen.add(key); return true; }),
  };
}

// ── Bringing the fork up to date ────────────────────────────────────────────

// Files the fork added on top of what it took from the source are kept.
function syncFiles(kind: 'agent' | 'skill' | 'context', srcId: string, forkId: string, baseSrcVersion: number | undefined): void {
  const cfg = kind === 'agent' ? AGENT_FILES : kind === 'skill' ? SKILL_FILES : CONTEXT_FILES;
  const srcFiles = loadEntityFiles(srcId, cfg);
  const baseNames = new Set<string>(((baseSrcVersion ? (getVersion(kind, srcId, baseSrcVersion)?.content as { files?: { name: string }[] }) : null)?.files ?? []).map(f => f.name));
  const srcNames = new Set(srcFiles.map(f => f.name));
  const added = loadEntityFiles(forkId, cfg).filter(f => !f.is_entry && !srcNames.has(f.name) && !baseNames.has(f.name));
  const files = srcFiles.map(f => ({ name: f.name, description: f.description, content: f.content, is_entry: f.is_entry }));
  if (added.length && kind !== 'agent') {
    const entry = files.find(f => f.is_entry);
    const list = added.map(f => `\`${f.name}\``).join(', ');
    if (entry && !entry.content.includes(list)) entry.content = entry.content.trimEnd() + `\n\n## Additional files of this project\n\nThis project adds ${list} (below). Apply it on top of these instructions.\n`;
  }
  writeEntityFiles(forkId, [...files, ...added.map(f => ({ name: f.name, description: f.description, content: f.content, is_entry: 0 }))], cfg);
}

export function syncFromUpstream(forkId: string, userId: string): { updated: number; added: number; removed: number } {
  const l = readLink(forkId);
  if (!l) throw new Error('This project is not linked to the project it was forked from.');
  const status = upstreamStatus(forkId);
  const src = db.prepare('SELECT * FROM projects WHERE id = ?').get(l.source_project_id) as Record<string, string>;
  const now = Date.now();
  let updated = 0, added = 0, removed = 0;
  db.transaction(() => {
    for (const c of status.changes) {
      if (c.change === 'removed') { removed++; continue; }
      if (c.kind === 'agent') {
        let forkAgent = l.entity_map[k('agent', c.source_id)];
        if (!forkAgent) { forkAgent = copyAgentRow(c.source_id, userId, forkId, now); l.entity_map[k('agent', c.source_id)] = forkAgent; added++; }
        else {
          const a = db.prepare('SELECT * FROM agents WHERE id = ?').get(c.source_id) as Record<string, string>;
          db.prepare('UPDATE agents SET description = ?, tags = ?, output_schema = ?, allowed_tools = ? WHERE id = ?').run(a.description, a.tags ?? '', a.output_schema ?? '', a.allowed_tools ?? '[]', forkAgent);
          syncFiles('agent', c.source_id, forkAgent, l.base[k('agent', c.source_id)]?.src);
          updated++;
        }
      } else if (c.kind === 'skill' || c.kind === 'context') {
        const forkEntity = l.entity_map[k(c.kind, c.source_id)];
        if (!forkEntity) continue;   // new skills come with their agents; new contexts are not copied
        const t = c.kind === 'skill' ? 'skills' : 'contexts';
        const e = db.prepare(`SELECT description, tags FROM ${t} WHERE id = ?`).get(c.source_id) as { description: string; tags: string };
        db.prepare(`UPDATE ${t} SET description = ?, tags = ? WHERE id = ?`).run(e.description, e.tags ?? '', forkEntity);
        syncFiles(c.kind, c.source_id, forkEntity, l.base[k(c.kind, c.source_id)]?.src);
        updated++;
      } else if (c.kind === 'project') {
        db.prepare('UPDATE projects SET input_schema = ? WHERE id = ?').run(src.input_schema ?? '', forkId);
        updated++;
      }
    }
    // Links of every agent of the source flow (skills; copied contexts first, the fork's own after), then the flow.
    for (const a of flowAgentIds(l.source_project_id)) {
      const forkAgent = l.entity_map[k('agent', a)];
      if (forkAgent) linkAgent(a, forkAgent, l.entity_map, userId, forkId, now, null);
    }
    rewriteFlow(l.source_project_id, forkId, l.entity_map);
  })();
  rebase(l, userId, `updated from "${src.name}" v${versionNumber('project', l.source_project_id)}`);
  return { updated, added, removed };
}

// ── Forks made before fork_links existed ─────────────────────────────────────

const baseName = (n: string) => n.replace(/( \(fork( \d+)?\))+$/, '');

// Rebuild the link of every forked project that has none: entities matched by
// forked_from, else by name without the "(fork)" suffix. The fork is taken as
// up to date with the source's current versions.
export function ensureForkLinks(): number {
  const forks = db.prepare(
    'SELECT p.id, p.user_id, p.forked_from FROM projects p WHERE p.forked_from IS NOT NULL AND p.id NOT IN (SELECT fork_project_id FROM fork_links)'
  ).all() as { id: string; user_id: string; forked_from: string }[];
  let n = 0;
  for (const f of forks) {
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(f.forked_from)) continue;
    const map: Record<Key, string> = {};
    const forkAgents = flowAgentIds(f.id).map(id => db.prepare('SELECT id, name, forked_from FROM agents WHERE id = ?').get(id) as { id: string; name: string; forked_from: string | null } | undefined).filter(Boolean) as { id: string; name: string; forked_from: string | null }[];
    for (const sa of flowAgentIds(f.forked_from)) {
      const s = db.prepare('SELECT id, name FROM agents WHERE id = ?').get(sa) as { id: string; name: string } | undefined;
      if (!s) continue;
      const fa = forkAgents.find(a => a.forked_from === s.id) ?? forkAgents.find(a => baseName(a.name) === baseName(s.name));
      if (!fa) continue;
      map[k('agent', s.id)] = fa.id;
      for (const kind of ['skill', 'context'] as const) {
        const link = kind === 'skill' ? 'agent_skills' : 'agent_contexts';
        const col = kind === 'skill' ? 'skill_id' : 'context_id';
        const t = kind === 'skill' ? 'skills' : 'contexts';
        const srcItems = db.prepare(`SELECT e.id, e.name FROM ${link} x JOIN ${t} e ON e.id = x.${col} WHERE x.agent_id = ?`).all(s.id) as { id: string; name: string }[];
        const forkItems = db.prepare(`SELECT e.id, e.name, e.forked_from FROM ${link} x JOIN ${t} e ON e.id = x.${col} WHERE x.agent_id = ?`).all(fa.id) as { id: string; name: string; forked_from: string | null }[];
        for (const si of srcItems) {
          const fi = forkItems.find(x => x.forked_from === si.id) ?? forkItems.find(x => baseName(x.name) === baseName(si.name));
          if (fi) map[k(kind, si.id)] = fi.id;
        }
      }
    }
    for (const c of db.prepare('SELECT c.id, c.forked_from FROM project_contexts pc JOIN contexts c ON c.id = pc.context_id WHERE pc.project_id = ? AND c.forked_from IS NOT NULL').all(f.id) as { id: string; forked_from: string }[]) {
      map[k('context', c.forked_from)] = c.id;
    }
    rebase({ fork_project_id: f.id, source_project_id: f.forked_from, entity_map: map, base: {}, synced_at: Date.now() }, f.user_id, 'linked to the project it was forked from');
    n++;
  }
  return n;
}
