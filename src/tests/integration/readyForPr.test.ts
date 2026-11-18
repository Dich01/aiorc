// harnesses/ready-for-pr end to end over MCP: the outputs of the script steps
// are what the real scripts print on the demo repositories; only the model
// steps (task, reviewers, verifier, fixer, explain) are written by the test.
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { section, test } from '../harness';
import db from '../../db/client';
import { loadHarness } from '../../harness/load';
import { applyHarness } from '../../harness/apply';
import { auditKey } from '../../lib/auditKeys';
import { verifyExport } from '../../lib/auditExport';
import { api, createUser, mcp } from './helpers';
import { RFP, finding, fixMultiply, fixture, git, py, write } from '../unit/readyForPrScripts.test';

const PROJECT = 'ready-for-pr';

let ctx: Promise<{ token: string; key: string; projectId: string }> | null = null;
function applied() {
  ctx ??= (async () => {
    const admin = await createUser({ role: 'admin' });
    const report = applyHarness(loadHarness(RFP), admin.id);
    const key = report.newProjectKeys.find(k => k.project === PROJECT)!.api_key;
    const projectId = (db.prepare('SELECT id FROM projects WHERE name = ? AND user_id = ?').get(PROJECT, admin.id) as { id: string }).id;
    const r = await api(`/projects/${projectId}/executable-files`, { method: 'PATCH', token: admin.token, body: { allow: true } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return { token: admin.token, key, projectId };
  })();
  return ctx;
}

// Drives one run and checks, at every step, which nodes the server dispatched.
class Run {
  step = 0;
  dispatched: string[] = [];
  outcome: string | null = null;
  status = '';
  text = '';
  constructor(public key: string, public id: string) {}

  static async start(key: string, input: Record<string, unknown>): Promise<Run> {
    const s = await mcp(key, 'workflow.start', { input });
    assert.ok(!s.error, JSON.stringify(s.error));
    const run = new Run(key, s.meta.runId);
    run.absorb(s);
    return run;
  }

  absorb(r: { meta: Record<string, any>; text: string }) {
    this.text = r.text;
    this.status = r.meta.status;
    this.outcome = r.meta.outcome ?? null;
    if (r.meta.dispatched) { this.step = r.meta.step; this.dispatched = r.meta.dispatched.map((d: { node: string }) => d.node).sort(); }
    else this.dispatched = [];
  }

  async next(expected: string[], outputs: Record<string, unknown>) {
    assert.deepStrictEqual(this.dispatched, [...expected].sort(), `step ${this.step}: ${this.text.slice(0, 400)}`);
    const r = await mcp(this.key, 'workflow.next', { runId: this.id, step: this.step, outputs: Object.entries(outputs).map(([node, output]) => ({ node, output })) });
    assert.ok(!r.meta.error, `step ${this.step} (${expected.join(', ')}) rejected: ${r.text}`);
    this.absorb(r);
    return r;
  }
}

function taskOutput(dir: string, extra: Record<string, unknown> = {}) {
  return {
    status: 'ready', task: 'the task', done_criteria: 'it is done', branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'),
    base_ref: 'main', head_sha: git(dir, 'rev-parse', 'HEAD'), committed: false,
    evidence: [{ kind: 'test-output', description: 'unit tests', result: 'passed' }],
    scripts: py(dir, 'common.py', 'manifest').scripts, profile_loaded: true, notes: '', ...extra,
  };
}

const checksOutput = (dir: string, runId: string) => ({ checks: py(dir, 'checks.py', '--run-id', runId), weakening: py(dir, 'detect_weakening.py') });
const none = { findings: [], notes: '' };
const fixerOutput = (kind: 'checks' | 'findings', commits: string[], decisions: unknown[] = [], extra: Record<string, unknown> = {}) =>
  ({ kind, decisions, commits, changed_files: [], stuck: false, summary: 'fixed', notes: '', ...extra });
const explainOutput = { problem: 'p', behavior: 'b', decisions: [], read_first: [], risks: [], files_in_order: [], evidence: 'tests passed', markdown: '## What and why\n\np' };

function filterOutput(dir: string, runId: string, verified: unknown[]) {
  const file = path.join(dir, '.git', 'aiorc', 'runs', runId, 'verified.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ findings: verified }));
  return py(dir, 'filter_findings.py', 'filter', '--run-id', runId, '--findings', file);
}

function deliverOutput(dir: string, runId: string) {
  const summary = py(dir, 'filter_findings.py', 'summary', '--run-id', runId);
  return { summary, findings: summary.findings, branch: 'feature', pr_title: 'Add the change', pr_body: 'body', commands: ['git push -u origin feature'], pushed: false, pr_url: '', notes: '' };
}

const MIN = ['min-correctness', 'min-intent'];
const FULL = ['full-blind', 'full-correctness', 'full-duplicates', 'full-intent', 'full-security'];

section('harness: ready-for-pr (end to end over MCP)');

test('the harness validates and applies idempotently', async () => {
  await applied();
  const owner = db.prepare('SELECT user_id FROM projects WHERE name = ?').get(PROJECT) as { user_id: string };
  const again = applyHarness(loadHarness(RFP), owner.user_id);
  assert.deepStrictEqual([again.created, again.updated], [[], []]);
});

test('the scripts and the profile reach the model only with executable files enabled', async () => {
  const { key, token, projectId } = await applied();
  const on = await Run.start(key, { request: 'x' });
  assert.ok(on.text.includes('def classify(profile, base_ref)'), 'the scripts are delivered');
  const [shared, step1] = on.text.split('## Step 1');
  // "app/payments/**" exists only in the example profile.json (the scripts mention "sensitive_paths" too).
  assert.ok(step1!.includes('app/payments/**'), 'the profile is delivered in the task step');
  assert.ok(!shared!.includes('app/payments/**'), 'and not to the whole flow');
  await api(`/runs/${on.id}/cancel`, { method: 'POST', token });

  await api(`/projects/${projectId}/executable-files`, { method: 'PATCH', token, body: { allow: false } });
  const off = await Run.start(key, { request: 'x' });
  assert.ok(!off.text.includes('def classify'), 'withheld');
  assert.ok(off.text.includes('Non-Markdown file withheld'));
  await api(`/runs/${off.id}/cancel`, { method: 'POST', token });
  await api(`/projects/${projectId}/executable-files`, { method: 'PATCH', token, body: { allow: true } });
});

test('normal change: a failing check is fixed, two reviewers run, and the run ends at ready', async () => {
  const { key } = await applied();
  const dir = fixture('failing-check');
  const run = await Run.start(key, { request: 'Add multiply', done_criteria: 'multiply returns the product' });
  await run.next(['task'], { task: taskOutput(dir) });
  await run.next(['risk'], { risk: py(dir, 'classify_risk.py') });
  await run.next(['checks'], { checks: checksOutput(dir, run.id) });
  const sha = fixMultiply(dir);
  await run.next(['fix-checks'], { 'fix-checks': fixerOutput('checks', [sha]) });
  await run.next(['checks'], { checks: checksOutput(dir, run.id) });
  await run.next(['prepare'], { prepare: py(dir, 'prepare_diff.py', '--run-id', run.id) });
  await run.next(MIN, { 'min-correctness': none, 'min-intent': none });
  await run.next(['verifier'], { verifier: none });
  await run.next(['filter'], { filter: filterOutput(dir, run.id, []) });
  await run.next(['explain'], { explain: explainOutput });
  await run.next(['deliver'], { deliver: deliverOutput(dir, run.id) });
  assert.deepStrictEqual([run.status, run.outcome], ['completed', 'ready']);
});

test('sensitive change: all five reviewers, a confirmed blocker is fixed, re-reviewed incrementally, and goes to a person', async () => {
  const { key, token } = await applied();
  const dir = fixture('sql-injection');
  const run = await Run.start(key, { request: 'Add find_user_by_name', done_criteria: 'returns the user or None' });
  await run.next(['task'], { task: taskOutput(dir) });
  await run.next(['risk'], { risk: py(dir, 'classify_risk.py') });
  await run.next(['checks'], { checks: checksOutput(dir, run.id) });
  const round1 = py(dir, 'prepare_diff.py', '--run-id', run.id);
  assert.strictEqual(round1.depth, 'full');
  await run.next(['prepare'], { prepare: round1 });
  const raised = finding('sec-1', { verification: 'unverified' });
  delete (raised as Record<string, unknown>).verification_note;
  await run.next(FULL, { 'full-security': { findings: [raised], notes: '' }, 'full-correctness': none, 'full-intent': none, 'full-blind': none, 'full-duplicates': none });
  await run.next(['verifier'], { verifier: { findings: [finding('sec-1')], notes: '' } });
  const filtered = filterOutput(dir, run.id, [finding('sec-1')]);
  assert.strictEqual(filtered.blocking, true);
  await run.next(['filter'], { filter: filtered });

  write(dir, 'app/auth/users.py', fs.readFileSync(path.join(dir, 'app/auth/users.py'), 'utf8').replace(`"SELECT id, name, role FROM users WHERE name = '%s'" % name`, '"SELECT id, name, role FROM users WHERE name = ?", (name,)'));
  git(dir, 'commit', '-qam', 'fix: bind the name parameter');
  py(dir, 'filter_findings.py', 'decide', '--run-id', run.id, '--id', 'sec-1', '--action', 'fixed', '--reason', 'the query binds the parameter');
  await run.next(['fix-findings'], { 'fix-findings': fixerOutput('findings', [git(dir, 'rev-parse', 'HEAD')], [{ id: 'sec-1', action: 'fixed', reason: 'bound parameter' }]) });

  await run.next(['checks'], { checks: checksOutput(dir, run.id) });
  const round2 = py(dir, 'prepare_diff.py', '--run-id', run.id);
  assert.deepStrictEqual([round2.scope, round2.depth, round2.files], ['incremental', 'full', ['app/auth/users.py']]);
  await run.next(['prepare'], { prepare: round2 });
  await run.next(FULL, { 'full-security': none, 'full-correctness': none, 'full-intent': none, 'full-blind': none, 'full-duplicates': none });
  await run.next(['verifier'], { verifier: none });
  await run.next(['filter'], { filter: filterOutput(dir, run.id, []) });
  await run.next(['explain'], { explain: explainOutput });
  const delivered = deliverOutput(dir, run.id);
  assert.deepStrictEqual(delivered.summary.decisions.map((d: { id: string; action: string }) => [d.id, d.action]), [['sec-1', 'fixed']]);
  await run.next(['deliver'], { deliver: delivered });
  assert.deepStrictEqual([run.status, run.outcome], ['completed', 'ready-human-review']);

  const doc = (await api(`/runs/${run.id}/export`, { token })).body;
  assert.strictEqual(verifyExport(doc, new Map([[auditKey().kid, auditKey().publicKey]])).ok, true);
  const nodes = doc.payload.steps.map((s: { node: string }) => s.node);
  assert.strictEqual(nodes.filter((n: string) => n === 'full-security').length, 2, 'reviewed twice');
});

test('docs-only change skips the review and is cleared for auto-merge', async () => {
  const { key } = await applied();
  const dir = fixture('docs-only');
  const run = await Run.start(key, { request: 'Document the tests' });
  await run.next(['task'], { task: taskOutput(dir) });
  await run.next(['risk'], { risk: py(dir, 'classify_risk.py') });
  await run.next(['checks'], { checks: checksOutput(dir, run.id) });
  await run.next(['prepare'], { prepare: py(dir, 'prepare_diff.py', '--run-id', run.id) });
  await run.next(['explain'], { explain: explainOutput });
  await run.next(['deliver'], { deliver: deliverOutput(dir, run.id) });
  assert.strictEqual(run.outcome, 'ready-auto-merge');
});

test('the early Ends: weakened tests, oversized change, no changes, missing task, missing checks, stuck fixer, stale checks', async () => {
  const { key } = await applied();

  let dir = fixture('weakened-tests');
  let run = await Run.start(key, { request: 'x' });
  await run.next(['task'], { task: taskOutput(dir) });
  await run.next(['risk'], { risk: py(dir, 'classify_risk.py') });
  await run.next(['checks'], { checks: checksOutput(dir, run.id) });
  assert.strictEqual(run.outcome, 'needs-human');

  dir = fixture('big-change');
  run = await Run.start(key, { request: 'x' });
  await run.next(['task'], { task: taskOutput(dir) });
  await run.next(['risk'], { risk: py(dir, 'classify_risk.py') });
  assert.strictEqual(run.outcome, 'split-change');

  dir = fixture('no-changes');
  run = await Run.start(key, { request: 'x' });
  await run.next(['task'], { task: taskOutput(dir, { status: 'no-changes' }) });
  assert.strictEqual(run.outcome, 'no-changes');

  run = await Run.start(key, { request: 'x' });
  await run.next(['task'], { task: taskOutput(dir, { status: 'missing-task', done_criteria: '' }) });
  assert.strictEqual(run.outcome, 'needs-task');

  dir = fixture('failing-check');
  const empty = path.join(dir, '.git', 'aiorc', 'profile.json');
  run = await Run.start(key, { request: 'x' });
  await run.next(['task'], { task: taskOutput(dir) });
  await run.next(['risk'], { risk: py(dir, 'classify_risk.py') });
  const saved = fs.readFileSync(empty, 'utf8');
  fs.writeFileSync(empty, JSON.stringify({ base_branch: 'main', checks: [] }));
  await run.next(['checks'], { checks: checksOutput(dir, run.id) });
  assert.strictEqual(run.outcome, 'needs-profile');
  fs.writeFileSync(empty, saved);

  run = await Run.start(key, { request: 'x' });
  await run.next(['task'], { task: taskOutput(dir) });
  await run.next(['risk'], { risk: py(dir, 'classify_risk.py') });
  await run.next(['checks'], { checks: checksOutput(dir, run.id) });
  await run.next(['fix-checks'], { 'fix-checks': fixerOutput('checks', [], [], { stuck: true }) });
  assert.strictEqual(run.outcome, 'fixer-stuck');

  fixMultiply(dir);
  run = await Run.start(key, { request: 'x' });
  await run.next(['task'], { task: taskOutput(dir) });
  await run.next(['risk'], { risk: py(dir, 'classify_risk.py') });
  await run.next(['checks'], { checks: checksOutput(dir, run.id) });
  await run.next(['prepare'], { prepare: py(dir, 'prepare_diff.py', '--run-id', run.id) });
  await run.next(MIN, { 'min-correctness': none, 'min-intent': none });
  await run.next(['verifier'], { verifier: none });
  await run.next(['filter'], { filter: filterOutput(dir, run.id, []) });
  await run.next(['explain'], { explain: explainOutput });
  write(dir, 'app/calc.py', fs.readFileSync(path.join(dir, 'app/calc.py'), 'utf8') + '\n# edited after the checks\n');
  await run.next(['deliver'], { deliver: deliverOutput(dir, run.id) });
  assert.strictEqual(run.outcome, 'checks-stale');
});

test('a fourth round of fixes is refused: the run stops as capped', async () => {
  const { key } = await applied();
  const dir = fixture('sql-injection');
  const run = await Run.start(key, { request: 'x' });
  await run.next(['task'], { task: taskOutput(dir) });
  await run.next(['risk'], { risk: py(dir, 'classify_risk.py') });
  const prepared = py(dir, 'prepare_diff.py', '--run-id', run.id);
  const blocking = filterOutput(dir, run.id, [finding('sec-1')]);
  for (let round = 1; round <= 4; round++) {
    await run.next(['checks'], { checks: checksOutput(dir, run.id) });
    await run.next(['prepare'], { prepare: prepared });
    await run.next(FULL, { 'full-security': none, 'full-correctness': none, 'full-intent': none, 'full-blind': none, 'full-duplicates': none });
    await run.next(['verifier'], { verifier: { findings: [finding('sec-1')], notes: '' } });
    const r = await run.next(['filter'], { filter: blocking });
    if (round < 4) await run.next(['fix-findings'], { 'fix-findings': fixerOutput('findings', [], [{ id: 'sec-1', action: 'rejected', reason: 'not convinced' }]) });
    else {
      assert.strictEqual(run.status, 'capped', r.text);
      assert.ok(r.text.includes('fixer hit its maximum of 3'), r.text);
    }
  }
});

test('outputs that do not come from the scripts are refused', async () => {
  const { key, token } = await applied();
  const dir = fixture('failing-check');
  const run = await Run.start(key, { request: 'x' });
  await run.next(['task'], { task: taskOutput(dir) });
  const forged = { ...py(dir, 'classify_risk.py') };
  delete forged.script;
  const r = await mcp(key, 'workflow.next', { runId: run.id, step: run.step, outputs: [{ node: 'risk', output: forged }] });
  assert.strictEqual(r.meta.error, 'invalid_output');
  const skipped = await mcp(key, 'workflow.next', { runId: run.id, step: run.step, outputs: [{ node: 'prepare', output: {} }] });
  assert.strictEqual(skipped.meta.error, 'missing_output', 'a step cannot be skipped');
  await api(`/runs/${run.id}/cancel`, { method: 'POST', token });
});

test('a fork keeps agents, skills, flow and the profile on the task agent, but not executable files', async () => {
  const { token, projectId } = await applied();
  const other = await createUser();
  await api(`/projects/${projectId}/visibility`, { method: 'PATCH', token, body: { is_public: true } });
  const fork = await api(`/projects/${projectId}/fork`, { method: 'POST', token: other.token });
  assert.strictEqual(fork.status, 201, JSON.stringify(fork.body));
  const f = db.prepare('SELECT id, allow_executable_files FROM projects WHERE id = ?').get(fork.body.id) as { id: string; allow_executable_files: number };
  assert.strictEqual(f.allow_executable_files, 0);
  const contexts = db.prepare('SELECT COUNT(*) AS n FROM project_contexts WHERE project_id = ?').get(f.id) as { n: number };
  assert.strictEqual(contexts.n, 0, 'nothing is attached to the whole flow');
  const carried = db.prepare(
    `SELECT a.name AS agent, c.name AS context FROM project_agents pa JOIN agent_contexts ac ON ac.agent_id = pa.agent_id
     JOIN agents a ON a.id = pa.agent_id JOIN contexts c ON c.id = ac.context_id WHERE pa.project_id = ?`
  ).all(f.id) as { agent: string; context: string }[];
  assert.deepStrictEqual(carried, [{ agent: 'task', context: 'repo-profile' }], 'the profile travels with the task agent, as a copy');
  const skills = db.prepare('SELECT s.name FROM project_skills ps JOIN skills s ON s.id = ps.skill_id WHERE ps.project_id = ? ORDER BY s.name').all(f.id) as { name: string }[];
  assert.deepStrictEqual(skills.map(s => s.name), ['fix-rules', 'harness-scripts', 'review-ground-rules']);
  const start = await mcp(fork.body.api_key, 'workflow.start', { input: { request: 'x' } });
  assert.ok(!start.error && start.meta.dispatched[0].node === 'task', 'the forked flow runs');
  await api(`/projects/${projectId}/visibility`, { method: 'PATCH', token, body: { is_public: false } });
});
