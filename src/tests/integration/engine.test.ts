import assert from 'assert';
import { section, test } from '../harness';
import db from '../../db/client';
import { api, createAgent, createProject, createUser, mcp, putFlow } from './helpers';

// End-to-end regression tests for the engine, driven over MCP exactly as a
// client would. Each one maps to a failure found in the audit (F1-F7).

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['verdict'],
  properties: { verdict: { enum: ['PASS', 'FAIL'] }, notes: { type: 'string' } },
  additionalProperties: false,
};

// start → review ─(verdict = FAIL)→ fix → review
//                └─(default)──────→ End "clean"
async function reviewLoopProject() {
  const u = await createUser();
  const p = await createProject(u.token);
  const review = await createAgent(u.token, p.id, 'review', { output_schema: VERDICT_SCHEMA });
  const fix = await createAgent(u.token, p.id, 'fix');
  const r = await putFlow(u.token, p.id, {
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 0 },
      { id: 'rev', type: 'agent', agent_id: review.id, agent_name: 'review', x: 0, y: 0 },
      { id: 'fix', type: 'agent', agent_id: fix.id, agent_name: 'fix', x: 0, y: 0 },
      { id: 'clean', type: 'end', outcome: 'clean', x: 0, y: 0 },
    ],
    edges: [
      { id: 'e0', from: 'start', to: 'rev' },
      { id: 'fail', from: 'rev', to: 'fix', when: { path: 'verdict', op: 'eq', value: 'FAIL' } },
      { id: 'ok', from: 'rev', to: 'clean', default: true },
      { id: 'back', from: 'fix', to: 'rev' },
    ],
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return { u, p, review, fix };
}

// start → triage ─(e_bug: "it is a bug")→ End "bug"
//                └─(e_other, default)──→ fork → [sec, cor] → report → End "reported"
async function forkProject() {
  const u = await createUser();
  const p = await createProject(u.token);
  const triage = await createAgent(u.token, p.id, 'triage');
  const sec = await createAgent(u.token, p.id, 'sec');
  const cor = await createAgent(u.token, p.id, 'cor');
  const report = await createAgent(u.token, p.id, 'report');
  const r = await putFlow(u.token, p.id, {
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 0 },
      { id: 'tri', type: 'agent', agent_id: triage.id, x: 0, y: 0 },
      { id: 'fork', type: 'parallel', x: 0, y: 0 },
      { id: 'sec', type: 'agent', agent_id: sec.id, x: 0, y: 0 },
      { id: 'cor', type: 'agent', agent_id: cor.id, x: 0, y: 0 },
      { id: 'rep', type: 'agent', agent_id: report.id, x: 0, y: 0 },
      { id: 'bug', type: 'end', outcome: 'bug', x: 0, y: 0 },
      { id: 'done', type: 'end', outcome: 'reported', x: 0, y: 0 },
    ],
    edges: [
      { id: 'e0', from: 'start', to: 'tri' },
      { id: 'e_bug', from: 'tri', to: 'bug', condition: 'it is a bug' },
      { id: 'e_other', from: 'tri', to: 'fork' },
      { id: 'b1', from: 'fork', to: 'sec' },
      { id: 'b2', from: 'fork', to: 'cor' },
      { id: 'j1', from: 'sec', to: 'rep' },
      { id: 'j2', from: 'cor', to: 'rep' },
      { id: 'e_done', from: 'rep', to: 'done' },
    ],
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return { u, p, triage };
}

const runStatus = (runId: string) => (db.prepare('SELECT status, outcome FROM runs WHERE id = ?').get(runId) as { status: string; outcome: string });

section('engine: outputs are required and validated (F1)');

test('workflow.next without outputs is rejected by the argument schema', async () => {
  const { p } = await reviewLoopProject();
  const s = await mcp(p.api_key, 'workflow.start', { request: 'review this' });
  const r = await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 1 });
  assert.strictEqual(r.error?.code, -32602);
});

