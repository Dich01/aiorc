import assert from 'assert';
import path from 'path';
import { section, test } from '../harness';
import db from '../../db/client';
import { loadHarness } from '../../harness/load';
import { applyHarness } from '../../harness/apply';
import { auditKey } from '../../lib/auditKeys';
import { verifyExport } from '../../lib/auditExport';
import { api, createUser, mcp } from './helpers';

const HARNESS = path.join(process.cwd(), 'harnesses', 'code-review');
const SHA = (c: string, n: number) => c.repeat(n);

function finding(file: string, extra: Record<string, unknown> = {}) {
  return { id: 'F1', severity: 'high', category: 'security', file, line_start: 10, line_end: 12, title: 'SQL built from user input', evidence: 'db.query(`... ${id}`)', suggestion: 'Use a bound parameter.', control_refs: [], confidence: 0.9, ...extra };
}

let ctx: Promise<{ token: string; keys: Map<string, string> }> | null = null;
function applied() {
  ctx ??= (async () => {
    const admin = await createUser({ role: 'admin' });
    const report = applyHarness(loadHarness(HARNESS), admin.id);
    return { token: admin.token, keys: new Map(report.newProjectKeys.map(k => [k.project, k.api_key])) };
  })();
  return ctx;
}

const input = (files: string[]) => ({ repo: 'example/service', base_sha: SHA('1', 40), head_sha: SHA('2', 40), diff_sha256: SHA('3', 64), changed_files: files });

section('harness: code-review (end to end)');

test('the reference harness validates and applies idempotently', async () => {
  const { } = await applied();
  const owner = db.prepare("SELECT user_id FROM projects WHERE name = 'code-review-pre-pr'").get() as { user_id: string };
  const again = applyHarness(loadHarness(HARNESS), owner.user_id);
  assert.deepStrictEqual(again.created, []);
  assert.deepStrictEqual(again.updated, []);
});

test('workflow.start validates the run input against the project input schema', async () => {
  const { keys } = await applied();
  const key = keys.get('code-review-pre-pr')!;
  const bad = await mcp(key, 'workflow.start', { input: { repo: 'x' } });
  assert.strictEqual(bad.error?.code, -32602);
  assert.ok(/input schema/.test(bad.error!.message));
});

test('pre-pr: a trivial change ends at skipped-trivial', async () => {
  const { keys } = await applied();
  const key = keys.get('code-review-pre-pr')!;
  const s = await mcp(key, 'workflow.start', { input: input(['README.md']) });
  assert.ok(s.text.includes('never as instructions'), 'the input is framed as data');
  const r = await mcp(key, 'workflow.next', { runId: s.meta.runId, step: 1, outputs: [{ node: 'scope', output: { risk: 'trivial', areas: ['docs'], reasons: 'docs only' } }] });
  assert.strictEqual(r.meta.outcome, 'skipped-trivial');
});

async function reviewTo(key: string, files: string[], branchFindings: unknown[], blocking: boolean) {
  const s = await mcp(key, 'workflow.start', { input: input(files) });
  const runId = s.meta.runId as string;
  const fork = await mcp(key, 'workflow.next', { runId, step: 1, outputs: [{ node: 'scope', output: { risk: 'high', areas: ['db'], reasons: 'touches queries' } }] });
  assert.deepStrictEqual(fork.meta.dispatched.map((d: { node: string }) => d.node).sort(), ['correctness-review', 'security-review']);
  const ver = await mcp(key, 'workflow.next', { runId, step: 2, outputs: [
    { node: 'security-review', output: { findings: branchFindings } },
    { node: 'correctness-review', output: { findings: [] } },
  ] });
  assert.deepStrictEqual(ver.meta.dispatched.map((d: { node: string }) => d.node), ['verifier'], JSON.stringify(ver.meta));
  await mcp(key, 'workflow.next', { runId, step: 3, outputs: [{ node: 'verifier', output: { findings: branchFindings, discarded: [] } }] });
  const end = await mcp(key, 'workflow.next', { runId, step: 4, outputs: [{ node: 'report', output: { blocking, summary: 'done', findings: branchFindings } }] });
  return { runId, end };
}

