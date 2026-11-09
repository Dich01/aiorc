import assert from 'assert';
import { section, test } from '../harness';
import { FlowDocument } from '../../db/schema';
import { chooseTransition, resolveDispatch, allowedEdges } from '../../orchestrator/engineCore';
import { flow } from './fixtures';

section('engineCore');


test('a condition hint picks the conditional edge', () => {
  const c = chooseTransition(flow, ['A'], 'the user asks for a diagnosis');
  assert.strictEqual(c.edge?.to, 'B');
});

test('a hint by target agent name resolves', () => {
  const c = chooseTransition(flow, ['A'], 'verify');
  assert.strictEqual(c.edge?.to, 'B');
});

test('"none" takes the fallback when one exists', () => {
  const c = chooseTransition(flow, ['A'], 'none');
  assert.strictEqual(c.edge?.to, 'P');
});

test('an invalid hint is rejected with an error', () => {
  const c = chooseTransition(flow, ['A'], 'xyz-nonexistent');
  assert.ok(c.error, 'must reject illegal transitions');
});

test('no hint with several legal edges is ambiguous', () => {
  const c = chooseTransition(flow, ['A'], '');
  assert.ok(c.error);
});

test('no hint with a single legal edge takes it', () => {
  const c = chooseTransition(flow, ['E'], '');
  assert.strictEqual(c.edge?.to, 'end1');
});

test('resolveDispatch on a Parallel dispatches every branch', () => {
  const p = flow.nodes.find(n => n.id === 'P')!;
  const d = resolveDispatch(flow, p);
  assert.deepStrictEqual(d.agents.map(a => a.id).sort(), ['C', 'D']);
});

test('resolveDispatch on an End marks the run finished', () => {
  const end = flow.nodes.find(n => n.id === 'end1')!;
  const d = resolveDispatch(flow, end);
  assert.ok(d.end);
  assert.strictEqual(d.agents.length, 0);
});

test('allowedEdges after a fork unions the exits of every branch', () => {
  const edges = allowedEdges(flow, ['C', 'D']);
  assert.deepStrictEqual(edges.map(e => e.id).sort(), ['e6', 'e7']);
});

test('join after a fork: edges converging on one node are not ambiguous', () => {
  // C and D converge on E through two fallback edges — must auto-resolve
  const c = chooseTransition(flow, ['C', 'D'], '');
  assert.strictEqual(c.edge?.to, 'E');
  const byName = chooseTransition(flow, ['C', 'D'], 'jira');
  assert.strictEqual(byName.edge?.to, 'E');
});

test('"none" with every edge conditional ends the run', () => {
  const onlyCond: FlowDocument = {
    nodes: flow.nodes,
    edges: flow.edges.map(e => e.id === 'e3' ? { ...e, condition: 'it is a feature' } : e),
  };
  const c = chooseTransition(onlyCond, ['A'], 'none');
  assert.strictEqual(c.end, true);
});
