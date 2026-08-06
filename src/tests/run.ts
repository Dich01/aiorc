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
//   brain → verify         when: "the user asks for a diagnosis"
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
    { id: 'e2', from: 'A', to: 'B', condition: 'the user asks for a diagnosis' },
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

console.log('engineCore');

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

console.log('evalGrading');

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

console.log('controlPlane');

test('a paused project blocks new runs', () => {
  const g = gateExecution({ action: 'start', projectPaused: true, runStatus: null });
  assert.strictEqual(g.allowed, false);
  assert.ok(g.reason.includes('paus'));
});

test('a paused project does NOT interrupt a run in flight (surgical pause)', () => {
  const g = gateExecution({ action: 'step', projectPaused: true, runStatus: 'running' });
  assert.strictEqual(g.allowed, true);
});

test('a cancelled run blocks its own next step without affecting others', () => {
  const cancelled = gateExecution({ action: 'step', projectPaused: false, runStatus: 'cancelled' });
  assert.strictEqual(cancelled.allowed, false);
  assert.ok(cancelled.reason.includes('cancel'));
  const other = gateExecution({ action: 'step', projectPaused: false, runStatus: 'running' });
  assert.strictEqual(other.allowed, true);
});

test('an active project allows everything', () => {
  assert.strictEqual(gateExecution({ action: 'start', projectPaused: false, runStatus: null }).allowed, true);
  assert.strictEqual(gateExecution({ action: 'step', projectPaused: false, runStatus: 'running' }).allowed, true);
});

test('an abandoned run can resume (auto-resurrection, not a block)', () => {
  const g = gateExecution({ action: 'step', projectPaused: false, runStatus: 'abandoned' });
  assert.strictEqual(g.allowed, true);
});

test('isAbandoned: 2h without activity marks abandonment, recent activity does not', () => {
  const TWO_H = 2 * 3600 * 1000;
  assert.strictEqual(isAbandoned(1000, 1000 + TWO_H + 1, TWO_H), true);
  assert.strictEqual(isAbandoned(1000, 1000 + TWO_H - 1, TWO_H), false);
});

console.log('report gating');

test('a cancelled run does NOT accept workflow.report', () => {
  assert.strictEqual(canAcceptReport('cancelled'), false);
});
test('an abandoned run does NOT accept workflow.report', () => {
  assert.strictEqual(canAcceptReport('abandoned'), false);
});
test('running, completed and delivered DO accept a report', () => {
  assert.strictEqual(canAcceptReport('running'), true);
  assert.strictEqual(canAcceptReport('completed'), true);
  assert.strictEqual(canAcceptReport('delivered'), true);
});

console.log('verified/audited honesty');

test('a stepped run that was cancelled or abandoned does not count as verified', () => {
  assert.strictEqual(countsAsVerified('stepped', 'completed'), true);
  assert.strictEqual(countsAsVerified('stepped', 'running'), true);
  assert.strictEqual(countsAsVerified('stepped', 'cancelled'), false);
  assert.strictEqual(countsAsVerified('stepped', 'abandoned'), false);
  assert.strictEqual(countsAsVerified('', 'completed'), false); // compiled mode is never verified
});

console.log('SSRF guard');

test('rejects URLs pointing at internal or private hosts', () => {
  assert.strictEqual(isSafeOutboundUrl('http://localhost:3001'), false);
  assert.strictEqual(isSafeOutboundUrl('http://127.0.0.1/x'), false);
  assert.strictEqual(isSafeOutboundUrl('http://169.254.169.254/latest'), false);
  assert.strictEqual(isSafeOutboundUrl('http://10.0.0.5/x'), false);
  assert.strictEqual(isSafeOutboundUrl('http://192.168.1.1/x'), false);
  assert.strictEqual(isSafeOutboundUrl('https://mcp.example.com/jira'), true);
});

console.log('auditExport');

test('the export signature is deterministic and verifiable', () => {
  const payload = JSON.stringify({ runId: 'r1', path: ['brain', 'security-qa'] });
  const sig = signAudit(payload, 'secret-1');
  assert.strictEqual(sig, signAudit(payload, 'secret-1'));
  assert.strictEqual(verifyAudit(payload, sig, 'secret-1'), true);
});

test('altering the payload or using a different key invalidates the signature', () => {
  const payload = JSON.stringify({ runId: 'r1', path: ['brain', 'security-qa'] });
  const sig = signAudit(payload, 'secret-1');
  const tampered = JSON.stringify({ runId: 'r1', path: ['brain'] });
  assert.strictEqual(verifyAudit(tampered, sig, 'secret-1'), false);
  assert.strictEqual(verifyAudit(payload, sig, 'another-key'), false);
});

console.log('mcpServers (B1)');

test('accepts a valid MCP server', () => {
  const v = validateMcpServer({ name: 'jira', url: 'https://mcp.example.com/jira', description: 'tickets' });
  assert.strictEqual(v.ok, true);
});

test('rejects a URL that is not http or https', () => {
  assert.strictEqual(validateMcpServer({ name: 'x', url: 'ftp://malo' }).ok, false);
  assert.strictEqual(validateMcpServer({ name: 'x', url: 'javascript:alert(1)' }).ok, false);
  assert.strictEqual(validateMcpServer({ name: 'x', url: 'not-a-url' }).ok, false);
});

test('rejects an empty or overly long name', () => {
  assert.strictEqual(validateMcpServer({ name: '', url: 'https://ok.com' }).ok, false);
  assert.strictEqual(validateMcpServer({ name: 'x'.repeat(80), url: 'https://ok.com' }).ok, false);
});

console.log('gateway B2 (single connection)');

test('external tools are namespaced as server__tool', () => {
  assert.strictEqual(externalToolName('jira', 'create_issue'), 'jira__create_issue');
});

test('a namespaced name parses back', () => {
  const p = parseExternalTool('jira__create_issue');
  assert.deepStrictEqual(p, { server: 'jira', tool: 'create_issue' });
});

test("AIOrc's own tools are not mistaken for external ones", () => {
  assert.strictEqual(parseExternalTool('workflow.start'), null);
  assert.strictEqual(parseExternalTool('workflow'), null);
});

test('server names are sanitized to the MCP charset', () => {
  assert.strictEqual(externalToolName('My Server!', 'tool'), 'my-server__tool');
});

test('a tool with a double underscore in its name is preserved', () => {
  const p = parseExternalTool('jira__sub__tool');
  assert.deepStrictEqual(p, { server: 'jira', tool: 'sub__tool' });
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
