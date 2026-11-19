import { Router, Response } from 'express';
import db from '../db/client';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { ENTITY_KINDS, EntityKind, canEdit, canViewHistory, entityOwner, getVersion, listVersions, restoreVersion } from '../lib/versions';
import { displayName } from '../lib/notify';

// Version history of agents, skills, contexts and projects.
//   GET  /versions/:kind/:id                     list (newest first)
//   GET  /versions/:kind/:id/:version            one version with its content
//   POST /versions/:kind/:id/:version/restore    owner or admin
const router = Router();

function kindOf(raw: string | undefined): EntityKind | null {
  return ENTITY_KINDS.includes(raw as EntityKind) ? (raw as EntityKind) : null;
}

router.get('/:kind/:id', requireAuth, (req: AuthRequest, res: Response): void => {
  const kind = kindOf(String(req.params['kind']));
  const id = String(req.params['id']);
  if (!kind) { res.status(400).json({ error: 'kind must be project, agent, skill or context' }); return; }
  const owner = entityOwner(kind, id);
  if (!owner) { res.status(404).json({ error: 'Not found' }); return; }
  if (!canViewHistory(kind, id, req.userId!)) { res.status(403).json({ error: 'Forbidden' }); return; }
  const versions = listVersions(kind, id);
  res.json({
    kind, id, name: owner.name, owner: displayName(owner.user_id),
    current: versions[0]?.version ?? 0, can_restore: canEdit(kind, id, req.userId!),
    versions: versions.map(v => ({ version: v.version, author: v.author, note: v.note, created_at: v.created_at, sha256: v.sha256 })),
  });
});

router.get('/:kind/:id/:version', requireAuth, (req: AuthRequest, res: Response): void => {
  const kind = kindOf(String(req.params['kind']));
  const id = String(req.params['id']);
  if (!kind) { res.status(400).json({ error: 'kind must be project, agent, skill or context' }); return; }
  if (!entityOwner(kind, id)) { res.status(404).json({ error: 'Not found' }); return; }
  if (!canViewHistory(kind, id, req.userId!)) { res.status(403).json({ error: 'Forbidden' }); return; }
  const v = getVersion(kind, id, Number(req.params['version']));
  if (!v) { res.status(404).json({ error: 'No such version' }); return; }
  // Names of the skills and contexts the version points at, for display.
  const c = v.content as { skill_ids?: string[]; context_ids?: string[]; contexts?: { context_id: string }[]; shared_agent_contexts?: string[] };
  const names: Record<string, string> = {};
  for (const sid of c.skill_ids ?? []) names[sid] = (db.prepare('SELECT name FROM skills WHERE id = ?').get(sid) as { name: string } | undefined)?.name ?? '(deleted skill)';
  for (const cid of [...(c.context_ids ?? []), ...(c.contexts ?? []).map(x => x.context_id), ...(c.shared_agent_contexts ?? [])]) {
    names[cid] = (db.prepare('SELECT name FROM contexts WHERE id = ?').get(cid) as { name: string } | undefined)?.name ?? '(deleted context)';
  }
  res.json({ ...v, author: v.author_user_id ? displayName(v.author_user_id) : '', names });
});

router.post('/:kind/:id/:version/restore', requireAuth, (req: AuthRequest, res: Response): void => {
  const kind = kindOf(String(req.params['kind']));
  const id = String(req.params['id']);
  if (!kind) { res.status(400).json({ error: 'kind must be project, agent, skill or context' }); return; }
  if (!entityOwner(kind, id)) { res.status(404).json({ error: 'Not found' }); return; }
  if (!canEdit(kind, id, req.userId!)) { res.status(403).json({ error: 'Only the owner or an admin can restore a version' }); return; }
  const target = Number(req.params['version']);
  if (!getVersion(kind, id, target)) { res.status(404).json({ error: 'No such version' }); return; }
  const version = restoreVersion(kind, id, target, req.userId!);
  res.json({ ok: true, version });
});

export default router;
