import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { section, test } from '../harness';
import { TEST_DIR } from '../env';
import db from '../../db/client';
import { auditKey } from '../../lib/auditKeys';
import { verifyExport } from '../../lib/auditExport';
import { api, createUser, linearProject, mcp, rpc } from './helpers';

async function finishedRun(extra: Record<string, unknown> = {}) {
  const u = await createUser();
  const p = await linearProject(u.token, 'worker', extra);
  const s = await mcp(p.api_key, 'workflow.start', { input: { repo: 'acme/app', base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40), pr_number: 7, diff_sha256: 'c'.repeat(64) } });
  const n = await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 1, outputs: [{ node: 'n1', output: { findings: [], summary: 'clean' } }] });
  assert.strictEqual(n.meta.status, 'completed');
  return { u, p, runId: s.meta.runId as string };
}

const keys = () => new Map([[auditKey().kid, auditKey().publicKey]]);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

section('audit: append-only event chain (F8)');

test('the engine writes a hash chain: started, dispatched, completed, transition, completed', async () => {
  const { runId } = await finishedRun();
  const types = (db.prepare('SELECT type FROM run_events WHERE run_id = ? ORDER BY seq').all(runId) as { type: string }[]).map(r => r.type);
  assert.deepStrictEqual(types, ['run.started', 'step.dispatched', 'step.completed', 'transition.taken', 'run.completed']);
});

test('UPDATE and DELETE on run_events abort', async () => {
  const { runId } = await finishedRun();
  assert.throws(() => db.prepare("UPDATE run_events SET payload_json = '{}' WHERE run_id = ?").run(runId), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM run_events WHERE run_id = ?').run(runId), /append-only/);
});

section('audit: signed export and verification');

test('an export verifies, and binds the run to the reviewed code', async () => {
  const { u, runId } = await finishedRun();
  const r = await api(`/runs/${runId}/export`, { token: u.token });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.signature.alg, 'Ed25519');
  assert.strictEqual(r.body.payload.review.head_sha, 'b'.repeat(40));
  assert.strictEqual(r.body.payload.review.pr_number, 7);
  assert.ok(r.body.payload.manifest.entities.some((e: { kind: string }) => e.kind === 'agent'));
  assert.deepStrictEqual(verifyExport(r.body, keys()), { ok: true, errors: [], kid: auditKey().kid, mode: 'stepped' });
  const viaApi = await api('/audit/verify', { body: r.body });
  assert.strictEqual(viaApi.body.ok, true);
});

test('altering an output, an event, the manifest or the signature makes verification fail', async () => {
  const { u, runId } = await finishedRun();
  const doc = (await api(`/runs/${runId}/export`, { token: u.token })).body;

  const outputEdit = clone(doc); outputEdit.payload.steps[0].output.summary = 'tampered';
  const eventEdit = clone(doc); eventEdit.payload.events[3].payload.edge = 'other';
  const dropEvent = clone(doc); dropEvent.payload.events.splice(2, 1);
  const manifestEdit = clone(doc); manifestEdit.payload.manifest.entities[0].sha256 = '0'.repeat(64);
  const sigEdit = clone(doc); sigEdit.payload.run.outcome = 'something else';

  for (const [name, d] of Object.entries({ outputEdit, eventEdit, dropEvent, manifestEdit, sigEdit })) {
    const v = verifyExport(d, keys());
    assert.strictEqual(v.ok, false, `${name} must not verify`);
  }
  // Even re-signing a tampered payload with the right key cannot hide a broken chain.
  const v = verifyExport(eventEdit, keys());
  assert.ok(v.errors.some(e => /altered|link/.test(e)));
});

test('GET /audit/keys publishes the Ed25519 public key without authentication', async () => {
  const r = await api('/audit/keys');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.keys[0].kid, auditKey().kid);
  assert.ok(r.body.keys[0].public_key_pem.includes('BEGIN PUBLIC KEY'));
});

test('npm run audit:verify checks an export offline with the public key', async () => {
  const { u, runId } = await finishedRun();
  const doc = (await api(`/runs/${runId}/export`, { token: u.token })).body;
  const file = path.join(TEST_DIR, 'export.json');
  const keyFile = path.join(TEST_DIR, 'public.pem');
  fs.writeFileSync(file, JSON.stringify(doc));
  fs.writeFileSync(keyFile, auditKey().publicKeyPem);
  const script = path.join(__dirname, '..', '..', 'scripts', 'auditVerify.ts');
  const tsnode = path.join(process.cwd(), 'node_modules', '.bin', 'ts-node');
  // Offline means offline: no AIORC_DB_PATH, an empty working directory, and
  // no database file may be created.
  const offlineDir = fs.mkdtempSync(path.join(TEST_DIR, 'offline-'));
  const { AIORC_DB_PATH: _db, ...offlineEnv } = process.env;
  void _db;
  const ok = execFileSync(tsnode, ['--transpile-only', script, file, '--key', keyFile], { encoding: 'utf8', cwd: offlineDir, env: offlineEnv });
  assert.ok(ok.startsWith('VALID'), ok);
  assert.deepStrictEqual(fs.readdirSync(offlineDir), [], 'the verifier must not touch a database');

  doc.payload.steps[0].output.summary = 'tampered';
  fs.writeFileSync(file, JSON.stringify(doc));
  let failed = false;
  try { execFileSync(tsnode, ['--transpile-only', script, file, '--key', keyFile], { encoding: 'utf8' }); }
  catch (err) { failed = (err as { status: number }).status === 1; }
  assert.ok(failed, 'a tampered export must exit with status 1');
});

section('audit: external tools inside runs only (B2)');

test('an external tool call needs an active run and an agent allowed to use it', async () => {
  const u = await createUser();
  const p = await linearProject(u.token, 'worker', { allowed_tools: ['jira__create_issue'] });
  db.prepare('INSERT INTO mcp_servers (id, project_id, name, url, description, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), p.id, 'jira', 'http://localhost./mcp', '', Date.now());
  const call = (name: string, meta: Record<string, unknown>) => rpc('tools/call', { name, arguments: {}, _meta: meta }, { 'x-project-key': p.api_key });

  const noRun = await call('jira__create_issue', {});
  assert.strictEqual(noRun.body.error.code, -32001);
  const s = await mcp(p.api_key, 'workflow.start', { request: 'x' });
  const notAllowed = await call('jira__delete_everything', { runId: s.meta.runId });
  assert.strictEqual(notAllowed.body.error.code, -32001);
  const allowed = await call('jira__create_issue', { runId: s.meta.runId });
  assert.ok(/blocked/.test(allowed.body.error.message), 'reaches the outbound guard (and is blocked there: loopback)');
  const logged = db.prepare('SELECT run_id, node_id FROM mcp_tool_calls WHERE project_id = ?').get(p.id) as { run_id: string; node_id: string };
  assert.strictEqual(logged.run_id, s.meta.runId);
  assert.strictEqual(logged.node_id, 'n1');
  const ev = db.prepare("SELECT payload_json FROM run_events WHERE run_id = ? AND type = 'tool.called'").get(s.meta.runId) as { payload_json: string };
  assert.strictEqual(JSON.parse(ev.payload_json).tool, 'jira__create_issue');

  await mcp(p.api_key, 'workflow.next', { runId: s.meta.runId, step: 1, outputs: [{ node: 'n1', output: {} }] });
  const after = await call('jira__create_issue', { runId: s.meta.runId });
  assert.strictEqual(after.body.error.code, -32001, 'no tool calls once the run is over');
});
