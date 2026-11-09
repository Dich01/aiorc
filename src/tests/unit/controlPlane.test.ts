import assert from 'assert';
import { section, test } from '../harness';
import { gateExecution, signAudit, verifyAudit, isAbandoned } from '../../lib/controlPlane';

section('controlPlane');


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

section('auditExport');


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
