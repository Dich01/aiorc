// Skills reach the model in the order they were selected on the agent, not in
// database order (the dashboard says "in the order you selected them").
import assert from 'assert';
import { section, test } from '../harness';
import { api, createProject, createUser, mcp, putFlow } from './helpers';

section('skills: delivery order');

test('skills are sent in the order selected on the agent', async () => {
  const u = await createUser();
  const p = await createProject(u.token);
  const mk = async (name: string) => (await api('/skills', { token: u.token, body: { name, description: name, files: [{ name: 'SKILL.md', content: `BODY-${name}`, is_entry: true }] } })).body.id as string;
  // Six skills selected in an order unrelated to creation or id order: a
  // database-order delivery matches it by chance once in 720 runs.
  const names = ['s1', 's2', 's3', 's4', 's5', 's6'];
  const ids: Record<string, string> = {};
  for (const n of names) ids[n] = await mk(n);
  const chosen = ['s4', 's1', 's6', 's2', 's5', 's3'];
  const a = await api('/agents', { token: u.token, body: { name: 'w', description: 'w', content: 'work', project_ids: [p.id], skill_ids: chosen.map(n => ids[n]) } });
  assert.strictEqual(a.status, 201, JSON.stringify(a.body));
  const f = await putFlow(u.token, p.id, {
    nodes: [{ id: 's', type: 'start', x: 0, y: 0 }, { id: 'n', type: 'agent', agent_id: a.body.id, agent_name: 'w', x: 0, y: 0 }, { id: 'e', type: 'end', outcome: 'ok', x: 0, y: 0 }],
    edges: [{ id: '1', from: 's', to: 'n' }, { id: '2', from: 'n', to: 'e' }],
  });
  assert.strictEqual(f.status, 200, JSON.stringify(f.body));
  const s = await mcp(p.api_key, 'workflow.start', { request: 'x' });
  const order = chosen.map(n => s.text.indexOf(`BODY-${n}`));
  assert.ok(order.every(i => i >= 0), 'every skill is delivered');
  assert.deepStrictEqual([...order].sort((x, y) => x - y), order, 'in the order selected');
});
