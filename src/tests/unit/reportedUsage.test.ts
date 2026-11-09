import assert from 'assert';
import { section, test } from '../harness';
import { extractReportedInvocations } from '../../lib/usage';

section('reported usage (model-orchestrated mode)');

test('invocations_per_agent wins over path', () => {
  const m = extractReportedInvocations({ path: ['a', 'a', 'b'], invocations_per_agent: { a: 3, b: 0 } });
  assert.deepStrictEqual([...m.entries()], [['a', 3], ['b', 1]]);
});

test('without invocations_per_agent, path occurrences are counted', () => {
  const m = extractReportedInvocations({ path: ['a', ' b ', 'a', 7, ''] });
  assert.deepStrictEqual([...m.entries()], [['a', 2], ['b', 1]]);
});

test('anything else yields nothing', () => {
  assert.strictEqual(extractReportedInvocations(null).size, 0);
  assert.strictEqual(extractReportedInvocations({ final_summary: 'done' }).size, 0);
  assert.strictEqual(extractReportedInvocations('path').size, 0);
});
