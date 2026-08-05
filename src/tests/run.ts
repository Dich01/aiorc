import assert from 'assert';
import { FlowDocument } from '../db/schema';
import { classifySkips } from '../lib/skipAnalysis';
import { gradeEval } from '../lib/evalGrading';
import { chooseTransition, resolveDispatch, allowedEdges } from '../orchestrator/engineCore';
import { gateExecution, signAudit, verifyAudit, isAbandoned, canAcceptReport, countsAsVerified } from '../lib/controlPlane';
import { isSafeOutboundUrl } from '../lib/mcpServers';
import { validateMcpServer, externalToolName, parseExternalTool } from '../lib/mcpServers';

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
    { completed: false, outcome: 'invocation cap reached: brain', executedAgents: new Set(['brain']) }
  );
  assert.strictEqual(v.pass, false);
  assert.ok(v.reasons[0]!.includes('did not complete'));
});

test('falla por outcome distinto al esperado', () => {
  const v = gradeEval(
    { expected_outcome: 'PR creado', must_run_agents: '' },
    { completed: true, outcome: 'verify done', executedAgents: new Set(['brain']) }
  );
  assert.strictEqual(v.pass, false);
  assert.ok(v.reasons[0]!.includes('expected outcome'));
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

console.log('controlPlane');

test('proyecto pausado bloquea runs nuevos', () => {
  const g = gateExecution({ action: 'start', projectPaused: true, runStatus: null });
  assert.strictEqual(g.allowed, false);
  assert.ok(g.reason.includes('paus'));
});

test('proyecto pausado NO interrumpe un run en curso (pause quirúrgico)', () => {
  const g = gateExecution({ action: 'step', projectPaused: true, runStatus: 'running' });
  assert.strictEqual(g.allowed, true);
});

test('run cancelado bloquea su próximo paso sin afectar a otros', () => {
  const cancelled = gateExecution({ action: 'step', projectPaused: false, runStatus: 'cancelled' });
  assert.strictEqual(cancelled.allowed, false);
  assert.ok(cancelled.reason.includes('cancel'));
  const other = gateExecution({ action: 'step', projectPaused: false, runStatus: 'running' });
  assert.strictEqual(other.allowed, true);
});

test('proyecto activo permite todo', () => {
  assert.strictEqual(gateExecution({ action: 'start', projectPaused: false, runStatus: null }).allowed, true);
  assert.strictEqual(gateExecution({ action: 'step', projectPaused: false, runStatus: 'running' }).allowed, true);
});

test('un run abandonado puede retomar (auto-resurrección, no bloqueo)', () => {
  const g = gateExecution({ action: 'step', projectPaused: false, runStatus: 'abandoned' });
  assert.strictEqual(g.allowed, true);
});

test('isAbandoned: 2h sin actividad marca abandono, actividad reciente no', () => {
  const TWO_H = 2 * 3600 * 1000;
  assert.strictEqual(isAbandoned(1000, 1000 + TWO_H + 1, TWO_H), true);
  assert.strictEqual(isAbandoned(1000, 1000 + TWO_H - 1, TWO_H), false);
});

console.log('report gating');

test('un run cancelado NO acepta workflow.report', () => {
  assert.strictEqual(canAcceptReport('cancelled'), false);
});
test('un run abandonado NO acepta workflow.report', () => {
  assert.strictEqual(canAcceptReport('abandoned'), false);
});
test('running, completed y delivered SÍ aceptan report', () => {
  assert.strictEqual(canAcceptReport('running'), true);
  assert.strictEqual(canAcceptReport('completed'), true);
  assert.strictEqual(canAcceptReport('delivered'), true);
});

console.log('verified/audited honesty');

test('un run stepped cancelado o abandonado no cuenta como verificado', () => {
  assert.strictEqual(countsAsVerified('stepped', 'completed'), true);
  assert.strictEqual(countsAsVerified('stepped', 'running'), true);
  assert.strictEqual(countsAsVerified('stepped', 'cancelled'), false);
  assert.strictEqual(countsAsVerified('stepped', 'abandoned'), false);
  assert.strictEqual(countsAsVerified('', 'completed'), false); // compiled nunca es verified
});

console.log('SSRF guard');

test('rechaza URLs a hosts internos/privados', () => {
  assert.strictEqual(isSafeOutboundUrl('http://localhost:3001'), false);
  assert.strictEqual(isSafeOutboundUrl('http://127.0.0.1/x'), false);
  assert.strictEqual(isSafeOutboundUrl('http://169.254.169.254/latest'), false);
  assert.strictEqual(isSafeOutboundUrl('http://10.0.0.5/x'), false);
  assert.strictEqual(isSafeOutboundUrl('http://192.168.1.1/x'), false);
  assert.strictEqual(isSafeOutboundUrl('https://mcp.empresa.com/jira'), true);
});

console.log('auditExport');

test('la firma del export es determinista y verificable', () => {
  const payload = JSON.stringify({ runId: 'r1', path: ['brain', 'security-qa'] });
  const sig = signAudit(payload, 'secret-1');
  assert.strictEqual(sig, signAudit(payload, 'secret-1'));
  assert.strictEqual(verifyAudit(payload, sig, 'secret-1'), true);
});

test('alterar el payload o usar otra clave invalida la firma', () => {
  const payload = JSON.stringify({ runId: 'r1', path: ['brain', 'security-qa'] });
  const sig = signAudit(payload, 'secret-1');
  const tampered = JSON.stringify({ runId: 'r1', path: ['brain'] });
  assert.strictEqual(verifyAudit(tampered, sig, 'secret-1'), false);
  assert.strictEqual(verifyAudit(payload, sig, 'otra-clave'), false);
});

console.log('mcpServers (B1)');

test('acepta un MCP server válido', () => {
  const v = validateMcpServer({ name: 'jira', url: 'https://mcp.empresa.com/jira', description: 'tickets' });
  assert.strictEqual(v.ok, true);
});

test('rechaza URL que no sea http/https', () => {
  assert.strictEqual(validateMcpServer({ name: 'x', url: 'ftp://malo' }).ok, false);
  assert.strictEqual(validateMcpServer({ name: 'x', url: 'javascript:alert(1)' }).ok, false);
  assert.strictEqual(validateMcpServer({ name: 'x', url: 'no-es-url' }).ok, false);
});

test('rechaza nombre vacío o demasiado largo', () => {
  assert.strictEqual(validateMcpServer({ name: '', url: 'https://ok.com' }).ok, false);
  assert.strictEqual(validateMcpServer({ name: 'x'.repeat(80), url: 'https://ok.com' }).ok, false);
});

console.log('gateway B2 (una sola conexión)');

test('los tools externos se namespacean como servidor__tool', () => {
  assert.strictEqual(externalToolName('jira', 'create_issue'), 'jira__create_issue');
});

test('el nombre namespaced se parsea de vuelta', () => {
  const p = parseExternalTool('jira__create_issue');
  assert.deepStrictEqual(p, { server: 'jira', tool: 'create_issue' });
});

test('tools propios de AIOrc no se confunden con externos', () => {
  assert.strictEqual(parseExternalTool('workflow.start'), null);
  assert.strictEqual(parseExternalTool('workflow'), null);
});

test('nombres de server se sanitizan al charset MCP', () => {
  assert.strictEqual(externalToolName('Mi Server!', 'tool'), 'mi-server__tool');
});

test('un tool con doble guion bajo en su nombre se preserva', () => {
  const p = parseExternalTool('jira__sub__tool');
  assert.deepStrictEqual(p, { server: 'jira', tool: 'sub__tool' });
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (con fallos)' : ''}`);
