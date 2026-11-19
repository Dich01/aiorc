// Privacy and sharing between users, end to end through the HTTP API.
//
// A small project, not the reference harness: a newsletter flow
//   Start -> drafter -> editor -> End
// drafter carries the skill "tone-guide" and the private context "brand-voice";
// the project carries the private context "audience-notes"; "style-sheet" is a
// public context on editor. Three people: the owner, an invited teammate and a
// stranger. Each test builds its own copy, so they do not depend on each other.
//
// Rules checked:
// - public means listed: anyone sees the card, the content is read by forking;
// - the owner, an admin and live invitations (pending or accepted) read content;
//   a declined or revoked invitation gives nothing;
// - version history follows content access, not visibility;
// - forking an agent takes only the contexts the forker may take;
// - forking a project takes only the contexts the owner shares;
// - a context used by a flow, directly or through an agent, cannot be deleted;
// - shared work keeps working for the other people: run, fork, update.
import assert from 'assert';
import { section, test } from '../harness';
import { api, createProject, createUser, mcp, putFlow, rpc } from './helpers';

type User = Awaited<ReturnType<typeof createUser>>;

async function make(token: string, path: string, body: Record<string, unknown>): Promise<string> {
  const r = await api(path, { token, body });
  assert.strictEqual(r.status, 201, `${path}: ${JSON.stringify(r.body)}`);
  return r.body.id;
}
const doc = (name: string, content: string) => [{ name, content, is_entry: true }];

async function newsletter(owner: User) {
  const p = await createProject(owner.token, `newsletter-${Math.random().toString(36).slice(2, 7)}`);
  const tone = await make(owner.token, '/skills', { name: 'tone-guide', description: 'How we write', files: doc('SKILL.md', 'TONE-SECRET: short sentences, no jargon.') });
  const brand = await make(owner.token, '/contexts', { name: 'brand-voice', description: 'Our voice', files: doc('CONTEXT.md', 'BRAND-SECRET: we never mention prices.') });
  const style = await make(owner.token, '/contexts', { name: 'style-sheet', description: 'Public style rules', files: doc('CONTEXT.md', 'STYLE-PUBLIC: use sentence case.') });
  const audience = await make(owner.token, '/contexts', {
    name: 'audience-notes', description: 'Who reads it', files: doc('CONTEXT.md', 'AUDIENCE-SECRET: 40% are teachers.'),
    project_attachments: [{ project_id: p.id, share_on_fork: false }],
  });
  const drafter = await make(owner.token, '/agents', { name: 'drafter', description: 'Writes the draft', content: 'DRAFTER-SECRET: write 3 paragraphs.', project_ids: [p.id], skill_ids: [tone], context_ids: [brand] });
  const editor = await make(owner.token, '/agents', { name: 'editor', description: 'Edits the draft', content: 'EDITOR-SECRET: cut 20%.', project_ids: [p.id], context_ids: [style] });
  const f = await putFlow(owner.token, p.id, {
    nodes: [
      { id: 's', type: 'start', x: 0, y: 0 },
      { id: 'd', type: 'agent', agent_id: drafter, agent_name: 'drafter', x: 0, y: 0 },
      { id: 'ed', type: 'agent', agent_id: editor, agent_name: 'editor', x: 0, y: 0 },
      { id: 'e', type: 'end', outcome: 'sent', x: 0, y: 0 },
    ],
    edges: [{ id: '1', from: 's', to: 'd' }, { id: '2', from: 'd', to: 'ed' }, { id: '3', from: 'ed', to: 'e' }],
  });
  assert.strictEqual(f.status, 200, JSON.stringify(f.body));
  await api(`/contexts/${style}/visibility`, { method: 'PATCH', token: owner.token, body: { is_public: true } });
  return { p, tone, brand, style, audience, drafter, editor };
}

