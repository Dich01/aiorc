import assert from 'assert';
import { section, test } from '../harness';
import { AgentInfo, FlowDocument, validateFlow } from '../../shared/flow';
import { flow } from './fixtures';

section('flow validation (F5)');

const n = (id: string, type: 'start' | 'agent' | 'parallel' | 'end', extra: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, ...extra });
const e = (id: string, from: string, to: string, extra: Record<string, unknown> = {}) => ({ id, from, to, ...extra });
const agents = (ids: string[], withSchema = true) => new Map<string, AgentInfo>(ids.map(i => [i, { name: i, hasOutputSchema: withSchema }]));

function linear(): FlowDocument {
  return {
    nodes: [n('s', 'start'), n('a', 'agent', { agent_id: 'A1' }), n('x', 'end', { outcome: 'done' })],
    edges: [e('e1', 's', 'a'), e('e2', 'a', 'x')],
  } as FlowDocument;
}

const has = (errors: string[], re: RegExp) => assert.ok(errors.some(m => re.test(m)), `expected ${re} in:\n${errors.join('\n')}`);

test('the reference fixture and a linear flow are valid', () => {
  assert.deepStrictEqual(validateFlow(flow), []);
  assert.deepStrictEqual(validateFlow(linear(), agents(['A1'])), []);
});

test('duplicate node ids are rejected', () => {
  const f = linear(); f.nodes.push(n('a', 'agent', { agent_id: 'A1' }) as never);
  has(validateFlow(f), /share the id "a"/);
});

test('an unknown node type is rejected', () => {
  const f = linear(); f.nodes.push(n('q', 'magic' as never) as never);
  has(validateFlow(f), /unknown type/);
});

test('an unreachable node is rejected', () => {
  const f = linear();
  f.nodes.push(n('lost', 'agent', { agent_id: 'A1' }) as never);
  f.edges.push(e('e9', 'lost', 'x') as never);
  has(validateFlow(f, agents(['A1'])), /cannot be reached from Start/);
});

test('a node without a path to End is rejected', () => {
  const f: FlowDocument = {
    nodes: [n('s', 'start'), n('a', 'agent', { agent_id: 'A1' }), n('b', 'agent', { agent_id: 'A1' }), n('x', 'end')],
    edges: [e('1', 's', 'a'), e('2', 'a', 'x', { condition: 'done' }), e('3', 'a', 'b'), e('4', 'b', 'b')],
  } as FlowDocument;
  has(validateFlow(f, agents(['A1'])), /no path to any End/);
});

test('a flow without an End is rejected', () => {
  const f: FlowDocument = { nodes: [n('s', 'start'), n('a', 'agent', { agent_id: 'A1' })], edges: [e('1', 's', 'a')] } as FlowDocument;
  has(validateFlow(f), /no End node/);
  has(validateFlow(f), /no outgoing edge/);
});

test('several exits need exactly one default', () => {
  const f = linear();
  f.nodes.push(n('y', 'end') as never);
  f.edges.push(e('e3', 'a', 'y') as never);
  has(validateFlow(f, agents(['A1'])), /2 default edge/);
});

test('rule and natural-language exits cannot be mixed on one node', () => {
  const f = linear();
  f.nodes.push(n('y', 'end') as never, n('z', 'end') as never);
  f.edges.push(e('e3', 'a', 'y', { when: { path: 'v', op: 'eq', value: 1 } }) as never, e('e4', 'a', 'z', { condition: 'when bored' }) as never);
  has(validateFlow(f, agents(['A1'])), /mixes rule edges/);
});

test('rule exits require an agent with an output schema', () => {
  const f = linear();
  f.nodes.push(n('y', 'end') as never);
  f.edges.push(e('e3', 'a', 'y', { when: { path: 'v', op: 'eq', value: 1 } }) as never);
  has(validateFlow(f, agents(['A1'], false)), /needs an output schema/);
  assert.deepStrictEqual(validateFlow(f, agents(['A1'], true)), []);
});

test('malformed rules are rejected', () => {
  const f = linear();
  f.nodes.push(n('y', 'end') as never);
  f.edges.push(e('e3', 'a', 'y', { when: { path: 'v', op: 'regex', value: '.*' } }) as never);
  has(validateFlow(f, agents(['A1'])), /rule.op must be one of/);
});

test('a fork branch must be an agent and branches must share one join', () => {
  const f: FlowDocument = {
    nodes: [n('s', 'start'), n('p', 'parallel'), n('a', 'agent', { agent_id: 'A1' }), n('b', 'agent', { agent_id: 'A1' }), n('x', 'end'), n('y', 'end')],
    edges: [e('1', 's', 'p'), e('2', 'p', 'a'), e('3', 'p', 'b'), e('4', 'a', 'x'), e('5', 'b', 'y')],
  } as FlowDocument;
  has(validateFlow(f, agents(['A1'])), /converge on the same join/);

  const g: FlowDocument = {
    nodes: [n('s', 'start'), n('p', 'parallel'), n('a', 'agent', { agent_id: 'A1' }), n('x', 'end')],
    edges: [e('1', 's', 'p'), e('2', 'p', 'a'), e('3', 'p', 'x'), e('4', 'a', 'x')],
  } as FlowDocument;
  has(validateFlow(g, agents(['A1'])), /every branch must be an agent node/);
});

test('an agent the project cannot use is rejected', () => {
  has(validateFlow(linear(), agents(['other'])), /does not exist or is not available/);
});
