import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { section, test } from '../harness';
import { TEST_DIR } from '../env';
import db from '../../db/client';
import { auditKey } from '../../lib/auditKeys';
import { verifyExport } from '../../lib/auditExport';
import { buildSignedExport } from '../../lib/auditBuild';
import { loadHarness } from '../../harness/load';
import { applyHarness } from '../../harness/apply';
import { api, createAgent, createProject, createUser, mcp, putFlow } from './helpers';

// Model-orchestrated mode (execution_mode 'compiled'): workflow.start returns the whole
// flow, the model posts a self-declared report with workflow.report.

const VERDICT_SCHEMA = { type: 'object', required: ['verdict'], properties: { verdict: { enum: ['PASS', 'FAIL'] } } };

// start → review ─(fail: verdict eq FAIL)→ fix → back to review
//                └─(ok, default)─────────→ End "clean"
async function loopProject(mode: 'verified' | 'compiled' = 'compiled') {
  const u = await createUser();
  const p = await createProject(u.token);
  const review = await createAgent(u.token, p.id, 'review', { output_schema: VERDICT_SCHEMA });
  const fix = await createAgent(u.token, p.id, 'fix');
  const r = await putFlow(u.token, p.id, {
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 0 },
      { id: 'rev', type: 'agent', agent_id: review.id, agent_name: 'review', max_invocations: 3, x: 0, y: 0 },
      { id: 'fix', type: 'agent', agent_id: fix.id, agent_name: 'fix', max_invocations: 2, x: 0, y: 0 },
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
  if (mode === 'compiled') {
    const m = await api(`/projects/${p.id}/execution-mode`, { method: 'PATCH', token: u.token, body: { mode: 'compiled' } });
    assert.strictEqual(m.status, 200, JSON.stringify(m.body));
  }
  return { u, p, review, fix };
}

const run = (id: string) => db.prepare('SELECT mode, status, engine_state FROM runs WHERE id = ?').get(id) as { mode: string; status: string; engine_state: string };
const events = (id: string) => (db.prepare('SELECT type, payload_json FROM run_events WHERE run_id = ? ORDER BY seq').all(id) as { type: string; payload_json: string }[]);
const usage = (id: string, source: string) => db.prepare('SELECT agent_name, invocations FROM agent_usage WHERE run_id = ? AND source = ? ORDER BY agent_name').all(id, source) as { agent_name: string; invocations: number }[];
const keys = () => new Map([[auditKey().kid, auditKey().publicKey]]);
const REPORT = { path: ['review', 'fix', 'review'], invocations_per_agent: { review: 2, fix: 1 }, branches_taken: { review: 'fail' }, ended_at: 'End: clean', final_summary: 'fixed and re-reviewed' };

section('execution mode setting');

test('a new project is verified by default; POST /projects accepts execution_mode', async () => {
  const u = await createUser();
  const plain = await createProject(u.token);
  assert.strictEqual((await api(`/projects/${plain.id}`, { token: u.token })).body.execution_mode, 'verified');
  const fast = await api('/projects', { token: u.token, body: { name: `fast-${randomUUID().slice(0, 6)}`, execution_mode: 'compiled' } });
  assert.strictEqual(fast.status, 201);
  assert.strictEqual(fast.body.execution_mode, 'compiled');
  const bad = await api('/projects', { token: u.token, body: { name: 'x', execution_mode: 'turbo' } });
  assert.strictEqual(bad.status, 400);
});

test('only the owner (or an admin) can switch the mode, and only to a known value', async () => {
  const { u, p } = await loopProject('verified');
  const other = await createUser();
  assert.strictEqual((await api(`/projects/${p.id}/execution-mode`, { method: 'PATCH', token: other.token, body: { mode: 'compiled' } })).status, 403);
  assert.strictEqual((await api(`/projects/${p.id}/execution-mode`, { method: 'PATCH', token: u.token, body: { mode: 'turbo' } })).status, 400);
  const ok = await api(`/projects/${p.id}/execution-mode`, { method: 'PATCH', token: u.token, body: { mode: 'compiled' } });
  assert.strictEqual(ok.body.execution_mode, 'compiled');
  const admin = await createUser({ role: 'admin' });
  const back = await api(`/projects/${p.id}/execution-mode`, { method: 'PATCH', token: admin.token, body: { mode: 'verified' } });
  assert.strictEqual(back.body.execution_mode, 'verified');
});

section('model-orchestrated mode: workflow.start');

test('workflow.start returns the whole flow in one document and leaves the run delivered', async () => {
  const { p } = await loopProject();
  const s = await mcp(p.api_key, 'workflow.start', { request: 'review this' });
  assert.strictEqual(s.error, undefined, JSON.stringify(s.error));
  assert.strictEqual(s.meta.mode, 'compiled');
  assert.strictEqual(s.meta.finish_with, 'workflow.report');
  for (const text of ['model-orchestrated workflow (self-declared)', 'You are review.', 'You are fix.', 'Node `rev`', 'Node `fix`',
    '`fail` → fix if verdict eq "FAIL"', '"path":"verdict"', 'otherwise `ok` → End "clean"', 'How to read rule edges', '"enum"',
    'workflow.report', s.meta.runId]) {
    assert.ok(s.text.includes(text), `missing: ${text}`);
  }
  const r = run(s.meta.runId);
  assert.deepStrictEqual({ mode: r.mode, status: r.status, engine_state: r.engine_state }, { mode: 'compiled', status: 'delivered', engine_state: '' });
  const ev = events(s.meta.runId);
  assert.deepStrictEqual(ev.map(e => e.type), ['run.started']);
  assert.strictEqual(JSON.parse(ev[0]!.payload_json).mode, 'compiled');
  assert.ok((db.prepare('SELECT COUNT(*) n FROM run_snapshots WHERE run_id = ?').get(s.meta.runId) as { n: number }).n >= 3, 'the run is snapshotted');
  assert.deepStrictEqual(usage(s.meta.runId, 'planned').map(u => u.agent_name), ['fix', 'review']);
});

test('workflow.next is refused on a model-orchestrated run', async () => {
  const { p } = await loopProject();
  const s = await mcp(p.api_key, 'workflow.start', { request: 'review this' });
  const n = await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 1, outputs: [{ node: 'rev', output: { verdict: 'PASS' } }] });
  assert.strictEqual(n.error?.code, -32602);
  assert.ok(/workflow.report/.test(n.error!.message));
});

