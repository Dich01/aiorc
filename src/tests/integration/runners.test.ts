import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { section, test } from '../harness';
import { TEST_DIR } from '../env';
import { loadHarness } from '../../harness/load';
import { applyHarness } from '../../harness/apply';
import { auditKey } from '../../lib/auditKeys';
import { api, createUser, linearProject, mcp, startServer } from './helpers';

const ROOT = process.cwd();
const RUNNER = path.join(ROOT, 'runners', 'pre-pr', 'aiorc-review.sh');
const PUBLISH = path.join(ROOT, 'runners', 'github', 'publish.mjs');
const FAKE_CLAUDE = path.join(ROOT, 'src', 'tests', 'fixtures', 'fake-claude.js');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
}

function testRepo(): { dir: string; head: string } {
  const dir = fs.mkdtempSync(path.join(TEST_DIR, 'repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n\nMore docs.\n');
  git(dir, 'commit', '-q', '-am', 'docs');
  return { dir, head: git(dir, 'rev-parse', 'HEAD') };
}

section('runners: pre-PR script (end to end with a stand-in client)');

test('aiorc-review.sh drives a run, finds it on the server and downloads its export', async () => {
  const admin = await createUser({ role: 'admin' });
  const report = applyHarness(loadHarness(path.join(ROOT, 'harnesses', 'code-review')), admin.id);
  const key = report.newProjectKeys.find(k => k.project === 'code-review-pre-pr')!.api_key;
  const url = await startServer();
  const { dir, head } = testRepo();
  const out = path.join(dir, 'export.json');
  const argvFile = path.join(dir, 'argv.json');

  // Async spawn: the server runs in this process and must keep answering.
  const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>(resolve => {
    const child = spawn('bash', [RUNNER, '--base', 'main', '--out', out], {
      cwd: dir,
      env: { ...process.env, AIORC_URL: url, AIORC_PROJECT_KEY: key, AIORC_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_ARGV: argvFile },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => (stdout += d)); child.stderr.on('data', d => (stderr += d));
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.ok(r.stdout.includes('completed skipped-trivial'), r.stdout);

  const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(doc.payload.review.head_sha, head);
  assert.deepStrictEqual(doc.payload.input.changed_files, ['README.md']);

  const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8')) as string[];
  for (const flag of ['-p', '--mcp-config', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--allowedTools', 'Bash(git diff *)', 'mcp__aiorc']) {
    assert.ok(argv.includes(flag), `runner passes ${flag}`);
  }
  assert.ok(!argv.some(a => /Edit|Write/.test(a)), 'no write tools');
});

test('the project-key API only lists runs of its own project', async () => {
  const u = await createUser();
  const p = await linearProject(u.token);
  const other = await linearProject(u.token);
  const head = 'f'.repeat(40);
  await mcp(p.api_key, 'workflow.start', { input: { head_sha: head } });
  const mine = await api(`/api/runs?head_sha=${head}`, { headers: { 'x-project-key': p.api_key } });
  assert.strictEqual(mine.body.runs.length, 1);
  const theirs = await api(`/api/runs?head_sha=${head}`, { headers: { 'x-project-key': other.api_key } });
  assert.strictEqual(theirs.body.runs.length, 0);
  const exp = await api(`/api/runs/${mine.body.runs[0].id}/export`, { headers: { 'x-project-key': other.api_key } });
  assert.strictEqual(exp.status, 404);
});

section('runners: GitHub publisher');

async function signedExport(headSha: string, findings: unknown[]) {
  const u = await createUser();
  const p = await linearProject(u.token);
  const s = await mcp(p.api_key, 'workflow.start', { input: { repo: 'o/r', base_sha: 'a'.repeat(40), head_sha: headSha, changed_files: ['src/x.ts'] } });
  await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 1, outputs: [{ node: 'n1', output: { findings } }] });
  return (await api(`/runs/${s.meta.runId}/export`, { token: u.token })).body;
}

function runPublish(doc: unknown, headSha: string, env: Record<string, string> = {}) {
  const file = path.join(TEST_DIR, `pub-${Math.random().toString(36).slice(2)}.json`);
  const pem = path.join(TEST_DIR, 'pub.pem');
  fs.writeFileSync(file, JSON.stringify(doc));
  fs.writeFileSync(pem, auditKey().publicKeyPem);
  return spawnSync('node', [PUBLISH, '--export', file, '--repo', 'o/r', '--pr', '3', '--head-sha', headSha, '--public-key', pem, '--dry-run'], { encoding: 'utf8', env: { ...process.env, ...env } });
}

async function compiledExport(headSha: string, findings: unknown[]) {
  const u = await createUser();
  const p = await linearProject(u.token);
  await api(`/projects/${p.id}/execution-mode`, { method: 'PATCH', token: u.token, body: { mode: 'compiled' } });
  const s = await mcp(p.api_key, 'workflow.start', { input: { repo: 'o/r', base_sha: 'a'.repeat(40), head_sha: headSha, changed_files: ['src/x.ts'] } });
  await mcp(p.api_key, 'workflow.report', { runId: s.meta.runId, report: { path: ['worker'], ended_at: 'End: done', findings } });
  return (await api(`/runs/${s.meta.runId}/export`, { token: u.token })).body;
}

test('publish.mjs refuses a model-orchestrated export by default and labels it when accepted', async () => {
  const head = 'e'.repeat(40);
  const finding = { id: 'F1', severity: 'low', category: 'style', file: 'src/x.ts', line_start: 1, title: 'nit', evidence: 'e', suggestion: 's' };
  const doc = await compiledExport(head, [finding]);
  const refused = runPublish(doc, head);
  assert.strictEqual(refused.status, 1);
  assert.ok(/model-orchestrated mode/.test(refused.stderr), refused.stderr);
  const accepted = runPublish(doc, head, { AIORC_ACCEPT_COMPILED: '1' });
  assert.strictEqual(accepted.status, 0, accepted.stderr);
  const planned = JSON.parse(accepted.stdout);
  assert.ok(/self-declared, not server-verified/.test(planned.check.output.title), planned.check.output.title);
  assert.strictEqual(planned.review.comments.length, 1);
});

test('publish.mjs verifies the export and plans one comment, inline comments and a neutral check', async () => {
  const head = 'b'.repeat(40);
  const finding = { id: 'F1', severity: 'high', category: 'security', file: 'src/x.ts', line_start: 3, line_end: 5, title: 'Bad <script>', evidence: 'e', suggestion: 's', control_refs: [], confidence: 1 };
  const r = runPublish(await signedExport(head, [finding]), head);
  assert.strictEqual(r.status, 0, r.stderr);
  const planned = JSON.parse(r.stdout);
  assert.strictEqual(planned.check.name, 'aiorc/review');
  assert.strictEqual(planned.check.conclusion, 'neutral');
  assert.ok(planned.comment.startsWith('<!-- aiorc-review -->'));
  assert.ok(!planned.comment.includes('<script>'), 'finding text is escaped');
  assert.strictEqual(planned.review.event, 'COMMENT');
  assert.deepStrictEqual([planned.review.comments[0].path, planned.review.comments[0].start_line, planned.review.comments[0].line], ['src/x.ts', 3, 5]);
});

test('publish.mjs refuses a tampered export or one for another commit', async () => {
  const head = 'c'.repeat(40);
  const doc = await signedExport(head, []);
  assert.strictEqual(runPublish(doc, 'd'.repeat(40)).status, 1, 'head mismatch');
  doc.payload.run.outcome = 'forged';
  const r = runPublish(doc, head);
  assert.strictEqual(r.status, 1);
  assert.ok(/signature/.test(r.stderr));
});
