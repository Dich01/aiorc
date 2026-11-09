import assert from 'assert';
import { section, test } from '../harness';
import { gradeEval } from '../../lib/evalGrading';

section('evalGrading');


test('passes when the run completes, the outcome matches and the required agents ran', () => {
  const v = gradeEval(
    { expected_outcome: 'success', must_run_agents: 'brain, jira' },
    { completed: true, outcome: 'End: success', executedAgents: new Set(['brain', 'mem', 'jira']) }
  );
  assert.strictEqual(v.pass, true);
  assert.deepStrictEqual(v.reasons, []);
});

test('fails when the run did not complete', () => {
  const v = gradeEval(
    { expected_outcome: '', must_run_agents: '' },
    { completed: false, outcome: 'invocation cap reached: brain', executedAgents: new Set(['brain']) }
  );
  assert.strictEqual(v.pass, false);
  assert.ok(v.reasons[0]!.includes('did not complete'));
});

test('fails when the outcome differs from the expected one', () => {
  const v = gradeEval(
    { expected_outcome: 'PR created', must_run_agents: '' },
    { completed: true, outcome: 'verify done', executedAgents: new Set(['brain']) }
  );
  assert.strictEqual(v.pass, false);
  assert.ok(v.reasons[0]!.includes('expected outcome'));
});

test('fails listing the required agents that never ran', () => {
  const v = gradeEval(
    { expected_outcome: '', must_run_agents: 'security-qa, quality-gate' },
    { completed: true, outcome: 'success', executedAgents: new Set(['brain', 'security-qa']) }
  );
  assert.strictEqual(v.pass, false);
  assert.ok(v.reasons[0]!.includes('quality-gate'));
  assert.ok(!v.reasons[0]!.includes('security-qa,'));
});

test('an empty expected outcome accepts any clean completion', () => {
  const v = gradeEval(
    { expected_outcome: '', must_run_agents: '' },
    { completed: true, outcome: 'anything at all', executedAgents: new Set() }
  );
  assert.strictEqual(v.pass, true);
});