test('switching the mode never changes a run in flight; the next start follows the new mode', async () => {
  const { u, p } = await loopProject();
  const s = await mcp(p.api_key, 'workflow.start', { request: 'review this' });
  await api(`/projects/${p.id}/execution-mode`, { method: 'PATCH', token: u.token, body: { mode: 'verified' } });
  const late = await mcp(p.api_key, 'workflow.report', { runId: s.meta.runId, report: REPORT });
  assert.strictEqual(late.meta.status, 'reported', JSON.stringify(late.error));
  const s2 = await mcp(p.api_key, 'workflow.start', { request: 'again' });
  assert.strictEqual(s2.meta.mode, 'stepped');
  assert.strictEqual(run(s2.meta.runId).mode, 'stepped');
});

section('model-orchestrated mode: workflow.report');

test('a report is stored, chained and counted as self-declared usage, clamped to the caps', async () => {
  const { p } = await loopProject();
  const s = await mcp(p.api_key, 'workflow.start', { request: 'review this' });
  const r = await mcp(p.api_key, 'workflow.report', { runId: s.meta.runId, report: { ...REPORT, invocations_per_agent: { review: 99, fix: 1, ghost: 4 } } });
  assert.strictEqual(r.meta.status, 'reported');
  assert.ok(/self-declared/.test(r.text));
  assert.strictEqual(run(s.meta.runId).status, 'reported');
  const stored = db.prepare('SELECT sha256 FROM run_reports WHERE run_id = ?').get(s.meta.runId) as { sha256: string };
  const received = events(s.meta.runId).find(e => e.type === 'report.received')!;
  assert.strictEqual(JSON.parse(received.payload_json).report_sha256, stored.sha256);
  assert.deepStrictEqual(usage(s.meta.runId, 'reported'), [
    { agent_name: 'fix', invocations: 1 },
    { agent_name: 'ghost', invocations: 1 },     // invented name: kept, capped at 1
    { agent_name: 'review', invocations: 3 },    // clamped to the node's cap
  ]);
  assert.deepStrictEqual(usage(s.meta.runId, 'executed'), [], 'nothing is ever recorded as verified execution');
});

