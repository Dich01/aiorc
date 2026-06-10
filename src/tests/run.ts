import assert from 'assert';
import { FlowDocument } from '../db/schema';
import { classifySkips } from '../lib/skipAnalysis';
import { gradeEval } from '../lib/evalGrading';
import { chooseTransition, resolveDispatch, allowedEdges } from '../orchestrator/engineCore';

// Pure unit tests — no DB, no server. Run with: npm test
//
// Fixture mirrors the real crew shape, reduced:
//
//   start → brain
//   brain → verify         cuando: "el usuario pide diagnóstico"
//   brain → P (parallel)   fallback
//   P → mem, P → struct    (fork: both mandatory)
//   mem → jira, struct → jira   fallback
//   jira → End:success     fallback
//   verify → End:verify    fallback

const flow: FlowDocument = {
  nodes: [
    { id: 'start', type: 'start', x: 0, y: 0 },
    { id: 'A', type: 'agent', agent_name: 'brain', x: 0, y: 0 },
    { id: 'B', type: 'agent', agent_name: 'verify', x: 0, y: 0 },
    { id: 'P', type: 'parallel', x: 0, y: 0 },
    { id: 'C', type: 'agent', agent_name: 'mem', x: 0, y: 0 },
    { id: 'D', type: 'agent', agent_name: 'struct', x: 0, y: 0 },
    { id: 'E', type: 'agent', agent_name: 'jira', x: 0, y: 0 },
    { id: 'end1', type: 'end', outcome: 'success', x: 0, y: 0 },
    { id: 'end2', type: 'end', outcome: 'verify done', x: 0, y: 0 },
  ],
  edges: [
    { id: 'e1', from: 'start', to: 'A' },
    { id: 'e2', from: 'A', to: 'B', condition: 'el usuario pide diagnóstico' },
    { id: 'e3', from: 'A', to: 'P' },
    { id: 'e4', from: 'P', to: 'C' },
    { id: 'e5', from: 'P', to: 'D' },
    { id: 'e6', from: 'C', to: 'E' },
    { id: 'e7', from: 'D', to: 'E' },
    { id: 'e8', from: 'E', to: 'end1' },
    { id: 'e9', from: 'B', to: 'end2' },
  ],
};

const planned = new Set(['brain', 'verify', 'mem', 'struct', 'jira']);
let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

console.log('skipAnalysis');

test('rama no tomada cuenta como off-path, no como skip', () => {
  const r = classifySkips(flow, planned, new Set(['brain', 'mem', 'struct', 'jira']), ['brain', 'mem', 'struct', 'jira']);
  assert.deepStrictEqual([...r.realSkips], []);
  assert.deepStrictEqual([...r.offPath], ['verify']);
});

test('saltearse una rama de un fork Parallel es skip real', () => {
  const r = classifySkips(flow, planned, new Set(['brain', 'mem', 'jira']), ['brain', 'mem', 'jira']);
  assert.ok(r.realSkips.has('struct'), 'struct era rama obligatoria del fork');
  assert.ok(!r.realSkips.has('verify'), 'verify es off-path');
});

test('run truncado antes de una arista fallback es skip real', () => {
  const r = classifySkips(flow, planned, new Set(['brain', 'mem', 'struct']), ['brain', 'mem', 'struct']);
  assert.ok(r.realSkips.has('jira'), 'jira era el destino fallback obligatorio tras struct');
});

test('parar en un End por rama condicional es legal', () => {
  const r = classifySkips(flow, planned, new Set(['brain', 'verify']), ['brain', 'verify']);
  assert.deepStrictEqual([...r.realSkips], []);
  assert.deepStrictEqual(new Set(r.offPath), new Set(['mem', 'struct', 'jira']));
});

test('agente dominador omitido es skip real', () => {
  // jira ejecutado sin brain: brain domina todo lo alcanzable
  const r = classifySkips(flow, planned, new Set(['mem', 'struct', 'jira']), ['mem', 'struct', 'jira']);
  assert.ok(r.realSkips.has('brain'));
});

console.log('engineCore');

test('hint por condición elige la arista condicional', () => {
  const c = chooseTransition(flow, ['A'], 'el usuario pide diagnóstico');
  assert.strictEqual(c.edge?.to, 'B');
});

