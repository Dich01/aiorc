import assert from 'assert';
import { section, test } from '../harness';
import { classifySkips } from '../../lib/skipAnalysis';
import { flow } from './fixtures';

const planned = new Set(['brain', 'verify', 'mem', 'struct', 'jira']);

section('skipAnalysis');


test('a branch not taken counts as off-path, not as a skip', () => {
  const r = classifySkips(flow, planned, new Set(['brain', 'mem', 'struct', 'jira']), ['brain', 'mem', 'struct', 'jira']);
  assert.deepStrictEqual([...r.realSkips], []);
  assert.deepStrictEqual([...r.offPath], ['verify']);
});

test('skipping a branch of a Parallel fork is a real skip', () => {
  const r = classifySkips(flow, planned, new Set(['brain', 'mem', 'jira']), ['brain', 'mem', 'jira']);
  assert.ok(r.realSkips.has('struct'), 'struct was a mandatory fork branch');
  assert.ok(!r.realSkips.has('verify'), 'verify is off-path');
});

test('a run cut short before a fallback edge is a real skip', () => {
  const r = classifySkips(flow, planned, new Set(['brain', 'mem', 'struct']), ['brain', 'mem', 'struct']);
  assert.ok(r.realSkips.has('jira'), 'jira was the mandatory fallback target after struct');
});

test('stopping at an End through a conditional branch is legal', () => {
  const r = classifySkips(flow, planned, new Set(['brain', 'verify']), ['brain', 'verify']);
  assert.deepStrictEqual([...r.realSkips], []);
  assert.deepStrictEqual(new Set(r.offPath), new Set(['mem', 'struct', 'jira']));
});

test('a skipped dominator agent is a real skip', () => {
  // jira ran without brain: brain dominates everything reachable
  const r = classifySkips(flow, planned, new Set(['mem', 'struct', 'jira']), ['mem', 'struct', 'jira']);
  assert.ok(r.realSkips.has('brain'));
});
