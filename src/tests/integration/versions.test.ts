// Versions and history, notifications, and forks that update from the
// project they came from.
import assert from 'assert';
import { section, test } from '../harness';
import db from '../../db/client';
import { api, createAgent, createProject, createUser, mcp, putFlow } from './helpers';

async function createSkill(token: string, name: string, content: string): Promise<string> {
  const r = await api('/skills', { token, body: { name, description: `${name} skill`, files: [{ name: 'SKILL.md', content, is_entry: true }] } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
}

async function createContext(token: string, name: string, content: string): Promise<string> {
  const r = await api('/contexts', { token, body: { name, description: `${name} doc`, files: [{ name: 'CONTEXT.md', content, is_entry: true }] } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
}

// Start -> worker -> End, the worker with one skill and one context.
async function oneAgentProject() {
  const user = await createUser();
  const p = await createProject(user.token);
  const skill = await createSkill(user.token, `rules-${p.id.slice(0, 4)}`, 'RULES-V1');
  const ctx = await createContext(user.token, `profile-${p.id.slice(0, 4)}`, 'PROFILE-V1');
  const agent = await createAgent(user.token, p.id, `worker-${p.id.slice(0, 4)}`, { skill_ids: [skill], context_ids: [ctx] });
  const r = await putFlow(user.token, p.id, {
    nodes: [
      { id: 's', type: 'start', x: 0, y: 0 },
      { id: 'a', type: 'agent', agent_id: agent.id, agent_name: 'worker', x: 0, y: 0 },
      { id: 'e', type: 'end', outcome: 'done', x: 0, y: 0 },
    ],
    edges: [{ id: '1', from: 's', to: 'a' }, { id: '2', from: 'a', to: 'e' }],
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return { user, p, skill, ctx, agent };
}

const notes = (userId: string, kind: string) =>
  db.prepare('SELECT title, body, link, read_at FROM notifications WHERE user_id = ? AND kind = ? ORDER BY created_at').all(userId, kind) as { title: string; body: string; link: string; read_at: number | null }[];

section('versions and history');

test('an edit makes a new version, a save without changes does not, and the author and note are kept', async () => {
  const user = await createUser();
  const id = await createSkill(user.token, 'versioned', 'ONE');
  let h = await api(`/versions/skill/${id}`, { token: user.token });
  assert.strictEqual(h.status, 200);
  assert.strictEqual(h.body.current, 1);

  await api(`/skills/${id}`, { method: 'PUT', token: user.token, body: { files: [{ name: 'SKILL.md', content: 'TWO', is_entry: true }], version_note: 'second take' } });
  await api(`/skills/${id}`, { method: 'PUT', token: user.token, body: { files: [{ name: 'SKILL.md', content: 'TWO', is_entry: true }] } });
  h = await api(`/versions/skill/${id}`, { token: user.token });
  assert.strictEqual(h.body.current, 2, 'the unchanged save added nothing');
  assert.strictEqual(h.body.versions[0].note, 'second take');
  assert.ok(h.body.versions[0].author.includes('u'), 'author shown');

  const v1 = await api(`/versions/skill/${id}/1`, { token: user.token });
  assert.strictEqual(v1.body.content.files[0].content, 'ONE');
});

test('restoring puts back an old version as a new one; only the owner or an admin can', async () => {
  const user = await createUser();
  const stranger = await createUser();
  const id = await createSkill(user.token, 'restorable', 'FIRST');
  await api(`/skills/${id}`, { method: 'PUT', token: user.token, body: { files: [{ name: 'SKILL.md', content: 'BROKEN', is_entry: true }] } });
  const denied = await api(`/versions/skill/${id}/1/restore`, { method: 'POST', token: stranger.token });
  assert.strictEqual(denied.status, 403);
  const r = await api(`/versions/skill/${id}/1/restore`, { method: 'POST', token: user.token });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.version, 3);
  const files = (await api(`/skills/${id}`, { token: user.token })).body.files;
  assert.strictEqual(files[0].content, 'FIRST');
  const h = await api(`/versions/skill/${id}`, { token: user.token });
  assert.strictEqual(h.body.versions[0].note, 'restored v1');
});

test('history is visible to whoever has access: owner, project members; not to strangers', async () => {
  const { user, p, agent } = await oneAgentProject();
  const member = await createUser();
  const stranger = await createUser();
  await api(`/projects/${p.id}/invitations`, { token: user.token, body: { email: member.email } });
  assert.strictEqual((await api(`/versions/agent/${agent.id}`, { token: member.token })).status, 200);
  assert.strictEqual((await api(`/versions/project/${p.id}`, { token: member.token })).status, 200);
  assert.strictEqual((await api(`/versions/agent/${agent.id}`, { token: stranger.token })).status, 403);
  const h = await api(`/versions/agent/${agent.id}`, { token: member.token });
  assert.strictEqual(h.body.can_restore, false);
});

test('a run records which version of each piece it used, and the run detail shows it', async () => {
  const { user, p, agent } = await oneAgentProject();
  await api(`/agents/${agent.id}`, { method: 'PUT', token: user.token, body: { description: 'sharper' } });
  const s = await mcp(p.api_key, 'workflow.start', { request: 'go' });
  const runId = s.meta.runId as string;
  const used = db.prepare("SELECT version FROM run_entity_versions WHERE run_id = ? AND kind = 'agent'").get(runId) as { version: number };
  assert.strictEqual(used.version, 2);
  const detail = await api(`/runs/${runId}`, { token: user.token });
  const snap = detail.body.snapshots.find((x: { kind: string }) => x.kind === 'agent');
  assert.strictEqual(snap.version, 2);
});

section('notifications');

test('a change to a shared project tells its members, not the person who made it', async () => {
  const { user, p, agent } = await oneAgentProject();
  const member = await createUser();
  await api(`/projects/${p.id}/invitations`, { token: user.token, body: { email: member.email } });
  await api(`/agents/${agent.id}`, { method: 'PUT', token: user.token, body: { description: 'v2' } });
  await api(`/agents/${agent.id}`, { method: 'PUT', token: user.token, body: { description: 'v3' } });
  const got = notes(member.id, 'shared_changed');
  assert.strictEqual(got.length, 1, 'unread changes of one project are grouped');
  assert.ok(got[0]!.body.split('\n').length >= 2, got[0]!.body);
  assert.strictEqual(notes(user.id, 'shared_changed').length, 0);
  assert.strictEqual(notes(member.id, 'invitation').length, 1, 'the invitation itself was announced');
});

test('the list, the unread count and marking read', async () => {
  const { user, p, agent } = await oneAgentProject();
  const member = await createUser();
  await api(`/projects/${p.id}/invitations`, { token: user.token, body: { email: member.email } });
  await api(`/agents/${agent.id}`, { method: 'PUT', token: user.token, body: { description: 'changed' } });
  let c = await api('/notifications/unread-count', { token: member.token });
  assert.strictEqual(c.body.unread, 2);
  const list = await api('/notifications', { token: member.token });
  assert.strictEqual(list.body.items.length, 2);
  const one = await api(`/notifications/${list.body.items[0].id}/read`, { method: 'POST', token: member.token });
  assert.strictEqual(one.body.unread, 1);
  assert.strictEqual((await api(`/notifications/${list.body.items[1].id}/read`, { method: 'POST', token: user.token })).status, 404, "someone else's notification");
  await api('/notifications/read-all', { method: 'POST', token: member.token });
  c = await api('/notifications/unread-count', { token: member.token });
  assert.strictEqual(c.body.unread, 0);
});

test('forking tells the owner; a new issue tells the admins; a comment tells the author', async () => {
  const { user, p } = await oneAgentProject();
  await api(`/projects/${p.id}/visibility`, { method: 'PATCH', token: user.token, body: { is_public: true } });
  const other = await createUser();
  assert.strictEqual((await api(`/projects/${p.id}/fork`, { method: 'POST', token: other.token })).status, 201);
  assert.strictEqual(notes(user.id, 'forked').length, 1);

  const admin = await createUser({ role: 'admin' });
  const issue = await api('/issues', { token: other.token, body: { title: 'The editor loses my flow', type: 'bug' } });
  assert.strictEqual(issue.status, 201);
  assert.ok(notes(admin.id, 'issue').some(n => n.title.includes('The editor loses my flow')));
  await api(`/issues/${issue.body.id}/comments`, { token: admin.token, body: { body: 'Which browser?' } });
  assert.ok(notes(other.id, 'issue').some(n => n.title.includes('New comment')));
});

test('a run cancelled by someone else tells the owner', async () => {
  const { user, p } = await oneAgentProject();
  const member = await createUser();
  await api(`/projects/${p.id}/invitations`, { token: user.token, body: { email: member.email } });
  const s = await mcp(p.api_key, 'workflow.start', { request: 'go' });
  const admin = await createUser({ role: 'admin' });
  const r = await api(`/runs/${s.meta.runId}/cancel`, { method: 'POST', token: admin.token });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.ok(notes(user.id, 'run_problem').some(n => n.title.includes('cancelled')));
  assert.strictEqual(notes(admin.id, 'run_problem').length, 0);
});

section('forks that update from the original');

test('the fork owner is told when the original changes, sees what changed, and updates everything at once', async () => {
  const { user, p, skill, agent } = await oneAgentProject();
  await api(`/projects/${p.id}/visibility`, { method: 'PATCH', token: user.token, body: { is_public: true } });
  const other = await createUser();
  const fork = (await api(`/projects/${p.id}/fork`, { method: 'POST', token: other.token })).body;
  let up = await api(`/projects/${fork.id}/upstream`, { token: other.token });
  assert.strictEqual(up.body.linked, true);
  assert.deepStrictEqual(up.body.changes, []);

  await api(`/skills/${skill}`, { method: 'PUT', token: user.token, body: { files: [{ name: 'SKILL.md', content: 'RULES-V2', is_entry: true }] } });
  await api(`/agents/${agent.id}`, { method: 'PUT', token: user.token, body: { description: 'better worker' } });
  assert.ok(notes(other.id, 'upstream_changed').length >= 1);

  up = await api(`/projects/${fork.id}/upstream`, { token: other.token });
  assert.deepStrictEqual(up.body.changes.map((c: { kind: string; change: string }) => `${c.kind}:${c.change}`).sort(), ['agent:changed', 'skill:changed']);
  const sync = await api(`/projects/${fork.id}/upstream/sync`, { method: 'POST', token: other.token });
  assert.strictEqual(sync.status, 200, JSON.stringify(sync.body));
  assert.deepStrictEqual(sync.body.status.changes, []);
  assert.ok(notes(other.id, 'upstream_changed').every(n => n.read_at), 'updating clears the notice');

  const s = await mcp(fork.api_key, 'workflow.start', { request: 'go' });
  assert.ok(s.text.includes('RULES-V2'), 'the fork now runs the new skill');
});

test('updating keeps what the fork made its own: its contexts, added skill files and name', async () => {
  const { user, p, skill, agent } = await oneAgentProject();
  await api(`/projects/${p.id}/visibility`, { method: 'PATCH', token: user.token, body: { is_public: true } });
  const other = await createUser();
  const fork = (await api(`/projects/${p.id}/fork`, { method: 'POST', token: other.token })).body;
  await api(`/projects/${fork.id}`, { method: 'PATCH', token: other.token, body: { name: 'my review' } });
  const forkAgent = (db.prepare('SELECT agent_id FROM project_agents WHERE project_id = ?').get(fork.id) as { agent_id: string }).agent_id;
  const forkSkill = (db.prepare('SELECT skill_id FROM agent_skills WHERE agent_id = ?').get(forkAgent) as { skill_id: string }).skill_id;
  const mine = await createContext(other.token, 'our-architecture', 'OUR-ARCH');
  await api(`/agents/${forkAgent}`, { method: 'PUT', token: other.token, body: { context_ids: [mine] } });
  await api(`/skills/${forkSkill}`, { method: 'PUT', token: other.token, body: { files: [
    { name: 'SKILL.md', content: 'RULES-V1', is_entry: true },
    { name: 'payments-rules.md', content: 'OUR-RULES' },
  ] } });

  await api(`/skills/${skill}`, { method: 'PUT', token: user.token, body: { files: [{ name: 'SKILL.md', content: 'RULES-V2', is_entry: true }] } });
  await api(`/agents/${agent.id}`, { method: 'PUT', token: user.token, body: { description: 'v2' } });
  const up = await api(`/projects/${fork.id}/upstream`, { token: other.token });
  assert.ok(up.body.changes.find((c: { kind: string }) => c.kind === 'skill').local_changes, 'the fork is warned its own edit is involved');
  assert.strictEqual((await api(`/projects/${fork.id}/upstream/sync`, { method: 'POST', token: other.token })).status, 200);

  const s = await mcp(fork.api_key, 'workflow.start', { request: 'go' });
  for (const want of ['RULES-V2', 'OUR-RULES', 'OUR-ARCH']) assert.ok(s.text.includes(want), `${want} reaches the step`);
  const name = (db.prepare('SELECT name FROM projects WHERE id = ?').get(fork.id) as { name: string }).name;
  assert.strictEqual(name, 'my review');
});

test('an agent added to the original arrives with the update; only the fork owner can update', async () => {
  const { user, p, agent } = await oneAgentProject();
  await api(`/projects/${p.id}/visibility`, { method: 'PATCH', token: user.token, body: { is_public: true } });
  const other = await createUser();
  const fork = (await api(`/projects/${p.id}/fork`, { method: 'POST', token: other.token })).body;
  const extra = await createAgent(user.token, p.id, `checker-${p.id.slice(0, 4)}`);
  await putFlow(user.token, p.id, {
    nodes: [
      { id: 's', type: 'start', x: 0, y: 0 },
      { id: 'a', type: 'agent', agent_id: agent.id, agent_name: 'worker', x: 0, y: 0 },
      { id: 'c', type: 'agent', agent_id: extra.id, agent_name: 'checker', x: 0, y: 0 },
      { id: 'e', type: 'end', outcome: 'done', x: 0, y: 0 },
    ],
    edges: [{ id: '1', from: 's', to: 'a' }, { id: '2', from: 'a', to: 'c' }, { id: '3', from: 'c', to: 'e' }],
  });
  const up = await api(`/projects/${fork.id}/upstream`, { token: other.token });
  assert.ok(up.body.changes.some((c: { kind: string; change: string }) => c.kind === 'agent' && c.change === 'added'));
  assert.strictEqual((await api(`/projects/${fork.id}/upstream/sync`, { method: 'POST', token: user.token })).status, 403);
  const r = await api(`/projects/${fork.id}/upstream/sync`, { method: 'POST', token: other.token });
  assert.strictEqual(r.body.added, 1);
  const flow = JSON.parse((db.prepare('SELECT flow_json FROM project_flows WHERE project_id = ?').get(fork.id) as { flow_json: string }).flow_json);
  const ids = flow.nodes.filter((n: { type: string }) => n.type === 'agent').map((n: { agent_id: string }) => n.agent_id);
  assert.strictEqual(ids.length, 2);
  const owners = ids.map((id: string) => (db.prepare('SELECT user_id FROM agents WHERE id = ?').get(id) as { user_id: string }).user_id);
  assert.ok(owners.every((o: string) => o === other.id), 'the flow points at the fork\'s own copies');
});