test('the same report again is a replay; a different one is refused', async () => {
  const { p } = await loopProject();
  const s = await mcp(p.api_key, 'workflow.start', { request: 'review this' });
  await mcp(p.api_key, 'workflow.report', { runId: s.meta.runId, report: REPORT });
  const again = await mcp(p.api_key, 'workflow.report', { runId: s.meta.runId, report: REPORT });
  assert.strictEqual(again.meta.replayed, true);
  const other = await mcp(p.api_key, 'workflow.report', { runId: s.meta.runId, report: { ...REPORT, final_summary: 'rewritten' } });
  assert.strictEqual(other.error?.code, -32602);
  assert.ok(/already has a report/.test(other.error!.message));
  assert.strictEqual(events(s.meta.runId).filter(e => e.type === 'report.received').length, 1);
});

test('a cancelled model-orchestrated run refuses its report, and the cancel is in the chain', async () => {
  const { u, p } = await loopProject();
  const s = await mcp(p.api_key, 'workflow.start', { request: 'review this' });
  assert.strictEqual((await api(`/runs/${s.meta.runId}/cancel`, { method: 'POST', token: u.token })).status, 200);
  const r = await mcp(p.api_key, 'workflow.report', { runId: s.meta.runId, report: REPORT });
  assert.strictEqual(r.error?.code, -32602);
  assert.deepStrictEqual(events(s.meta.runId).map(e => e.type), ['run.started', 'run.cancelled']);
});

test('an oversized report is refused', async () => {
  const { p } = await loopProject();
  const s = await mcp(p.api_key, 'workflow.start', { request: 'review this' });
  const r = await mcp(p.api_key, 'workflow.report', { runId: s.meta.runId, report: { final_summary: 'x'.repeat(1024 * 1024 + 10) } });
  assert.strictEqual(r.error?.code, -32602);
  assert.ok(/exceeds/.test(r.error!.message));
});

test('an idle delivered run is swept to abandoned, and a late report revives it', async () => {
  const { u, p } = await loopProject();
  const s = await mcp(p.api_key, 'workflow.start', { request: 'review this' });
  db.prepare('UPDATE runs SET last_activity_at = 0 WHERE id = ?').run(s.meta.runId);
  await api('/runs', { token: u.token });
  assert.strictEqual(run(s.meta.runId).status, 'abandoned');
  const r = await mcp(p.api_key, 'workflow.report', { runId: s.meta.runId, report: REPORT });
  assert.strictEqual(r.meta.status, 'reported');
});

test('eval runs stay server-verified in a model-orchestrated project', async () => {
  const { u, p } = await loopProject();
  const ev = await api('/evals', { token: u.token, body: { project_id: p.id, name: 'passes clean', input: { request: 'review PR 1' }, expected_outcome: 'clean' } });
  assert.strictEqual(ev.status, 201, JSON.stringify(ev.body));
  const s = await mcp(p.api_key, 'workflow.start', { evalCase: ev.body.id });
  assert.strictEqual(s.meta.mode, 'stepped');
  const n = await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 1, outputs: [{ node: 'rev', output: { verdict: 'PASS' } }] });
  assert.strictEqual(n.meta.status, 'completed');
  assert.strictEqual((db.prepare('SELECT eval_verdict FROM runs WHERE id = ?').get(s.meta.runId) as { eval_verdict: string }).eval_verdict, 'pass');
});

