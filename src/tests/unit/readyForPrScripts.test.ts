// The deterministic scripts of harnesses/ready-for-pr, run with python3 and
// git against the demo repositories built by extras/make_fixture.py.
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { section, test } from '../harness';
import { TEST_DIR } from '../env';

export const RFP = path.join(process.cwd(), 'harnesses', 'ready-for-pr');
export const RFP_SCRIPTS = path.join(RFP, 'skills', 'harness-scripts');
export const RFP_PROFILE = path.join(RFP, 'contexts', 'repo-profile', 'profile.json');

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
}

// A demo repository for one case, with the example profile in place, as the
// task step leaves it.
export function fixture(name: string): string {
  const dir = fs.mkdtempSync(path.join(TEST_DIR, `rfp-${name}-`));
  fs.rmSync(dir, { recursive: true });
  execFileSync('python3', [path.join(RFP, 'extras', 'make_fixture.py'), name, dir], { encoding: 'utf8' });
  const state = path.join(git(dir, 'rev-parse', '--absolute-git-dir'), 'aiorc');
  fs.mkdirSync(state, { recursive: true });
  fs.copyFileSync(RFP_PROFILE, path.join(state, 'profile.json'));
  return dir;
}

export function py(cwd: string, script: string, ...args: string[]): any {
  const out = execFileSync('python3', [path.join(RFP_SCRIPTS, script), ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  return JSON.parse(out);
}

export function write(dir: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}

section('ready-for-pr: deterministic scripts');

test('classify_risk: the fixed rule gives each case its level, depth and merge path', () => {
  const want: Record<string, [string, string, string]> = {
    'docs-only': ['auto', 'none', 'auto'],
    'failing-check': ['normal', 'min', 'author'],
    'sql-injection': ['sensitive', 'full', 'human'],
    'big-change': ['split', 'none', 'author'],
    'no-changes': ['none', 'none', 'author'],
  };
  for (const [name, [level, depth, merge]] of Object.entries(want)) {
    const r = py(fixture(name), 'classify_risk.py');
    assert.deepStrictEqual([r.level, r.depth, r.merge_path], [level, depth, merge], name);
    assert.match(r.script.sha256, /^[0-9a-f]{64}$/);
  }
  const sensitive = py(fixture('sql-injection'), 'classify_risk.py');
  assert.deepStrictEqual(sensitive.owners, [{ team: 'security', files: ['app/auth/users.py'] }]);
});

test('checks: runs the profile commands, stops at the first failure and writes the marker only on success', () => {
  const failing = fixture('failing-check');
  const r = py(failing, 'checks.py', '--run-id', 'r1');
  assert.strictEqual(r.configured, true);
  assert.strictEqual(r.passed, false);
  assert.strictEqual(r.failed_check, 'tests');
  assert.ok(r.results[1].output_tail.includes('test_multiply'), r.results[1].output_tail);
  assert.strictEqual(fs.existsSync(path.join(failing, '.git', 'aiorc', 'checked.json')), false);

  const ok = fixture('sql-injection');
  const p = py(ok, 'checks.py', '--run-id', 'r1');
  assert.strictEqual(p.passed, true);
  const marker = JSON.parse(fs.readFileSync(path.join(ok, '.git', 'aiorc', 'checked.json'), 'utf8'));
  assert.strictEqual(marker.head_sha, git(ok, 'rev-parse', 'HEAD'));
});

test('checks: a profile without commands is reported as not configured', () => {
  const dir = fixture('docs-only');
  const empty = path.join(dir, '.git', 'aiorc', 'empty.json');
  fs.writeFileSync(empty, JSON.stringify({ base_branch: 'main', checks: [] }));
  const r = py(dir, 'checks.py', '--run-id', 'r1', '--profile', empty);
  assert.deepStrictEqual([r.configured, r.passed], [false, false]);
});

test('checks: {changed_files:<globs>} passes only the matching files, and skips the check when none match', () => {
  const dir = fixture('failing-check');
  write(dir, 'docs/notes.md', 'notes\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'notes');
  const args = path.join(dir, '.git', 'aiorc', 'args.txt');
  const profile = path.join(dir, '.git', 'aiorc', 'filtered.json');
  fs.writeFileSync(profile, JSON.stringify({ base_branch: 'main', checks: [
    { name: 'py-only', command: `printf '%s\\n' {changed_files:*.py} > ${args}` },
    { name: 'sql-only', command: 'false {changed_files:*.sql,migrations/**}' },
  ] }));
  const r = py(dir, 'checks.py', '--run-id', 'r1', '--profile', profile);
  assert.deepStrictEqual(fs.readFileSync(args, 'utf8').trim().split('\n').sort(), ['app/calc.py', 'tests/test_calc.py']);
  assert.strictEqual(r.results[1].status, 'skipped', 'no changed file matches: the check is skipped, not failed');
  assert.strictEqual(r.passed, true);
});

test('detect_weakening: deleted tests, skips, CI and coverage changes are caught; a normal change is not', () => {
  const deleted = py(fixture('weakened-tests'), 'detect_weakening.py');
  assert.strictEqual(deleted.weakened, true);
  assert.ok(deleted.items.some((i: { kind: string }) => i.kind === 'test-deleted'));

  const dir = fixture('no-changes');
  git(dir, 'checkout', '-q', 'main');
  write(dir, 'pyproject.toml', '[tool.coverage.report]\nfail_under = 70\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'coverage');
  git(dir, 'checkout', '-q', 'feature'); git(dir, 'merge', '-q', '--ff-only', 'main');
  write(dir, 'tests/test_calc.py', fs.readFileSync(path.join(dir, 'tests/test_calc.py'), 'utf8').replace('    def test_add', '    @unittest.skip("later")\n    def test_add'));
  write(dir, '.github/workflows/ci.yml', 'jobs:\n  t:\n    steps:\n      - run: make test\n        continue-on-error: true\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'loosen');
  const kinds = py(dir, 'detect_weakening.py').items.map((i: { kind: string }) => i.kind);
  assert.ok(kinds.includes('test-skipped'), kinds.join());
  assert.ok(kinds.includes('ci-weakened'), kinds.join());

  write(dir, 'pyproject.toml', '[tool.coverage.report]\nfail_under = 50\n');
  git(dir, 'commit', '-qam', 'lower');
  assert.ok(py(dir, 'detect_weakening.py').items.some((i: { kind: string }) => i.kind === 'coverage-lowered'));

  assert.strictEqual(py(fixture('sql-injection'), 'detect_weakening.py').weakened, false);
});

test('prepare_diff: strips comments keeping line numbers, then reviews only what changed since the last round', () => {
  const dir = fixture('no-changes');
  write(dir, 'app/calc.py', fs.readFileSync(path.join(dir, 'app/calc.py'), 'utf8') + '\n\n# multiply two numbers\ndef multiply(a, b):\n    return a * b  # the product\n');
  git(dir, 'commit', '-qam', 'multiply');
  const r1 = py(dir, 'prepare_diff.py', '--run-id', 'r1');
  assert.deepStrictEqual([r1.round, r1.scope, r1.depth], [1, 'full', 'min']);
  const stripped = fs.readFileSync(r1.nocomments_file, 'utf8');
  assert.ok(!stripped.includes('the product') && !stripped.includes('multiply two'), stripped);
  assert.strictEqual(stripped.split('\n').length, fs.readFileSync(r1.diff_file, 'utf8').split('\n').length, 'same number of lines');

  const same = py(dir, 'prepare_diff.py', '--run-id', 'r1');
  assert.deepStrictEqual([same.round, same.scope, same.depth, same.files], [2, 'incremental', 'none', []]);

  write(dir, 'app/calc.py', fs.readFileSync(path.join(dir, 'app/calc.py'), 'utf8').replace('a * b', 'b * a'));
  git(dir, 'commit', '-qam', 'swap');
  const r3 = py(dir, 'prepare_diff.py', '--run-id', 'r1');
  assert.deepStrictEqual([r3.round, r3.scope, r3.depth, r3.files], [3, 'incremental', 'min', ['app/calc.py']]);
  assert.ok(!fs.readFileSync(r3.diff_file, 'utf8').includes('+def multiply'), 'the later round holds only the new commit');
});

// What the fixer does on the failing-check case: multiply returned a + b.
export function fixMultiply(dir: string): string {
  write(dir, 'app/calc.py', fs.readFileSync(path.join(dir, 'app/calc.py'), 'utf8').replace('def multiply(a, b):\n    return a + b', 'def multiply(a, b):\n    return a * b'));
  git(dir, 'commit', '-qam', 'fix: multiply returns the product');
  return git(dir, 'rev-parse', 'HEAD');
}

export function finding(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, severity: 'high', category: 'security', file: 'app/auth/users.py', line_start: 15, line_end: 16,
    title: 'SQL built from the name parameter', failure_scenario: "name = \"x' OR '1'='1\" returns the first user",
    evidence: "'%s' % name", suggestion: 'Bind the parameter.', reviewer: 'review-security', verification: 'confirmed',
    verification_note: 'a test with that name fails', ...extra,
  };
}

test('filter_findings: drops discarded, merges duplicates, blocks only on confirmed severe findings, remembers rejections', () => {
  const dir = fixture('sql-injection');
  py(dir, 'checks.py', '--run-id', 'r1');
  const file = path.join(dir, '.git', 'aiorc', 'verified.json');
  fs.writeFileSync(file, JSON.stringify({ findings: [
    finding('sec-1'),
    finding('corr-1', { severity: 'medium', reviewer: 'review-correctness', verification: 'plausible', title: 'SQL injection through name' }),
    finding('dup-1', { category: 'duplication', severity: 'low', verification: 'discarded', verification_note: 'not a copy' }),
    finding('low-1', { category: 'correctness', severity: 'high', verification: 'plausible', file: 'app/calc.py', title: 'Unrelated' }),
  ] }));
  const f = py(dir, 'filter_findings.py', 'filter', '--run-id', 'r1', '--findings', file);
  assert.strictEqual(f.blocking, true);
  assert.deepStrictEqual(f.blocking_ids, ['sec-1'], 'a plausible high finding does not block');
  assert.deepStrictEqual(f.findings.map((x: { id: string }) => x.id), ['sec-1', 'low-1'], 'sorted by severity, then file');
  assert.strictEqual(f.findings.find((x: { id: string }) => x.id === 'sec-1').reviewer, 'review-correctness+review-security');
  assert.ok(f.dropped.some((d: { id: string }) => d.id === 'dup-1'));

  const d = py(dir, 'filter_findings.py', 'decide', '--run-id', 'r1', '--id', 'sec-1', '--action', 'rejected', '--reason', 'validated upstream');
  assert.strictEqual(d.recorded.action, 'rejected');
  const s = py(dir, 'filter_findings.py', 'summary', '--run-id', 'r1');
  assert.deepStrictEqual([s.merge_path, s.checks_current, s.rejected_blockers], ['human', true, ['sec-1']]);

  const again = py(dir, 'filter_findings.py', 'filter', '--run-id', 'r2', '--findings', file);
  assert.strictEqual(again.blocking, false, 'a rejected finding is not reported again');
});

test('filter_findings summary: the marker goes stale when the code changes after the checks', () => {
  const dir = fixture('failing-check');
  fixMultiply(dir);
  assert.strictEqual(py(dir, 'checks.py', '--run-id', 'r1').passed, true);
  assert.strictEqual(py(dir, 'filter_findings.py', 'summary', '--run-id', 'r1').checks_current, true);
  write(dir, 'app/calc.py', fs.readFileSync(path.join(dir, 'app/calc.py'), 'utf8') + '\n# later edit\n');
  assert.strictEqual(py(dir, 'filter_findings.py', 'summary', '--run-id', 'r1').checks_current, false);
});
