// Load a validated harness into the database, idempotently. Entities are
// matched by (owner, name) and updated in place; applying the same harness
// twice changes nothing. Returns the content hashes of what was applied.
import { v4 as uuidv4 } from 'uuid';
import db from '../db/client';
import { writeEntityFiles, AGENT_FILES, SKILL_FILES, CONTEXT_FILES, FileConfig } from '../lib/entityFiles';
import { canonicalJson, hashJson } from '../lib/canonicalJson';
import { newSecret, PROJECT_KEY_PREFIX } from '../lib/secrets';
import { validateProjectFlow } from '../orchestrator';
import { Harness, HarnessEntity } from './load';

export interface ApplyReport {
  hashes: { kind: string; name: string; sha256: string }[];
  created: string[];
  updated: string[];
  newProjectKeys: { project: string; api_key: string }[];
}

function filesEqual(table: string, fk: string, id: string, files: HarnessEntity['files']): boolean {
  const cur = db.prepare(`SELECT name, description, content, is_entry FROM ${table} WHERE ${fk} = ? ORDER BY is_entry DESC, ordinal ASC, name ASC`).all(id);
  return canonicalJson(cur) === canonicalJson(files);
}

export function applyHarness(h: Harness, ownerId: string): ApplyReport {
  const report: ApplyReport = { hashes: [], created: [], updated: [], newProjectKeys: [] };
  const now = Date.now();

  const tx = db.transaction(() => {
    const upsertSimple = (table: 'skills' | 'contexts', cfg: FileConfig, e: HarnessEntity): string => {
      const row = db.prepare(`SELECT id, description FROM ${table} WHERE user_id = ? AND name = ?`).get(ownerId, e.name) as { id: string; description: string } | undefined;
      const entry = e.files.find(f => f.is_entry)?.content ?? '';
      let id = row?.id;
      if (!id) {
        id = uuidv4();
        db.prepare(`INSERT INTO ${table} (id, user_id, name, description, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, ownerId, e.name, e.description, entry, now);
        report.created.push(`${table.slice(0, -1)} ${e.name}`);
      } else if (row!.description !== e.description || !filesEqual(cfg.table, cfg.fk, id, e.files)) {
        db.prepare(`UPDATE ${table} SET description = ? WHERE id = ?`).run(e.description, id);
        report.updated.push(`${table.slice(0, -1)} ${e.name}`);
      }
      if (!filesEqual(cfg.table, cfg.fk, id, e.files)) writeEntityFiles(id, e.files, cfg);
      report.hashes.push({ kind: table.slice(0, -1), name: e.name, sha256: hashJson({ description: e.description, files: e.files }) });
      return id;
    };

    const skillIds = new Map([...h.skills.values()].map(s => [s.name, upsertSimple('skills', SKILL_FILES, s)]));
    const contextIds = new Map([...h.contexts.values()].map(c => [c.name, upsertSimple('contexts', CONTEXT_FILES, c)]));

    const agentIds = new Map<string, string>();
    for (const a of h.agents.values()) {
      const schema = a.output_schema ? JSON.stringify(a.output_schema) : '';
      const tools = JSON.stringify(a.allowed_tools);
      const row = db.prepare('SELECT id, description, output_schema, allowed_tools FROM agents WHERE user_id = ? AND name = ?').get(ownerId, a.name) as { id: string; description: string; output_schema: string; allowed_tools: string } | undefined;
      let id = row?.id;
      const wantSkills = a.skills.map(s => skillIds.get(s)!);
      if (!id) {
        id = uuidv4();
        db.prepare('INSERT INTO agents (id, user_id, name, description, output_schema, allowed_tools, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, ownerId, a.name, a.description, schema, tools, now);
        report.created.push(`agent ${a.name}`);
      } else {
        const curSkills = (db.prepare('SELECT skill_id FROM agent_skills WHERE agent_id = ? ORDER BY ordinal').all(id) as { skill_id: string }[]).map(r => r.skill_id);
        if (row!.description !== a.description || row!.output_schema !== schema || row!.allowed_tools !== tools || canonicalJson(curSkills) !== canonicalJson(wantSkills) || !filesEqual('agent_files', 'agent_id', id, a.files)) {
          db.prepare('UPDATE agents SET description = ?, output_schema = ?, allowed_tools = ? WHERE id = ?').run(a.description, schema, tools, id);
          report.updated.push(`agent ${a.name}`);
        }
      }
      if (!filesEqual('agent_files', 'agent_id', id, a.files)) writeEntityFiles(id, a.files, AGENT_FILES);
      db.prepare('DELETE FROM agent_skills WHERE agent_id = ?').run(id);
      wantSkills.forEach((sid, i) => db.prepare('INSERT INTO agent_skills (agent_id, skill_id, ordinal) VALUES (?, ?, ?)').run(id, sid, i));
      agentIds.set(a.name, id);
      report.hashes.push({ kind: 'agent', name: a.name, sha256: hashJson({ description: a.description, output_schema: a.output_schema, allowed_tools: a.allowed_tools, skills: a.skills, files: a.files }) });
    }

    for (const p of h.projects) {
      let row = db.prepare('SELECT id FROM projects WHERE user_id = ? AND name = ?').get(ownerId, p.name) as { id: string } | undefined;
      const inputSchema = p.input_schema ? JSON.stringify(p.input_schema) : '';
      if (!row) {
        const key = newSecret(PROJECT_KEY_PREFIX);
        row = { id: uuidv4() };
        db.prepare('INSERT INTO projects (id, user_id, name, description, api_key_hash, api_key_hint, input_schema, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(row.id, ownerId, p.name, p.description, key.hash, key.display, inputSchema, now);
        report.created.push(`project ${p.name}`);
        report.newProjectKeys.push({ project: p.name, api_key: key.plaintext });
      } else {
        db.prepare('UPDATE projects SET description = ?, input_schema = ? WHERE id = ?').run(p.description, inputSchema, row.id);
      }
      const pid = row.id;

      // Agents used by the flow and the project's contexts are linked to it.
      for (const name of p.agents) db.prepare('INSERT OR IGNORE INTO project_agents (project_id, agent_id) VALUES (?, ?)').run(pid, agentIds.get(name)!);
      for (const name of p.contexts) db.prepare('INSERT OR IGNORE INTO project_contexts (project_id, context_id, share_on_fork) VALUES (?, ?, 0)').run(pid, contextIds.get(name)!);

      const flow = {
        nodes: p.flow.nodes.map(n => n.type === 'agent' ? { ...n, agent_id: agentIds.get(n.agent_id!)!, agent_name: n.agent_name } : n),
        edges: p.flow.edges,
      };
      const errors = validateProjectFlow(pid, flow);
      if (errors.length) throw new Error(`project ${p.name}: the flow does not validate against the database:\n${errors.join('\n')}`);
      const flowJson = JSON.stringify(flow);
      const cur = db.prepare('SELECT flow_json FROM project_flows WHERE project_id = ?').get(pid) as { flow_json: string } | undefined;
      if (!cur) db.prepare('INSERT INTO project_flows (project_id, flow_json, updated_at) VALUES (?, ?, ?)').run(pid, flowJson, now);
      else if (cur.flow_json !== flowJson) { db.prepare('UPDATE project_flows SET flow_json = ?, updated_at = ? WHERE project_id = ?').run(flowJson, now, pid); report.updated.push(`flow ${p.name}`); }
      // The hash of the flow by agent names, so it is stable across databases.
      report.hashes.push({ kind: 'flow', name: p.name, sha256: hashJson(p.flow) });

      // Evals: the harness is the source of truth for the project's suite.
      const keep = new Set(p.evals.map(e => e.name));
      for (const old of db.prepare('SELECT id, name FROM eval_cases WHERE project_id = ?').all(pid) as { id: string; name: string }[]) {
        if (!keep.has(old.name)) db.prepare('DELETE FROM eval_cases WHERE id = ?').run(old.id);
      }
      for (const e of p.evals) {
        const vals = [canonicalJson(e.input), e.expected_outcome, JSON.stringify(e.must_complete_agents), JSON.stringify(e.expected_findings), e.max_extra_findings];
        const ex = db.prepare('SELECT id FROM eval_cases WHERE project_id = ? AND name = ?').get(pid, e.name) as { id: string } | undefined;
        if (ex) db.prepare('UPDATE eval_cases SET input = ?, expected_outcome = ?, must_complete_agents = ?, expected_findings = ?, max_extra_findings = ? WHERE id = ?').run(...vals, ex.id);
        else db.prepare('INSERT INTO eval_cases (id, project_id, name, input, expected_outcome, must_complete_agents, expected_findings, max_extra_findings, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(uuidv4(), pid, e.name, ...vals, now);
        report.hashes.push({ kind: 'eval', name: `${p.name}/${e.name}`, sha256: hashJson(e) });
      }
    }
  });
  tx();
  return report;
}
