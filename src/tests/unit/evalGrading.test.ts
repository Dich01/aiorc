import assert from 'assert';
import { section, test } from '../harness';
import { EvalCriteria, EvalRunFacts, gradeEval, matchFindings } from '../../lib/evalGrading';

const criteria = (c: Partial<EvalCriteria> = {}): EvalCriteria => ({ expected_outcome: '', must_complete_agents: [], expected_findings: [], max_extra_findings: null, ...c });
const facts = (f: Partial<EvalRunFacts> = {}): EvalRunFacts => ({ status: 'completed', outcome: 'clean', completedAgents: new Set(), findings: [], ...f });

section('evalGrading (F10)');

test('the expected outcome is compared exactly, not by substring', () => {
  assert.strictEqual(gradeEval(criteria({ expected_outcome: 'clean' }), facts({ outcome: 'clean' })).pass, true);
  assert.strictEqual(gradeEval(criteria({ expected_outcome: 'clean' }), facts({ outcome: 'not clean' })).pass, false);
  assert.strictEqual(gradeEval(criteria({ expected_outcome: 'changes-requested' }), facts({ outcome: 'changes' })).pass, false);
});

test('a run that did not reach an End fails, whatever else matches', () => {
  for (const status of ['capped', 'cancelled', 'failed', 'active'] as const) {
    assert.strictEqual(gradeEval(criteria(), facts({ status })).pass, false, status);
  }
});

test('required agents must have completed a step, not just been dispatched', () => {
  const v = gradeEval(criteria({ must_complete_agents: ['scope', 'verifier'] }), facts({ completedAgents: new Set(['scope']) }));
  assert.strictEqual(v.pass, false);
  assert.ok(v.reasons[0]!.includes('verifier'));
});

test('expected findings match by field and minimum severity', () => {
  const findings = [
    { file: 'src/auth.ts', category: 'security', severity: 'high', title: 'x' },
    { file: 'src/ui.ts', category: 'style', severity: 'low', title: 'y' },
  ];
  assert.strictEqual(gradeEval(criteria({ expected_findings: [{ file: 'src/auth.ts', category: 'security', min_severity: 'medium' }] }), facts({ findings })).pass, true);
  assert.strictEqual(gradeEval(criteria({ expected_findings: [{ file: 'src/auth.ts', min_severity: 'critical' }] }), facts({ findings })).pass, false);
  assert.strictEqual(gradeEval(criteria({ expected_findings: [{ file: 'src/auth' }] }), facts({ findings })).pass, false, 'no partial strings');
});

test('max_extra_findings limits false positives', () => {
  const findings = [{ file: 'a', severity: 'high' }, { file: 'b', severity: 'low' }, { file: 'c', severity: 'low' }];
  const c = criteria({ expected_findings: [{ file: 'a' }], max_extra_findings: 1 });
  const v = gradeEval(c, facts({ findings }));
  assert.strictEqual(v.pass, false);
  assert.strictEqual(v.extra, 2);
  assert.strictEqual(gradeEval({ ...c, max_extra_findings: 2 }, facts({ findings })).pass, true);
});

test('each expected finding needs its own finding, regardless of order', () => {
  const findings = [{ file: 'a', category: 'security' }, { file: 'a', category: 'correctness' }];
  assert.strictEqual(matchFindings([{ file: 'a' }, { file: 'a', category: 'security' }], findings).matched, 2);
  assert.strictEqual(matchFindings([{ file: 'a' }, { file: 'a' }, { file: 'a' }], findings).matched, 2);
});