async function publish(token: string, kind: 'agents' | 'skills' | 'contexts' | 'projects', id: string): Promise<void> {
  const r = await api(`/${kind}/${id}/visibility`, { method: 'PATCH', token, body: { is_public: true } });
  assert.ok(r.status < 300, `publish ${kind}: ${r.status} ${JSON.stringify(r.body)}`);
}
async function invite(token: string, kind: 'agents' | 'skills' | 'contexts' | 'projects', id: string, email: string): Promise<string> {
  const r = await api(`/${kind}/${id}/invitations`, { token, body: { email } });
  assert.strictEqual(r.status, 201, `invite ${kind}: ${JSON.stringify(r.body)}`);
  return r.body.id;
}
async function pat(token: string): Promise<string> {
  return (await api('/users/me/tokens', { token, body: { name: 'test' } })).body.token;
}
const asPerson = async (u: User) => ({ Authorization: `Bearer ${await pat(u.token)}` });

section('privacy: public is listed, content is read by forking');

test('a stranger sees the card of a public agent, skill or context but not its content', async () => {
  const owner = await createUser(); const stranger = await createUser();
  const n = await newsletter(owner);
  await publish(owner.token, 'agents', n.drafter);
  await publish(owner.token, 'skills', n.tone);
  await publish(owner.token, 'contexts', n.brand);
  for (const [kind, id, secret] of [['agents', n.drafter, 'DRAFTER-SECRET'], ['skills', n.tone, 'TONE-SECRET'], ['contexts', n.brand, 'BRAND-SECRET']] as const) {
    const r = await api(`/${kind}/${id}`, { token: stranger.token });
    assert.strictEqual(r.status, 200, kind);
    assert.strictEqual(r.body.content_hidden, true, kind);
    assert.ok(r.body.name && r.body.description, `${kind} keeps its card`);
    assert.ok(!JSON.stringify(r.body).includes(secret), `${kind} content does not leak`);
    const own = await api(`/${kind}/${id}`, { token: owner.token });
    assert.ok(JSON.stringify(own.body).includes(secret), `the owner still reads ${kind}`);
  }
});

test('a private agent, skill or context is refused to a stranger', async () => {
  const owner = await createUser(); const stranger = await createUser();
  const n = await newsletter(owner);
  for (const [kind, id] of [['agents', n.drafter], ['skills', n.tone], ['contexts', n.brand]] as const) {
    assert.strictEqual((await api(`/${kind}/${id}`, { token: stranger.token })).status, 403, kind);
  }
});

test('the public repository list never carries content', async () => {
  const owner = await createUser();
  const n = await newsletter(owner);
  await publish(owner.token, 'agents', n.drafter);
  await publish(owner.token, 'skills', n.tone);
  await publish(owner.token, 'contexts', n.brand);
  for (const kind of ['agents', 'skills', 'contexts']) {
    const r = await api(`/${kind}/public`);
    assert.strictEqual(r.status, 200);
    assert.ok(!/DRAFTER-SECRET|TONE-SECRET|BRAND-SECRET/.test(JSON.stringify(r.body)), kind);
  }
});

section('privacy: invitations');

test('an invitation gives content while pending or accepted, and nothing once declined', async () => {
  const owner = await createUser(); const guest = await createUser();
  const n = await newsletter(owner);
  const inv = await invite(owner.token, 'contexts', n.brand, guest.email);
  const pending = await api(`/contexts/${n.brand}`, { token: guest.token });
  assert.ok(JSON.stringify(pending.body).includes('BRAND-SECRET'), 'pending invitation reads the content');
  const decline = await api(`/invitations/contexts/${inv}/decline`, { method: 'POST', token: guest.token });
  assert.strictEqual(decline.status, 200, JSON.stringify(decline.body));
  assert.strictEqual((await api(`/contexts/${n.brand}`, { token: guest.token })).status, 403, 'declined: no access');
  assert.strictEqual((await api(`/versions/context/${n.brand}`, { token: guest.token })).status, 403, 'declined: no history');
});

