// Contexts attached to one agent, like skills: delivered only in that agent's
// steps, frozen in the run snapshot, carried by forks and harnesses.
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { section, test } from '../harness';
import { TEST_DIR } from '../env';
import db from '../../db/client';
import { loadHarness } from '../../harness/load';
import { applyHarness } from '../../harness/apply';
import { api, createAgent, createProject, createUser, mcp, putFlow } from './helpers';

async function createContext(token: string, name: string, content: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await api('/contexts', { token, body: { name, description: `${name} doc`, files: [{ name: 'CONTEXT.md', content, is_entry: true }], ...extra } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
}

// Start -> first -> second -> End. `first` carries ARCH, `second` carries OPS,
// and PROJ is attached to the project (the whole flow).
async function twoAgentProject() {
  const user = await createUser();
  const p = await createProject(user.token);
  const arch = await createContext(user.token, 'architecture', 'ARCH-DOC: the payments flow goes through one escrow.');
  const ops = await createContext(user.token, 'operations', 'OPS-DOC: deploys need a passkey.');
  await createContext(user.token, 'glossary', 'PROJ-DOC: a pool is a raffle.', { project_attachments: [{ project_id: p.id, share_on_fork: false }] });
  const first = await createAgent(user.token, p.id, 'first', { context_ids: [arch] });
  const second = await createAgent(user.token, p.id, 'second', { context_ids: [ops] });
  const r = await putFlow(user.token, p.id, {
    nodes: [
      { id: 's', type: 'start', x: 0, y: 0 },
      { id: 'a1', type: 'agent', agent_id: first.id, agent_name: 'first', x: 0, y: 0 },
      { id: 'a2', type: 'agent', agent_id: second.id, agent_name: 'second', x: 0, y: 0 },
      { id: 'e', type: 'end', outcome: 'done', x: 0, y: 0 },
    ],
    edges: [{ id: '1', from: 's', to: 'a1' }, { id: '2', from: 'a1', to: 'a2' }, { id: '3', from: 'a2', to: 'e' }],
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return { user, p, arch, ops, first, second };
}

section('agent contexts: API');

test('an agent carries contexts like skills: set on create, replaced on update, listed with the agent', async () => {
  const user = await createUser();
  const p = await createProject(user.token);
  const a = await createContext(user.token, 'a', 'A');
  const b = await createContext(user.token, 'b', 'B');
  const agent = await createAgent(user.token, p.id, 'carrier', { context_ids: [a, b] });
  let got = (await api(`/agents/${agent.id}`, { token: user.token })).body;
  assert.deepStrictEqual(got.contexts.map((c: { name: string }) => c.name), ['a', 'b']);

  await api(`/agents/${agent.id}`, { method: 'PUT', token: user.token, body: { context_ids: [b] } });
  got = (await api(`/agents/${agent.id}`, { token: user.token })).body;
  assert.deepStrictEqual(got.contexts.map((c: { name: string }) => c.name), ['b']);
  const ctx = (await api(`/contexts/${b}`, { token: user.token })).body;
  assert.deepStrictEqual(ctx.agent_ids, [agent.id]);
});

test("an agent cannot carry someone else's context", async () => {
  const owner = await createUser();
  const other = await createUser();
  const foreign = await createContext(other.token, 'theirs', 'X');
  const p = await createProject(owner.token);
  const r = await api('/agents', { token: owner.token, body: { name: 'x', description: 'x', content: 'x', project_ids: [p.id], context_ids: [foreign] } });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /does not belong/);
});

test('the flow editor lists every context of the project owner, and only to the owner', async () => {
  const { user, p } = await twoAgentProject();
  const r = await api(`/contexts?for_project=${p.id}`, { token: user.token });
  assert.deepStrictEqual(r.body.map((c: { name: string }) => c.name).sort(), ['architecture', 'glossary', 'operations']);
  const stranger = await createUser();
  assert.strictEqual((await api(`/contexts?for_project=${p.id}`, { token: stranger.token })).status, 403);
});

section('agent contexts: delivered only in the agent\'s step');

test('server-orchestrated: a context reaches only the agent that carries it; project contexts reach the whole flow', async () => {
  const { p, arch } = await twoAgentProject();
  const s = await mcp(p.api_key, 'workflow.start', { request: 'go' });
  const [head, step1] = s.text.split('## Step 1');
  assert.ok(head!.includes('PROJ-DOC'), 'the project context is in the shared section');
  assert.ok(!head!.includes('ARCH-DOC') && !head!.includes('OPS-DOC'), 'agent contexts are not in the shared section');
  assert.ok(step1!.includes('ARCH-DOC'), 'step 1 carries the context of its agent');
  assert.ok(!step1!.includes('OPS-DOC'), 'step 1 does not carry the context of another agent');

  // Edited after the run started: the run keeps the version it froze.
  await api(`/contexts/${arch}`, { method: 'PUT', token: (await ownerToken(p.id)), body: { files: [{ name: 'CONTEXT.md', content: 'ARCH-DOC v2', is_entry: true }] } });
  const n = await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 1, outputs: [{ node: 'a1', output: {} }] });
  assert.ok(n.text.includes('OPS-DOC'), 'step 2 carries the context of its agent');
  assert.ok(!n.text.includes('ARCH-DOC') && !n.text.includes('PROJ-DOC'), 'step 2 carries nothing else');

  const run = db.prepare("SELECT content_json FROM run_snapshots WHERE run_id = ? AND kind = 'context' AND entity_id = ?").get(s.meta.runId, arch) as { content_json: string };
  assert.ok(run.content_json.includes('ARCH-DOC: the payments flow'), 'the snapshot holds the version the run started with');
  assert.ok(JSON.parse(run.content_json).scope === 'agent');
});

async function ownerToken(projectId: string): Promise<string> {
  const owner = db.prepare('SELECT u.email FROM projects p JOIN users u ON u.id = p.user_id WHERE p.id = ?').get(projectId) as { email: string };
  const login = await api('/auth/login', { body: { email: owner.email, password: 'correct-horse-battery' } });
  return login.body.token;
}

test('the signed export lists the agent contexts among the frozen entities', async () => {
  const { user, p, arch, ops } = await twoAgentProject();
  const s = await mcp(p.api_key, 'workflow.start', { request: 'go' });
  const doc = (await api(`/runs/${s.meta.runId}/export`, { token: user.token })).body;
  const ids = doc.payload.manifest.entities.filter((e: { kind: string }) => e.kind === 'context').map((e: { id: string }) => e.id);
  assert.ok(ids.includes(arch) && ids.includes(ops));
});

test('model-orchestrated: each agent block carries its own contexts, not the shared section', async () => {
  const { user, p } = await twoAgentProject();
  await api(`/projects/${p.id}/execution-mode`, { method: 'PATCH', token: user.token, body: { mode: 'compiled' } });
  const s = await mcp(p.api_key, 'workflow.start', { request: 'go' });
  const shared = s.text.split('## Available sub-agents')[0]!;
  assert.ok(shared.includes('PROJ-DOC') && !shared.includes('ARCH-DOC'));
  const firstBlock = s.text.split('### Node `a1`')[1]!.split('### Node `a2`')[0]!;
  assert.ok(firstBlock.includes('ARCH-DOC') && !firstBlock.includes('OPS-DOC'));
});

section('agent contexts: forks, harnesses, analytics');

test('a project fork copies the contexts its agents carry; project contexts still follow share_on_fork', async () => {
  const { user, p, arch } = await twoAgentProject();
  await api(`/projects/${p.id}/visibility`, { method: 'PATCH', token: user.token, body: { is_public: true } });
  const other = await createUser();
  const fork = await api(`/projects/${p.id}/fork`, { method: 'POST', token: other.token });
  assert.strictEqual(fork.status, 201, JSON.stringify(fork.body));
  const carried = db.prepare(
    `SELECT a.name AS agent, c.name AS context, c.user_id, c.forked_from FROM project_agents pa
     JOIN agent_contexts ac ON ac.agent_id = pa.agent_id JOIN agents a ON a.id = pa.agent_id JOIN contexts c ON c.id = ac.context_id
     WHERE pa.project_id = ? ORDER BY a.name`
  ).all(fork.body.id) as { agent: string; context: string; user_id: string; forked_from: string }[];
  assert.deepStrictEqual(carried.map(r => [r.agent, r.context]), [['first', 'architecture'], ['second', 'operations']]);
  assert.ok(carried.every(r => r.user_id === other.id), 'the copies belong to the new owner');
  assert.strictEqual(carried[0]!.forked_from, arch);
  const projectLevel = db.prepare('SELECT COUNT(*) AS n FROM project_contexts WHERE project_id = ?').get(fork.body.id) as { n: number };
  assert.strictEqual(projectLevel.n, 0, 'the glossary was attached with share_on_fork = false');

  const s = await mcp(fork.body.api_key, 'workflow.start', { request: 'go' });
  assert.ok(s.text.split('## Step 1')[1]!.includes('ARCH-DOC'), 'the forked flow delivers the copied context');
});

test('an agent fork carries its contexts too', async () => {
  const { user, first } = await twoAgentProject();
  const f = await api(`/agents/${first.id}/fork`, { method: 'POST', token: user.token });
  assert.strictEqual(f.status, 201);
  assert.deepStrictEqual(f.body.contexts.map((c: { name: string }) => c.name), ['architecture (fork)']);
});

test('harness.json: agents.<name>.contexts attaches contexts to one agent; an unknown one is refused', async () => {
  const dir = path.join(TEST_DIR, 'harness-agent-ctx');
  fs.mkdirSync(path.join(dir, 'agents', 'gate'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'contexts', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents', 'gate', 'AGENT.md'), 'Gate.');
  fs.writeFileSync(path.join(dir, 'contexts', 'rules', 'CONTEXT.md'), 'RULES-DOC');
  const doc = {
    name: 'agent-ctx', contexts: { rules: { description: 'rules' } },
    agents: { gate: { description: 'gate', contexts: ['rules'] } },
    projects: [{ name: 'agent ctx project', flow: {
      nodes: [{ id: 's', type: 'start' }, { id: 'g', type: 'agent', agent: 'gate' }, { id: 'e', type: 'end', outcome: 'done' }],
      edges: [{ id: '1', from: 's', to: 'g' }, { id: '2', from: 'g', to: 'e' }],
    } }],
  };
  fs.writeFileSync(path.join(dir, 'harness.json'), JSON.stringify(doc));
  const owner = await createUser();
  const report = applyHarness(loadHarness(dir), owner.id);
  const key = report.newProjectKeys[0]!.api_key;
  const s = await mcp(key, 'workflow.start', { request: 'go' });
  const [head, step1] = s.text.split('## Step 1');
  assert.ok(!head!.includes('RULES-DOC') && step1!.includes('RULES-DOC'));
  assert.deepStrictEqual(applyHarness(loadHarness(dir), owner.id).updated, [], 'applying again changes nothing');

  fs.writeFileSync(path.join(dir, 'harness.json'), JSON.stringify({ ...doc, agents: { gate: { description: 'gate', contexts: ['missing'] } } }));
  assert.throws(() => loadHarness(dir), /unknown context "missing"/);
});

test('analytics count a context once per run that delivered it, through its project or its agents', async () => {
  const { user, p, arch } = await twoAgentProject();
  const s = await mcp(p.api_key, 'workflow.start', { request: 'go' });
  await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 1, outputs: [{ node: 'a1', output: {} }] });
  const stats = (await api(`/analytics?project_id=${p.id}`, { token: user.token })).body.contexts_stats as { id: string; name: string; agents_carrying: number; runs_included: number }[];
  const a = stats.find(c => c.id === arch)!;
  assert.deepStrictEqual([a.agents_carrying, a.runs_included], [1, 1]);
  const glossary = stats.find(c => c.name === 'glossary')!;
  assert.strictEqual(glossary.runs_included, 1);
});