test('external MCP tools are refused inside a model-orchestrated run', async () => {
  const { p } = await loopProject();
  db.prepare('INSERT INTO mcp_servers (id, project_id, name, url, created_at) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), p.id, 'ext', 'https://example.com/mcp', Date.now());
  const s = await mcp(p.api_key, 'workflow.start', { request: 'review this' });
  const r = await mcp(p.api_key, 'ext__search', {}, {});
  assert.strictEqual(r.error?.code, -32001, 'no runId');
  const { rpc } = await import('./helpers');
  const call = await rpc('tools/call', { name: 'ext__search', arguments: {}, _meta: { runId: s.meta.runId, node: 'rev' } }, { 'x-project-key': p.api_key });
  assert.strictEqual(call.body.error?.code, -32001);
  assert.ok(/only available in server-orchestrated runs/.test(call.body.error.message), call.body.error.message);
});

section('model-orchestrated mode: audit and analytics');

test('the signed export carries the mode and the self-declared report, and detects an edited report', async () => {
  const { u, p } = await loopProject();
  const s = await mcp(p.api_key, 'workflow.start', { request: 'review this' });
  await mcp(p.api_key, 'workflow.report', { runId: s.meta.runId, report: REPORT });
  const doc = (await api(`/runs/${s.meta.runId}/export`, { token: u.token })).body;
  assert.strictEqual(doc.payload.format, 'aiorc.audit.v2');
  assert.strictEqual(doc.payload.run.mode, 'compiled');
  assert.deepStrictEqual(doc.payload.steps, []);
  assert.deepStrictEqual(doc.payload.self_declared_report, REPORT);
  assert.deepStrictEqual(verifyExport(doc, keys()), { ok: true, errors: [], kid: auditKey().kid, mode: 'compiled' });

  db.prepare('UPDATE run_reports SET report_json = ? WHERE run_id = ?').run(JSON.stringify({ ...REPORT, final_summary: 'edited later' }), s.meta.runId);
  const edited = verifyExport(buildSignedExport(s.meta.runId)!, keys());
  assert.strictEqual(edited.ok, false);
  assert.ok(edited.errors.some(e => /not the report recorded in the chain/.test(e)), edited.errors.join('; '));

  const relabelled = JSON.parse(JSON.stringify(doc)); relabelled.payload.run.mode = 'stepped';
  assert.strictEqual(verifyExport(relabelled, keys()).ok, false);
});

test('run detail shows the self-declared report', async () => {
  const { u, p } = await loopProject();
  const s = await mcp(p.api_key, 'workflow.start', { request: 'review this' });
  await mcp(p.api_key, 'workflow.report', { runId: s.meta.runId, report: REPORT });
  const d = await api(`/runs/${s.meta.runId}`, { token: u.token });
  assert.strictEqual(d.body.mode, 'compiled');
  assert.deepStrictEqual(d.body.self_declared_report.report, REPORT);
});

test('analytics never counts a model-orchestrated run as verified, and classifies its skips from the report', async () => {
  const { u, p } = await loopProject();
  const s = await mcp(p.api_key, 'workflow.start', { request: 'review this' });
  // The report claims fix ran without review: review dominates fix, so it is a real skip.
  await mcp(p.api_key, 'workflow.report', { runId: s.meta.runId, report: { path: ['fix'], ended_at: 'End: clean' } });
  const a = (await api(`/analytics?project_id=${p.id}`, { token: u.token })).body;
  assert.strictEqual(a.summary.runs_verified, 0);
  assert.strictEqual(a.summary.runs_compiled, 1);
  assert.strictEqual(a.summary.runs_reported, 1);
  assert.strictEqual(a.summary.runs_with_report, 1);
  const review = a.agents.find((x: { agent_name: string }) => x.agent_name === 'review');
  assert.strictEqual(review.skipped, 1);
  assert.strictEqual(a.recent_runs[0].mode, 'compiled');
});

section('model-orchestrated mode: harness');

test('a harness can declare execution_mode; a harness without it leaves the owner\'s toggle alone', async () => {
  const src = path.join(process.cwd(), 'harnesses', 'code-review');
  const dir = path.join(TEST_DIR, `harness-${randomUUID().slice(0, 6)}`);
  fs.cpSync(src, dir, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'harness.json'), 'utf8'));
  const name = manifest.projects[0].name as string;
  manifest.projects[0].execution_mode = 'compiled';
  fs.writeFileSync(path.join(dir, 'harness.json'), JSON.stringify(manifest, null, 2));

  const admin = await createUser({ role: 'admin' });
  applyHarness(loadHarness(dir), admin.id);
  const mode = () => (db.prepare('SELECT execution_mode FROM projects WHERE user_id = ? AND name = ?').get(admin.id, name) as { execution_mode: string }).execution_mode;
  assert.strictEqual(mode(), 'compiled');

  applyHarness(loadHarness(src), admin.id);
  assert.strictEqual(mode(), 'compiled', 'the original harness declares no mode, so the setting stands');

  manifest.projects[0].execution_mode = 'turbo';
  fs.writeFileSync(path.join(dir, 'harness.json'), JSON.stringify(manifest, null, 2));
  assert.throws(() => loadHarness(dir), (err: { problems?: string[] }) => !!err.problems?.some(p => /execution_mode/.test(p)));
});