test('a revoked invitation removes access to an agent and a skill', async () => {
  const owner = await createUser(); const guest = await createUser();
  const n = await newsletter(owner);
  const ia = await invite(owner.token, 'agents', n.drafter, guest.email);
  const is = await invite(owner.token, 'skills', n.tone, guest.email);
  assert.ok(JSON.stringify((await api(`/agents/${n.drafter}`, { token: guest.token })).body).includes('DRAFTER-SECRET'));
  assert.ok(JSON.stringify((await api(`/skills/${n.tone}`, { token: guest.token })).body).includes('TONE-SECRET'));
  assert.strictEqual((await api(`/invitations/agents/${ia}`, { method: 'DELETE', token: owner.token })).status, 204);
  assert.strictEqual((await api(`/invitations/skills/${is}`, { method: 'DELETE', token: owner.token })).status, 204);
  assert.strictEqual((await api(`/agents/${n.drafter}`, { token: guest.token })).status, 403);
  assert.strictEqual((await api(`/skills/${n.tone}`, { token: guest.token })).status, 403);
});

section('privacy: version history');

test('a public project does not open the history of its private pieces to strangers', async () => {
  const owner = await createUser(); const stranger = await createUser();
  const n = await newsletter(owner);
  await publish(owner.token, 'projects', n.p.id);
  await publish(owner.token, 'agents', n.drafter);
  for (const [kind, id] of [['project', n.p.id], ['agent', n.drafter], ['skill', n.tone], ['context', n.brand], ['context', n.audience]] as const) {
    const list = await api(`/versions/${kind}/${id}`, { token: stranger.token });
    assert.strictEqual(list.status, 403, `${kind} history list`);
    assert.strictEqual((await api(`/versions/${kind}/${id}/1`, { token: stranger.token })).status, 403, `${kind} version content`);
  }
});

test('a member of the project reads the history of its pieces; the owner too', async () => {
  const owner = await createUser(); const member = await createUser();
  const n = await newsletter(owner);
  await invite(owner.token, 'projects', n.p.id, member.email);
  for (const [kind, id] of [['project', n.p.id], ['agent', n.drafter], ['context', n.brand], ['context', n.audience]] as const) {
    assert.strictEqual((await api(`/versions/${kind}/${id}`, { token: member.token })).status, 200, `member: ${kind}`);
    assert.strictEqual((await api(`/versions/${kind}/${id}`, { token: owner.token })).status, 200, `owner: ${kind}`);
  }
  const v = await api(`/versions/context/${n.brand}/1`, { token: member.token });
  assert.ok(JSON.stringify(v.body).includes('BRAND-SECRET'), 'the member gets the version content');
});

section('privacy: forks');

test('forking a public agent takes its public contexts and leaves the private ones', async () => {
  const owner = await createUser(); const stranger = await createUser();
  const n = await newsletter(owner);
  // editor carries the public style-sheet; give it the private brand-voice too.
  const upd = await api(`/agents/${n.editor}`, { method: 'PUT', token: owner.token, body: { context_ids: [n.style, n.brand] } });
  assert.strictEqual(upd.status, 200, JSON.stringify(upd.body));
  await publish(owner.token, 'agents', n.editor);
  const fork = await api(`/agents/${n.editor}/fork`, { method: 'POST', token: stranger.token });
  assert.strictEqual(fork.status, 201, JSON.stringify(fork.body));
  assert.strictEqual(fork.body.contexts_withheld, 1);
  assert.deepStrictEqual(fork.body.contexts.map((c: { name: string }) => c.name), ['style-sheet']);
  assert.ok(fork.body.content.includes('EDITOR-SECRET'), 'the fork has the instructions');
  const mine = await api('/contexts', { token: stranger.token });
  const text = JSON.stringify(mine.body);
  assert.ok(text.includes('STYLE-PUBLIC') && !text.includes('BRAND-SECRET'), 'only the public context was copied');
});