test('an output that does not match the schema is rejected and the step does not advance', async () => {
  const { p } = await reviewLoopProject();
  const s = await mcp(p.api_key, 'workflow.start', { request: 'review this' });
  assert.strictEqual(s.meta.step, 1);
  const bad = await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 1, outputs: [{ node: 'rev', output: { verdict: 'MAYBE' } }] });
  assert.strictEqual(bad.meta.error, 'invalid_output');
  assert.strictEqual(bad.meta.step, 1);
  const empty = await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 1, outputs: [{ node: 'rev', output: '' }] });
  assert.strictEqual(empty.meta.error, 'invalid_output');
  const outputs = (db.prepare('SELECT COUNT(*) AS n FROM run_step_outputs WHERE run_id = ?').get(s.meta.runId) as { n: number }).n;
  assert.strictEqual(outputs, 0);
  assert.strictEqual(runStatus(s.meta.runId).status, 'running');
});

test('dispatched is not completed: usage counts only accepted outputs, stored whole', async () => {
  const { p } = await reviewLoopProject();
  const s = await mcp(p.api_key, 'workflow.start', { request: 'review this' });
  const executedBefore = (db.prepare("SELECT COUNT(*) AS n FROM agent_usage WHERE run_id = ? AND source = 'executed'").get(s.meta.runId) as { n: number }).n;
  assert.strictEqual(executedBefore, 0);
  const long = 'x'.repeat(5000);
  const r = await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 1, outputs: [{ node: 'rev', output: { verdict: 'PASS', notes: long } }] });
  assert.strictEqual(r.meta.status, 'completed');
  const row = db.prepare('SELECT output_json FROM run_step_outputs WHERE run_id = ?').get(s.meta.runId) as { output_json: string };
  assert.strictEqual(JSON.parse(row.output_json).notes.length, 5000, 'outputs are not truncated');
  const executed = (db.prepare("SELECT COUNT(*) AS n FROM agent_usage WHERE run_id = ? AND source = 'executed'").get(s.meta.runId) as { n: number }).n;
  assert.strictEqual(executed, 1);
});

section('engine: exact transitions (F2, F3)');

test('transition "none" or free text containing "end" never ends the run', async () => {
  const { p } = await forkProject();
  const s = await mcp(p.api_key, 'workflow.start', { request: 'triage this' });
  for (const t of ['none', 'end', 'sending', 'pending', 'backend', 'it is a bug']) {
    const r = await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 1, outputs: [{ node: 'tri', output: { kind: 'x' } }], transition: t });
    assert.strictEqual(r.meta.error, 'invalid_transition', `"${t}" must be rejected`);
  }
  assert.strictEqual(runStatus(s.meta.runId).status, 'running');
});

test('the exact edge id chosen by the client is taken', async () => {
  const { p } = await forkProject();
  const s = await mcp(p.api_key, 'workflow.start', { request: 'triage this' });
  assert.strictEqual(s.meta.transition.kind, 'choice');
  const r = await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 1, outputs: [{ node: 'tri', output: { kind: 'bug' } }], transition: 'e_bug' });
  assert.strictEqual(r.meta.status, 'completed');
  assert.strictEqual(runStatus(s.meta.runId).outcome, 'bug');
});

test('with rule edges the server picks: verdict FAIL goes to fix, PASS ends clean', async () => {
  const { p } = await reviewLoopProject();
  const s = await mcp(p.api_key, 'workflow.start', { request: 'review this' });
  const r1 = await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 1, outputs: [{ node: 'rev', output: { verdict: 'FAIL' } }] });
  assert.deepStrictEqual(r1.meta.dispatched.map((d: { node: string }) => d.node), ['fix']);
  const r2 = await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 2, outputs: [{ node: 'fix', output: { patched: true } }] });
  assert.deepStrictEqual(r2.meta.dispatched.map((d: { node: string }) => d.node), ['rev']);
  const r3 = await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 3, outputs: [{ node: 'rev', output: { verdict: 'PASS' } }] });
  assert.strictEqual(r3.meta.status, 'completed');
  assert.strictEqual(runStatus(s.meta.runId).outcome, 'clean');
});

test('a client cannot steer a rule exit', async () => {
  const { p } = await reviewLoopProject();
  const s = await mcp(p.api_key, 'workflow.start', { request: 'review this' });
  const r = await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 1, outputs: [{ node: 'rev', output: { verdict: 'FAIL' } }], transition: 'ok' });
  assert.strictEqual(r.meta.error, 'invalid_transition');
});

section('engine: fork with a real join (F4)');

