import assert from 'assert';
import { section, test } from '../harness';
import db from '../../db/client';
import { api, createAgent, createProject, createUser, mcp, putFlow } from './helpers';

// start → review ─(blocking eq true)→ End "changes-requested"
//                └─(default)───────→ End "clean"
async function reviewProject() {
  const u = await createUser();
  const p = await createProject(u.token);
  const review = await createAgent(u.token, p.id, 'review', {
    output_schema: { type: 'object', required: ['blocking', 'findings'], properties: { blocking: { type: 'boolean' }, findings: { type: 'array' } } },
  });
  const r = await putFlow(u.token, p.id, {
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 0 },
      { id: 'rev', type: 'agent', agent_id: review.id, x: 0, y: 0 },
      { id: 'cr', type: 'end', outcome: 'changes-requested', x: 0, y: 0 },
      { id: 'clean', type: 'end', outcome: 'clean', x: 0, y: 0 },
    ],
    edges: [
      { id: 'e0', from: 'start', to: 'rev' },
      { id: 'block', from: 'rev', to: 'cr', when: { path: 'blocking', op: 'eq', value: true } },
      { id: 'ok', from: 'rev', to: 'clean', default: true },
    ],
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const ev = await api('/evals', { token: u.token, body: {
    project_id: p.id, name: 'seeded sql injection', input: { request: 'review PR 1' },
    expected_outcome: 'changes-requested', must_complete_agents: ['review'],
    expected_findings: [{ file: 'src/db.ts', category: 'security', min_severity: 'high' }], max_extra_findings: 0,
  } });
  assert.strictEqual(ev.status, 201, JSON.stringify(ev.body));
  return { u, p, caseId: ev.body.id as string };
}

const verdict = (runId: string) => db.prepare('SELECT eval_verdict, eval_reasons FROM runs WHERE id = ?').get(runId) as { eval_verdict: string; eval_reasons: string };

section('evals graded from the event chain (F10)');

test('a run that reports the seeded bug and ends at the expected End passes', async () => {
  const { p, caseId } = await reviewProject();
  const s = await mcp(p.api_key, 'workflow.start', { evalCase: caseId });
  await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 1, outputs: [{ node: 'rev', output: { blocking: true, findings: [{ file: 'src/db.ts', category: 'security', severity: 'critical' }] } }] });
  assert.strictEqual(verdict(s.meta.runId).eval_verdict, 'pass');
});

test('a different End fails, even if the outcome text overlaps', async () => {
  const { p, caseId } = await reviewProject();
  const s = await mcp(p.api_key, 'workflow.start', { evalCase: caseId });
  await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 1, outputs: [{ node: 'rev', output: { blocking: false, findings: [{ file: 'src/db.ts', category: 'security', severity: 'high' }] } }] });
  const v = verdict(s.meta.runId);
  assert.strictEqual(v.eval_verdict, 'fail');
  assert.ok(v.eval_reasons.includes('changes-requested'));
});

test('invalid outputs never complete the run, so the eval cannot pass', async () => {
  const { p, caseId } = await reviewProject();
  const s = await mcp(p.api_key, 'workflow.start', { evalCase: caseId });
  const r = await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 1, outputs: [{ node: 'rev', output: { looks: 'good' } }] });
  assert.strictEqual(r.meta.error, 'invalid_output');
  assert.notStrictEqual(verdict(s.meta.runId).eval_verdict, 'pass');
});

test('missing the seeded finding or adding noise fails the eval', async () => {
  const { p, caseId } = await reviewProject();
  const s = await mcp(p.api_key, 'workflow.start', { evalCase: caseId });
  await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 1, outputs: [{ node: 'rev', output: { blocking: true, findings: [{ file: 'src/db.ts', category: 'security', severity: 'high' }, { file: 'README.md', category: 'style', severity: 'low' }] } }] });
  const v = verdict(s.meta.runId);
  assert.strictEqual(v.eval_verdict, 'fail');
  assert.ok(v.eval_reasons.includes('beyond the expected'));
});

test('the eval input stored in the case replaces what the client sends', async () => {
  const { p, caseId } = await reviewProject();
  const s = await mcp(p.api_key, 'workflow.start', { evalCase: caseId, request: 'something else' });
  const row = db.prepare('SELECT input FROM runs WHERE id = ?').get(s.meta.runId) as { input: string };
  assert.deepStrictEqual(JSON.parse(row.input), { request: 'review PR 1' });
});