section('public projects: a non-member only touches their own runs');

test('a non-member with a personal token cannot advance, report on or export someone else\'s run', async () => {
  const { u, p } = await loopProject();
  await api(`/projects/${p.id}/visibility`, { method: 'PATCH', token: u.token, body: { is_public: true } });
  const ownerRun = await mcp(p.api_key, 'workflow.start', { request: 'owner run', input: { request: 'owner run', head_sha: 'a'.repeat(40) } });

  const stranger = await createUser();
  const pat = (await api('/users/me/tokens', { token: stranger.token, body: { name: 't' } })).body.token as string;
  const { rpc } = await import('./helpers');
  const as = (tool: string, args: Record<string, unknown>) =>
    rpc('tools/call', { name: tool, arguments: args }, { 'x-project-id': p.id, Authorization: `Bearer ${pat}` });

  const report = await as('workflow.report', { runId: ownerRun.meta.runId, report: REPORT });
  assert.strictEqual(report.body.error?.code, -32602);
  assert.ok(/Unknown runId/.test(report.body.error.message));
  assert.strictEqual(run(ownerRun.meta.runId).status, 'delivered', 'the owner\'s run is untouched');

  const mine = await as('workflow.start', { request: 'my run', input: { request: 'my run', head_sha: 'a'.repeat(40) } });
  assert.strictEqual((await as('workflow.report', { runId: mine.body.result._meta.runId, report: REPORT })).body.result._meta.status, 'reported');

  const listed = await api(`/api/runs?head_sha=${'a'.repeat(40)}`, { headers: { 'x-project-id': p.id, Authorization: `Bearer ${pat}` } });
  assert.deepStrictEqual(listed.body.runs.map((r: { id: string }) => r.id), [mine.body.result._meta.runId]);
  const exp = await api(`/api/runs/${ownerRun.meta.runId}/export`, { headers: { 'x-project-id': p.id, Authorization: `Bearer ${pat}` } });
  assert.strictEqual(exp.status, 404);
  const ownerList = await api(`/api/runs?head_sha=${'a'.repeat(40)}`, { headers: { 'x-project-key': p.api_key } });
  assert.strictEqual(ownerList.body.runs.length, 2, 'the project key still sees every run');
});