test('a fork advances only once every branch output has arrived', async () => {
  const { p } = await forkProject();
  const s = await mcp(p.api_key, 'workflow.start', { request: 'triage this' });
  const f = await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 1, outputs: [{ node: 'tri', output: { kind: 'feature' } }], transition: 'e_other' });
  assert.deepStrictEqual(f.meta.dispatched.map((d: { node: string }) => d.node).sort(), ['cor', 'sec']);
  const half = await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 2, outputs: [{ node: 'sec', output: { findings: [] } }] });
  assert.strictEqual(half.meta.error, 'missing_output');
  const both = await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 2, outputs: [{ node: 'sec', output: { findings: [] } }, { node: 'cor', output: { findings: [] } }] });
  assert.deepStrictEqual(both.meta.dispatched.map((d: { node: string }) => d.node), ['rep']);
  const end = await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 3, outputs: [{ node: 'rep', output: { summary: 'ok' } }] });
  assert.strictEqual(end.meta.status, 'completed');
  assert.strictEqual(runStatus(s.meta.runId).outcome, 'reported');
});

section('engine: saving invalid flows (F5)');

test('saving a flow with an unreachable node, no path to End or duplicate ids gives 400 with the reason', async () => {
  const u = await createUser();
  const p = await createProject(u.token);
  const a = await createAgent(u.token, p.id, 'solo');
  const base = [
    { id: 'start', type: 'start', x: 0, y: 0 },
    { id: 'a', type: 'agent', agent_id: a.id, x: 0, y: 0 },
    { id: 'x', type: 'end', x: 0, y: 0 },
  ];
  const unreachable = await putFlow(u.token, p.id, { nodes: [...base, { id: 'z', type: 'agent', agent_id: a.id, x: 0, y: 0 }], edges: [{ id: '1', from: 'start', to: 'a' }, { id: '2', from: 'a', to: 'x' }, { id: '3', from: 'z', to: 'x' }] });
  assert.strictEqual(unreachable.status, 400);
  assert.ok(unreachable.body.validation_errors.some((m: string) => /cannot be reached/.test(m)));
  const noEnd = await putFlow(u.token, p.id, { nodes: base.slice(0, 2), edges: [{ id: '1', from: 'start', to: 'a' }] });
  assert.strictEqual(noEnd.status, 400);
  assert.ok(noEnd.body.validation_errors.some((m: string) => /no End node/.test(m)));
  const dup = await putFlow(u.token, p.id, { nodes: [...base, { id: 'a', type: 'end', x: 0, y: 0 }], edges: [{ id: '1', from: 'start', to: 'a' }, { id: '2', from: 'a', to: 'x' }] });
  assert.strictEqual(dup.status, 400);
  assert.ok(dup.body.validation_errors.some((m: string) => /share the id/.test(m)));
});

test('rule edges and defaults survive a save and reload', async () => {
  const { u, p } = await reviewLoopProject();
  const got = await api(`/projects/${p.id}/flow`, { token: u.token });
  const fail = got.body.flow.edges.find((e: { id: string }) => e.id === 'fail');
  assert.deepStrictEqual(fail.when, { path: 'verdict', op: 'eq', value: 'FAIL' });
  assert.strictEqual(got.body.flow.edges.find((e: { id: string }) => e.id === 'ok').default, true);
});

section('engine: instructions frozen per run (F6)');

test('editing an agent mid-run does not change the run; deleting a referenced agent is 409', async () => {
  const { u, p, review } = await reviewLoopProject();
  const s = await mcp(p.api_key, 'workflow.start', { request: 'review this' });
  await api(`/agents/${review.id}`, { method: 'PUT', token: u.token, body: { content: 'EDITED INSTRUCTIONS', output_schema: { type: 'object' } } });
  const r1 = await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 1, outputs: [{ node: 'rev', output: { verdict: 'FAIL' } }] });
  assert.deepStrictEqual(r1.meta.dispatched.map((d: { node: string }) => d.node), ['fix']);
  const r2 = await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 2, outputs: [{ node: 'fix', output: {} }] });
  assert.ok(!r2.text.includes('EDITED INSTRUCTIONS'), 'the run keeps the instructions it started with');
  assert.ok(r2.text.includes('You are review.'));
  // The frozen schema still applies: an output the edited schema would accept is rejected.
  const r3 = await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 3, outputs: [{ node: 'rev', output: { anything: 1 } }] });
  assert.strictEqual(r3.meta.error, 'invalid_output');

  const del = await api(`/agents/${review.id}`, { method: 'DELETE', token: u.token });
  assert.strictEqual(del.status, 409);
});

