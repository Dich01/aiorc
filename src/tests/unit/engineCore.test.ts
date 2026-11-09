import assert from 'assert';
import { section, test } from '../harness';
import { FlowDocument } from '../../db/schema';
import { checkOutputCoverage, resolveDispatch, resolveExit } from '../../orchestrator/engineCore';
import { evaluateRule } from '../../shared/flow';
import { flow } from './fixtures';

const none = new Map<string, unknown>();

section('engineCore: natural-language exits (F3)');

test('the client picks a natural-language exit by exact edge id', () => {
  assert.strictEqual(resolveExit(flow, ['A'], none, 'e2').edge?.to, 'B');
  assert.strictEqual(resolveExit(flow, ['A'], none, 'e3').edge?.to, 'P');
});

test('agent names, condition text, partial ids, "none" and "end" are all rejected', () => {
  for (const t of ['verify', 'the user asks for a diagnosis', 'e', 'none', 'end', 'pending', 'backend', 'E2']) {
    assert.ok(resolveExit(flow, ['A'], none, t).error, `"${t}" must be rejected`);
  }
});

test('a choice without a transition is rejected', () => {
  assert.ok(resolveExit(flow, ['A'], none, undefined).error);
});

test('a single unconditional exit is taken without a transition, and a wrong one is rejected', () => {
  assert.strictEqual(resolveExit(flow, ['E'], none, undefined).edge?.to, 'end1');
  assert.ok(resolveExit(flow, ['E'], none, 'e2').error);
});

section('engineCore: rule exits');

const ruleFlow: FlowDocument = {
  nodes: [
    { id: 's', type: 'start', x: 0, y: 0 },
    { id: 'rev', type: 'agent', agent_id: 'a1', agent_name: 'reviewer', x: 0, y: 0 },
    { id: 'fix', type: 'agent', agent_id: 'a2', agent_name: 'fixer', x: 0, y: 0 },
    { id: 'ok', type: 'end', outcome: 'clean', x: 0, y: 0 },
  ],
  edges: [
    { id: 'r0', from: 's', to: 'rev' },
    { id: 'r1', from: 'rev', to: 'fix', when: { path: 'verdict', op: 'eq', value: 'FAIL' } },
    { id: 'r2', from: 'rev', to: 'ok', default: true },
    { id: 'r3', from: 'fix', to: 'rev' },
  ],
};

test('the server picks the rule edge from the output', () => {
  assert.strictEqual(resolveExit(ruleFlow, ['rev'], new Map([['rev', { verdict: 'FAIL' }]]), undefined).edge?.id, 'r1');
});

test('no matching rule takes the default edge', () => {
  assert.strictEqual(resolveExit(ruleFlow, ['rev'], new Map([['rev', { verdict: 'PASS' }]]), undefined).edge?.id, 'r2');
});

test('the client cannot choose on a rule exit', () => {
  assert.ok(resolveExit(ruleFlow, ['rev'], new Map([['rev', { verdict: 'PASS' }]]), 'r1').error);
});

section('engineCore: fork and join (F4)');

test('a Parallel dispatches every branch', () => {
  const d = resolveDispatch(flow, flow.nodes.find(n => n.id === 'P')!);
  assert.deepStrictEqual(d.agents.map(a => a.id).sort(), ['C', 'D']);
});

test('after a fork, the join is automatic and a transition is rejected', () => {
  assert.strictEqual(resolveExit(flow, ['C', 'D'], none, undefined).edge?.to, 'E');
  assert.ok(resolveExit(flow, ['C', 'D'], none, 'e6').error);
});

test('outputs must cover exactly the dispatched nodes', () => {
  assert.ok(checkOutputCoverage(['C', 'D'], ['C']));
  assert.ok(checkOutputCoverage(['C', 'D'], ['C', 'C', 'D']));
  assert.ok(checkOutputCoverage(['C', 'D'], ['C', 'D', 'X']));
  assert.strictEqual(checkOutputCoverage(['C', 'D'], ['D', 'C']), null);
});

test('reaching an End finishes the run', () => {
  const d = resolveDispatch(flow, flow.nodes.find(n => n.id === 'end1')!);
  assert.ok(d.end);
  assert.strictEqual(d.agents.length, 0);
});

section('rules');

test('operators: eq, ne, in, gt/gte/lt/lte, exists', () => {
  const o = { verdict: 'FAIL', score: 7, tags: ['a'], nested: { blocking: true }, findings: [{ severity: 'high' }] };
  assert.ok(evaluateRule({ path: 'verdict', op: 'eq', value: 'FAIL' }, o));
  assert.ok(evaluateRule({ path: 'verdict', op: 'ne', value: 'PASS' }, o));
  assert.ok(evaluateRule({ path: 'verdict', op: 'in', value: ['FAIL', 'ERROR'] }, o));
  assert.ok(evaluateRule({ path: 'score', op: 'gt', value: 6 }, o));
  assert.ok(evaluateRule({ path: 'score', op: 'lte', value: 7 }, o));
  assert.ok(!evaluateRule({ path: 'score', op: 'gt', value: '6' }, o), 'no cross-type comparison');
  assert.ok(evaluateRule({ path: 'nested.blocking', op: 'eq', value: true }, o));
  assert.ok(evaluateRule({ path: 'findings.0.severity', op: 'eq', value: 'high' }, o));
  assert.ok(evaluateRule({ path: 'findings.length', op: 'gte', value: 1 }, o));
  assert.ok(evaluateRule({ path: 'missing', op: 'exists', value: false }, o));
  assert.ok(!evaluateRule({ path: 'missing', op: 'exists' }, o));
  assert.ok(!evaluateRule({ path: 'missing', op: 'eq', value: undefined }, o));
});

test('all / any combinators', () => {
  const o = { a: 1, b: 2 };
  assert.ok(evaluateRule({ all: [{ path: 'a', op: 'eq', value: 1 }, { path: 'b', op: 'eq', value: 2 }] }, o));
  assert.ok(!evaluateRule({ all: [{ path: 'a', op: 'eq', value: 1 }, { path: 'b', op: 'eq', value: 3 }] }, o));
  assert.ok(evaluateRule({ any: [{ path: 'a', op: 'eq', value: 9 }, { path: 'b', op: 'eq', value: 2 }] }, o));
});

test('prototype keys are not reachable through paths', () => {
  assert.ok(!evaluateRule({ path: 'constructor', op: 'exists' }, {}));
  assert.ok(!evaluateRule({ path: '__proto__', op: 'exists' }, {}));
});