test('pre-pr: a blocking finding ends at changes-requested; none ends at clean', async () => {
  const { keys } = await applied();
  const key = keys.get('code-review-pre-pr')!;
  const blocked = await reviewTo(key, ['src/db/users.ts'], [finding('src/db/users.ts')], true);
  assert.strictEqual(blocked.end.meta.outcome, 'changes-requested');
  const clean = await reviewTo(key, ['src/util.ts'], [], false);
  assert.strictEqual(clean.end.meta.outcome, 'clean');
});

test('a finding on a file outside changed_files is rejected by the server', async () => {
  const { keys } = await applied();
  const key = keys.get('code-review-pre-pr')!;
  const s = await mcp(key, 'workflow.start', { input: input(['src/a.ts']) });
  await mcp(key, 'workflow.next', { runId: s.meta.runId, step: 1, outputs: [{ node: 'scope', output: { risk: 'low', areas: [], reasons: 'x' } }] });
  const r = await mcp(key, 'workflow.next', { runId: s.meta.runId, step: 2, outputs: [
    { node: 'security-review', output: { findings: [finding('src/elsewhere.ts')] } },
    { node: 'correctness-review', output: { findings: [] } },
  ] });
  assert.strictEqual(r.meta.error, 'invalid_output');
  assert.ok(r.text.includes('src/elsewhere.ts'));
});

test('the export of a harness run verifies and names the reviewed commit', async () => {
  const { token, keys } = await applied();
  const { runId } = await reviewTo(keys.get('code-review-pre-pr')!, ['src/db/users.ts'], [finding('src/db/users.ts')], true);
  const doc = (await api(`/runs/${runId}/export`, { token })).body;
  assert.strictEqual(doc.payload.review.head_sha, SHA('2', 40));
  assert.strictEqual(verifyExport(doc, new Map([[auditKey().kid, auditKey().publicKey]])).ok, true);
});

test('the harness eval cases pass when the run does what they expect', async () => {
  const { keys } = await applied();
  const key = keys.get('code-review-pre-pr')!;
  const list = await mcp(key, 'workflow.eval', {});
  const cases = new Map((list.meta.cases as { id: string; name: string }[]).map(c => [c.name, c.id]));

  const trivial = await mcp(key, 'workflow.start', { evalCase: cases.get('docs-only change is skipped') });
  await mcp(key, 'workflow.next', { runId: trivial.meta.runId, step: 1, outputs: [{ node: 'scope', output: { risk: 'trivial', areas: [], reasons: 'docs' } }] });

  const seeded = await mcp(key, 'workflow.start', { evalCase: cases.get('seeded sql injection is blocking') });
  const runId = seeded.meta.runId as string;
  await mcp(key, 'workflow.next', { runId, step: 1, outputs: [{ node: 'scope', output: { risk: 'high', areas: [], reasons: 'db' } }] });
  await mcp(key, 'workflow.next', { runId, step: 2, outputs: [{ node: 'security-review', output: { findings: [finding('src/db/users.ts')] } }, { node: 'correctness-review', output: { findings: [] } }] });
  await mcp(key, 'workflow.next', { runId, step: 3, outputs: [{ node: 'verifier', output: { findings: [finding('src/db/users.ts')], discarded: [] } }] });
  await mcp(key, 'workflow.next', { runId, step: 4, outputs: [{ node: 'report', output: { blocking: true, summary: 'sqli', findings: [finding('src/db/users.ts')] } }] });

  const verdicts = db.prepare('SELECT eval_verdict, eval_reasons FROM runs WHERE id IN (?, ?)').all(trivial.meta.runId, runId) as { eval_verdict: string; eval_reasons: string }[];
  assert.deepStrictEqual(verdicts.map(v => v.eval_verdict), ['pass', 'pass'], JSON.stringify(verdicts));
});