section('engine: step numbers and idempotent retries (F7)');

test('sending the same workflow.next twice advances once and returns the same answer', async () => {
  const { p } = await reviewLoopProject();
  const s = await mcp(p.api_key, 'workflow.start', { request: 'review this' });
  const args = { runId: s.meta.runId, step: 1, outputs: [{ node: 'rev', output: { verdict: 'FAIL' } }] };
  const a = await mcp(p.api_key, 'workflow.next', args);
  const b = await mcp(p.api_key, 'workflow.next', args);
  assert.strictEqual(a.text, b.text);
  assert.strictEqual(b.meta.replayed, true);
  assert.strictEqual(b.meta.step, 2);
  const steps = (db.prepare('SELECT COUNT(*) AS n FROM run_step_outputs WHERE run_id = ?').get(s.meta.runId) as { n: number }).n;
  assert.strictEqual(steps, 1);
});

test('a stale or future step number is rejected without consuming anything', async () => {
  const { p } = await reviewLoopProject();
  const s = await mcp(p.api_key, 'workflow.start', { request: 'review this' });
  const future = await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 5, outputs: [{ node: 'rev', output: { verdict: 'PASS' } }] });
  assert.strictEqual(future.meta.error, 'wrong_step');
  await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 1, outputs: [{ node: 'rev', output: { verdict: 'FAIL' } }] });
  const stale = await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 1, outputs: [{ node: 'rev', output: { verdict: 'PASS' } }] });
  assert.strictEqual(stale.meta.error, 'wrong_step', 'same step, different content is not a retry');
});

section('engine: run endings');

test('an invocation cap ends the run as capped, not completed', async () => {
  const { u, p, review, fix } = await reviewLoopProject();
  await putFlow(u.token, p.id, {
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 0 },
      { id: 'rev', type: 'agent', agent_id: review.id, max_invocations: 1, x: 0, y: 0 },
      { id: 'fix', type: 'agent', agent_id: fix.id, x: 0, y: 0 },
      { id: 'clean', type: 'end', outcome: 'clean', x: 0, y: 0 },
    ],
    edges: [
      { id: 'e0', from: 'start', to: 'rev' },
      { id: 'fail', from: 'rev', to: 'fix', when: { path: 'verdict', op: 'eq', value: 'FAIL' } },
      { id: 'ok', from: 'rev', to: 'clean', default: true },
      { id: 'back', from: 'fix', to: 'rev' },
    ],
  });
  const s = await mcp(p.api_key, 'workflow.start', { request: 'review this' });
  await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 1, outputs: [{ node: 'rev', output: { verdict: 'FAIL' } }] });
  const r = await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 2, outputs: [{ node: 'fix', output: {} }] });
  assert.strictEqual(r.meta.status, 'capped');
  assert.strictEqual(runStatus(s.meta.runId).status, 'capped');
});

test('a cancelled run accepts no further steps', async () => {
  const { u, p } = await reviewLoopProject();
  const s = await mcp(p.api_key, 'workflow.start', { request: 'review this' });
  const c = await api(`/runs/${s.meta.runId}/cancel`, { method: 'POST', token: u.token });
  assert.strictEqual(c.status, 200);
  const r = await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 1, outputs: [{ node: 'rev', output: { verdict: 'PASS' } }] });
  assert.ok(r.meta.blocked === 'cancelled' || r.meta.error === 'run_finished');
  assert.strictEqual(runStatus(s.meta.runId).status, 'cancelled');
});

test('the legacy `workflow` tool is gone, and workflow.report refuses a server-verified run', async () => {
  const { p } = await reviewLoopProject();
  const legacy = await mcp(p.api_key, 'workflow', { request: 'x' });
  assert.strictEqual(legacy.error?.code, -32602);
  const s = await mcp(p.api_key, 'workflow.start', { request: 'review this' });
  const r = await mcp(p.api_key, 'workflow.report', { runId: s.meta.runId, report: { path: ['review'] } });
  assert.strictEqual(r.error?.code, -32602);
  assert.ok(/server-orchestrated/.test(r.error!.message), r.error!.message);
});
