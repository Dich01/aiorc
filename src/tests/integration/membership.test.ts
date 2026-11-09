import assert from 'assert';
import { section, test } from '../harness';
import db from '../../db/client';
import { api, createUser, linearProject, mcp, rpc } from './helpers';

// Sharing a project: the id is stable and not secret; each person brings
// their own personal token, and the server checks they have access.

async function token(t: string): Promise<string> {
  return (await api('/users/me/tokens', { token: t, body: { name: 'test' } })).body.token;
}

section('project id + personal token (sharing)');

test('the owner runs a private project with its id and their own token, recorded under their name', async () => {
  const owner = await createUser();
  const p = await linearProject(owner.token);
  const pat = await token(owner.token);
  const r = await mcp('', 'workflow.start', { request: 'x' }, { 'x-project-key': '', 'x-project-id': p.id, Authorization: `Bearer ${pat}` });
  assert.ok(r.meta.runId, JSON.stringify(r));
  const run = db.prepare('SELECT caller_email FROM runs WHERE id = ?').get(r.meta.runId) as { caller_email: string };
  assert.strictEqual(run.caller_email, owner.email);
});

test('an invited user can run it; a stranger with a valid token gets 403', async () => {
  const owner = await createUser();
  const guest = await createUser();
  const stranger = await createUser();
  const p = await linearProject(owner.token);
  const inv = await api(`/projects/${p.id}/invitations`, { token: owner.token, body: { email: guest.email } });
  assert.strictEqual(inv.status, 201, JSON.stringify(inv.body));

  const asGuest = await rpc('tools/call', { name: 'workflow.start', arguments: { request: 'x' } }, { 'x-project-id': p.id, Authorization: `Bearer ${await token(guest.token)}` });
  assert.ok(asGuest.body.result?._meta?.runId, JSON.stringify(asGuest.body));

  const asStranger = await rpc('tools/list', {}, { 'x-project-id': p.id, Authorization: `Bearer ${await token(stranger.token)}` });
  assert.strictEqual(asStranger.status, 403);
});

test('a revoked invitation removes access', async () => {
  const owner = await createUser();
  const guest = await createUser();
  const p = await linearProject(owner.token);
  const inv = await api(`/projects/${p.id}/invitations`, { token: owner.token, body: { email: guest.email } });
  const pat = await token(guest.token);
  const del = await api(`/invitations/${inv.body.id}`, { method: 'DELETE', token: owner.token });
  assert.ok(del.status < 300, JSON.stringify(del.body));
  const r = await rpc('tools/list', {}, { 'x-project-id': p.id, Authorization: `Bearer ${pat}` });
  assert.strictEqual(r.status, 403);
});

test('the project id alone cannot run anything, and the project key keeps working for CI', async () => {
  const owner = await createUser();
  const p = await linearProject(owner.token);
  const alone = await rpc('tools/list', {}, { 'x-project-id': p.id });
  assert.strictEqual(alone.status, 401);
  const viaKey = await mcp(p.api_key, 'workflow.start', { request: 'x' });
  assert.ok(viaKey.meta.runId);
});

test('runner endpoints accept the id and a member token too', async () => {
  const owner = await createUser();
  const p = await linearProject(owner.token);
  const pat = await token(owner.token);
  const r = await api(`/api/runs?head_sha=${'a'.repeat(40)}`, { headers: { 'x-project-id': p.id, Authorization: `Bearer ${pat}` } });
  assert.strictEqual(r.status, 200);
});

test('a public project can be run by anyone with a valid token; a private one cannot', async () => {
  const owner = await createUser();
  const stranger = await createUser();
  const p = await linearProject(owner.token);
  const pat = await token(stranger.token);
  const before = await rpc('tools/call', { name: 'workflow.start', arguments: { request: 'x' } }, { 'x-project-id': p.id, Authorization: `Bearer ${pat}` });
  assert.strictEqual(before.status, 403, 'private: no access');
  await api(`/projects/${p.id}/visibility`, { method: 'PATCH', token: owner.token, body: { is_public: true } });
  const after = await rpc('tools/call', { name: 'workflow.start', arguments: { request: 'x' } }, { 'x-project-id': p.id, Authorization: `Bearer ${pat}` });
  const runId = after.body.result?._meta?.runId;
  assert.ok(runId, JSON.stringify(after.body));
  const run = db.prepare('SELECT caller_email FROM runs WHERE id = ?').get(runId) as { caller_email: string };
  assert.strictEqual(run.caller_email, stranger.email, 'recorded under who ran it');
});

test('each connection introduces its project by name and purpose', async () => {
  const owner = await createUser();
  const p = await linearProject(owner.token);
  await api(`/projects/${p.id}`, { method: 'PATCH', token: owner.token, body: { description: 'Review pull requests before merging.' } });
  const init = await rpc('initialize', {}, { 'x-project-key': p.api_key });
  assert.ok(init.body.result.instructions.includes('Review pull requests before merging.'));
  const list = await rpc('tools/list', {}, { 'x-project-key': p.api_key });
  const start = list.body.result.tools.find((t: { name: string }) => t.name === 'workflow.start');
  assert.ok(start.description.includes('Use this project for: Review pull requests before merging.'));
});