test('forking an agent takes a private context when the forker is invited to it', async () => {
  const owner = await createUser(); const guest = await createUser();
  const n = await newsletter(owner);
  await publish(owner.token, 'agents', n.drafter);
  await invite(owner.token, 'contexts', n.brand, guest.email);
  const fork = await api(`/agents/${n.drafter}/fork`, { method: 'POST', token: guest.token });
  assert.strictEqual(fork.status, 201, JSON.stringify(fork.body));
  assert.strictEqual(fork.body.contexts_withheld, 0);
  assert.deepStrictEqual(fork.body.contexts.map((c: { name: string }) => c.name), ['brand-voice']);
});

test('forking a public skill or context gives the forker the full content in their copy', async () => {
  const owner = await createUser(); const stranger = await createUser();
  const n = await newsletter(owner);
  await publish(owner.token, 'skills', n.tone);
  const s = await api(`/skills/${n.tone}/fork`, { method: 'POST', token: stranger.token });
  assert.strictEqual(s.status, 201, JSON.stringify(s.body));
  assert.ok(JSON.stringify((await api(`/skills/${s.body.id}`, { token: stranger.token })).body).includes('TONE-SECRET'));
  const c = await api(`/contexts/${n.style}/fork`, { method: 'POST', token: stranger.token });
  assert.strictEqual(c.status, 201, JSON.stringify(c.body));
  assert.ok(JSON.stringify((await api(`/contexts/${c.body.id}`, { token: stranger.token })).body).includes('STYLE-PUBLIC'));
});

test('forking a project copies only the contexts the owner shares', async () => {
  const owner = await createUser(); const stranger = await createUser();
  const n = await newsletter(owner);
  await publish(owner.token, 'projects', n.p.id);
  const share = await api(`/projects/${n.p.id}/contexts-sharing`, { method: 'PUT', token: owner.token, body: { shared_context_ids: [n.style] } });
  assert.strictEqual(share.status, 200, JSON.stringify(share.body));
  const fork = await api(`/projects/${n.p.id}/fork`, { method: 'POST', token: stranger.token, body: {} });
  assert.strictEqual(fork.status, 201, JSON.stringify(fork.body));
  const text = JSON.stringify((await api('/contexts', { token: stranger.token })).body);
  assert.ok(text.includes('STYLE-PUBLIC'), 'the shared context came along');
  assert.ok(!text.includes('BRAND-SECRET') && !text.includes('AUDIENCE-SECRET'), 'the private ones stayed');
  const agents = JSON.stringify((await api('/agents', { token: stranger.token })).body);
  assert.ok(agents.includes('DRAFTER-SECRET') && agents.includes('TONE-SECRET') === false, 'agents are copied; skills live in their own list');
  const skills = JSON.stringify((await api('/skills', { token: stranger.token })).body);
  assert.ok(skills.includes('TONE-SECRET'), 'the skill the flow needs is copied');
});

section('privacy: deleting what a flow uses');

test('a context attached only to an agent in a flow cannot be deleted; after detaching it can', async () => {
  const owner = await createUser();
  const n = await newsletter(owner);
  const del = await api(`/contexts/${n.brand}`, { method: 'DELETE', token: owner.token });
  assert.strictEqual(del.status, 409, JSON.stringify(del.body));
  assert.ok(del.body.projects.some((p: { project_id: string }) => p.project_id === n.p.id));
  await api(`/agents/${n.drafter}`, { method: 'PUT', token: owner.token, body: { context_ids: [] } });
  assert.strictEqual((await api(`/contexts/${n.brand}`, { method: 'DELETE', token: owner.token })).status, 204);
});

section('sharing still works for the other people');