test('hint por nombre de agente destino', () => {
  const c = chooseTransition(flow, ['A'], 'verify');
  assert.strictEqual(c.edge?.to, 'B');
});

test('"none" toma el fallback cuando existe', () => {
  const c = chooseTransition(flow, ['A'], 'none');
  assert.strictEqual(c.edge?.to, 'P');
});

test('hint inválido es rechazado con error', () => {
  const c = chooseTransition(flow, ['A'], 'xyz-inexistente');
  assert.ok(c.error, 'debe rechazar transiciones ilegales');
});

test('sin hint con múltiples aristas es ambiguo', () => {
  const c = chooseTransition(flow, ['A'], '');
  assert.ok(c.error);
});

test('sin hint con única arista la toma', () => {
  const c = chooseTransition(flow, ['E'], '');
  assert.strictEqual(c.edge?.to, 'end1');
});

test('resolveDispatch de un Parallel despacha todas las ramas', () => {
  const p = flow.nodes.find(n => n.id === 'P')!;
  const d = resolveDispatch(flow, p);
  assert.deepStrictEqual(d.agents.map(a => a.id).sort(), ['C', 'D']);
});

test('resolveDispatch de un End marca fin', () => {
  const end = flow.nodes.find(n => n.id === 'end1')!;
  const d = resolveDispatch(flow, end);
  assert.ok(d.end);
  assert.strictEqual(d.agents.length, 0);
});

test('allowedEdges tras un fork une las salidas de todas las ramas', () => {
  const edges = allowedEdges(flow, ['C', 'D']);
  assert.deepStrictEqual(edges.map(e => e.id).sort(), ['e6', 'e7']);
});

test('join tras un fork: aristas convergentes al mismo nodo no son ambiguas', () => {
  // C y D convergen en E con dos aristas fallback — debe auto-resolverse
  const c = chooseTransition(flow, ['C', 'D'], '');
  assert.strictEqual(c.edge?.to, 'E');
  const byName = chooseTransition(flow, ['C', 'D'], 'jira');
  assert.strictEqual(byName.edge?.to, 'E');
});

test('"none" con todas las aristas condicionales termina el run', () => {
  const onlyCond: FlowDocument = {
    nodes: flow.nodes,
    edges: flow.edges.map(e => e.id === 'e3' ? { ...e, condition: 'es una feature' } : e),
  };
  const c = chooseTransition(onlyCond, ['A'], 'none');
  assert.strictEqual(c.end, true);
});

console.log('evalGrading');

test('pasa cuando completa, outcome matchea y los agentes requeridos corrieron', () => {
  const v = gradeEval(
    { expected_outcome: 'success', must_run_agents: 'brain, jira' },
    { completed: true, outcome: 'End: success', executedAgents: new Set(['brain', 'mem', 'jira']) }
  );
  assert.strictEqual(v.pass, true);
  assert.deepStrictEqual(v.reasons, []);
});

test('falla si el run no se completó', () => {
  const v = gradeEval(
    { expected_outcome: '', must_run_agents: '' },
    { completed: false, outcome: 'cap alcanzado: brain', executedAgents: new Set(['brain']) }
  );
  assert.strictEqual(v.pass, false);
  assert.ok(v.reasons[0]!.includes('no se completó'));
});

test('falla por outcome distinto al esperado', () => {
  const v = gradeEval(
    { expected_outcome: 'PR creado', must_run_agents: '' },
    { completed: true, outcome: 'verify done', executedAgents: new Set(['brain']) }
  );
  assert.strictEqual(v.pass, false);
  assert.ok(v.reasons[0]!.includes('outcome esperado'));
});

test('falla listando los agentes obligatorios que faltaron', () => {
  const v = gradeEval(
    { expected_outcome: '', must_run_agents: 'security-qa, quality-gate' },
    { completed: true, outcome: 'success', executedAgents: new Set(['brain', 'security-qa']) }
  );
  assert.strictEqual(v.pass, false);
  assert.ok(v.reasons[0]!.includes('quality-gate'));
  assert.ok(!v.reasons[0]!.includes('security-qa,'));
});

test('outcome vacío acepta cualquier finalización limpia', () => {
  const v = gradeEval(
    { expected_outcome: '', must_run_agents: '' },
    { completed: true, outcome: 'lo que sea', executedAgents: new Set() }
  );
  assert.strictEqual(v.pass, true);
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (con fallos)' : ''}`);