test('an invited teammate runs the private project end to end and gets every piece the flow needs', async () => {
  const owner = await createUser(); const member = await createUser(); const stranger = await createUser();
  const n = await newsletter(owner);
  await invite(owner.token, 'projects', n.p.id, member.email);
  const h = { 'x-project-id': n.p.id, ...(await asPerson(member)) };
  const start = await mcp('', 'workflow.start', { request: 'November issue' }, { 'x-project-key': '', ...h });
  assert.ok(start.meta.runId, JSON.stringify(start));
  assert.ok(start.text.includes('DRAFTER-SECRET') && start.text.includes('TONE-SECRET') && start.text.includes('BRAND-SECRET') && start.text.includes('AUDIENCE-SECRET'));
  const step2 = await mcp('', 'workflow.next', { runId: start.meta.runId, step: 1, outputs: [{ node: 'd', output: { draft: 'x' } }] }, { 'x-project-key': '', ...h });
  assert.ok(step2.text.includes('EDITOR-SECRET') && step2.text.includes('STYLE-PUBLIC'), step2.text.slice(0, 300));
  const done = await mcp('', 'workflow.next', { runId: start.meta.runId, step: 2, outputs: [{ node: 'ed', output: { final: 'y' } }] }, { 'x-project-key': '', ...h });
  assert.strictEqual(done.meta.status, 'completed', JSON.stringify(done.meta));
  const refused = await rpc('tools/list', {}, { 'x-project-id': n.p.id, ...(await asPerson(stranger)) });
  assert.strictEqual(refused.status, 403, 'a stranger cannot run the private project');
});

test('the owner edits a piece, the fork is told, and updating brings the change without private contexts', async () => {
  const owner = await createUser(); const forker = await createUser();
  const n = await newsletter(owner);
  await publish(owner.token, 'projects', n.p.id);
  const fork = await api(`/projects/${n.p.id}/fork`, { method: 'POST', token: forker.token, body: {} });
  assert.strictEqual(fork.status, 201, JSON.stringify(fork.body));
  const edit = await api(`/agents/${n.drafter}`, { method: 'PUT', token: owner.token, body: { content: 'DRAFTER-SECRET v2: write 4 paragraphs.' } });
  assert.strictEqual(edit.status, 200, JSON.stringify(edit.body));
  const up = await api(`/projects/${fork.body.id}/upstream`, { token: forker.token });
  assert.ok(up.body.changes.some((c: { kind: string; name: string }) => c.kind === 'agent' && c.name === 'drafter'), JSON.stringify(up.body));
  const notes = await api('/notifications', { token: forker.token });
  assert.ok(JSON.stringify(notes.body).includes('upstream_changed'), 'the fork owner is notified');
  const sync = await api(`/projects/${fork.body.id}/upstream/sync`, { method: 'POST', token: forker.token });
  assert.strictEqual(sync.status, 200, JSON.stringify(sync.body));
  const agents = JSON.stringify((await api('/agents', { token: forker.token })).body);
  assert.ok(agents.includes('4 paragraphs'), 'the change arrived');
  const ctx = JSON.stringify((await api('/contexts', { token: forker.token })).body);
  assert.ok(!ctx.includes('BRAND-SECRET') && !ctx.includes('AUDIENCE-SECRET'), 'updating did not bring the private contexts');
  // The fork runs on its own key.
  const run = await mcp(fork.body.api_key, 'workflow.start', { request: 'December issue' });
  assert.ok(run.meta.runId && run.text.includes('4 paragraphs'), run.text.slice(0, 200));
});

test('an invited teammate can fork the private project and run their copy', async () => {
  const owner = await createUser(); const member = await createUser();
  const n = await newsletter(owner);
  await invite(owner.token, 'projects', n.p.id, member.email);
  const fork = await api(`/projects/${n.p.id}/fork`, { method: 'POST', token: member.token, body: {} });
  assert.strictEqual(fork.status, 201, JSON.stringify(fork.body));
  const run = await mcp(fork.body.api_key, 'workflow.start', { request: 'x' });
  assert.ok(run.meta.runId, JSON.stringify(run));
});
