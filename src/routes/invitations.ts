import { Router, Response } from 'express';
import db from '../db/client';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();

// Resolves invitee_user_id across all three invitation tables for the given email.
// Called from auth/login and auth/register so newly registered users (or users
// whose email was invited before they signed up) get linked correctly.
export function resolvePendingInvitations(email: string, userId: string): void {
  const update = (table: string) => db.prepare(`
    UPDATE ${table}
    SET invitee_user_id = ?
    WHERE LOWER(invitee_email) = LOWER(?) AND invitee_user_id IS NULL AND status = 'pending'
  `).run(userId, email);
  update('project_invitations');
  update('agent_invitations');
  update('skill_invitations');
  update('context_invitations');
}

// GET /invitations/incoming — all invitations received by the current user.
// Each row is tagged with `type: 'project' | 'agent' | 'skill'` and carries
// extra fields appropriate to its type (project_name, agent_name, skill_name).
router.get('/incoming', requireAuth, (req: AuthRequest, res: Response): void => {
  const me = db.prepare('SELECT email FROM users WHERE id = ?').get(req.userId!) as { email: string } | undefined;
  if (!me) { res.status(404).json({ error: 'User not found' }); return; }
  resolvePendingInvitations(me.email, req.userId!);

  const projectRows = db.prepare(`
    SELECT i.*, 'project' as type,
           p.name as target_name, p.description as target_description, p.is_public as target_is_public,
           u.nickname as inviter_nickname, u.email as inviter_email,
           fork.id as fork_target_id, fork.name as fork_target_name
    FROM project_invitations i
    JOIN projects p ON p.id = i.project_id
    JOIN users u ON u.id = i.inviter_user_id
    LEFT JOIN projects fork ON fork.user_id = i.invitee_user_id AND fork.forked_from = i.project_id
    WHERE i.invitee_user_id = ? OR LOWER(i.invitee_email) = LOWER(?)
  `).all(req.userId!, me.email) as { type: string; project_id?: string; agent_id?: string; skill_id?: string; created_at: number }[];

  const agentRows = db.prepare(`
    SELECT i.*, 'agent' as type,
           a.name as target_name, a.description as target_description, a.is_public as target_is_public,
           u.nickname as inviter_nickname, u.email as inviter_email,
           fork.id as fork_target_id, fork.name as fork_target_name
    FROM agent_invitations i
    JOIN agents a ON a.id = i.agent_id
    JOIN users u ON u.id = i.inviter_user_id
    LEFT JOIN agents fork ON fork.user_id = i.invitee_user_id AND fork.forked_from = i.agent_id
    WHERE i.invitee_user_id = ? OR LOWER(i.invitee_email) = LOWER(?)
  `).all(req.userId!, me.email) as { type: string; created_at: number }[];

  const skillRows = db.prepare(`
    SELECT i.*, 'skill' as type,
           s.name as target_name, s.description as target_description, s.is_public as target_is_public,
           u.nickname as inviter_nickname, u.email as inviter_email,
           fork.id as fork_target_id, fork.name as fork_target_name
    FROM skill_invitations i
    JOIN skills s ON s.id = i.skill_id
    JOIN users u ON u.id = i.inviter_user_id
    LEFT JOIN skills fork ON fork.user_id = i.invitee_user_id AND fork.forked_from = i.skill_id
    WHERE i.invitee_user_id = ? OR LOWER(i.invitee_email) = LOWER(?)
  `).all(req.userId!, me.email) as { type: string; created_at: number }[];

  const contextRows = db.prepare(`
    SELECT i.*, 'context' as type,
           c.name as target_name, c.description as target_description, c.is_public as target_is_public,
           u.nickname as inviter_nickname, u.email as inviter_email,
           fork.id as fork_target_id, fork.name as fork_target_name
    FROM context_invitations i
    JOIN contexts c ON c.id = i.context_id
    JOIN users u ON u.id = i.inviter_user_id
    LEFT JOIN contexts fork ON fork.user_id = i.invitee_user_id AND fork.forked_from = i.context_id
    WHERE i.invitee_user_id = ? OR LOWER(i.invitee_email) = LOWER(?)
  `).all(req.userId!, me.email) as { type: string; created_at: number }[];

  // Merge and sort by created_at desc.
  const all = [...projectRows, ...agentRows, ...skillRows, ...contextRows].sort((a, b) => b.created_at - a.created_at);
  res.json(all);
});

// Type-tagged accept/revoke.
function declineHandler(table: string) {
  return (req: AuthRequest, res: Response): void => {
    const me = db.prepare('SELECT email FROM users WHERE id = ?').get(req.userId!) as { email: string } | undefined;
    if (!me) { res.status(404).json({ error: 'User not found' }); return; }

    const inv = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params['id']) as
      | { id: string; invitee_user_id: string | null; invitee_email: string; status: string }
      | undefined;
    if (!inv) { res.status(404).json({ error: 'Invitation not found' }); return; }

    const isInvitee = inv.invitee_user_id === req.userId
      || inv.invitee_email.toLowerCase() === me.email.toLowerCase();
    if (!isInvitee) { res.status(403).json({ error: 'Forbidden' }); return; }
    if (inv.status !== 'pending') { res.status(400).json({ error: 'Invitation is not pending' }); return; }

    db.prepare(`UPDATE ${table} SET status = ?, responded_at = ?, invitee_user_id = COALESCE(invitee_user_id, ?) WHERE id = ?`).run(
      'declined', Date.now(), req.userId!, inv.id
    );
    res.json({ ...inv, status: 'declined', responded_at: Date.now() });
  };
}
function revokeHandler(table: string, ownerCol: string) {
  return (req: AuthRequest, res: Response): void => {
    const inv = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params['id']) as
      | { id: string; inviter_user_id: string; status: string; [k: string]: unknown }
      | undefined;
    if (!inv) { res.status(404).json({ error: 'Invitation not found' }); return; }
    void ownerCol;
    if (inv.inviter_user_id !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }
    if (inv.status !== 'pending') { res.status(400).json({ error: 'Invitation is not pending' }); return; }

    db.prepare(`UPDATE ${table} SET status = ?, responded_at = ? WHERE id = ?`).run('revoked', Date.now(), inv.id);
    res.status(204).end();
  };
}

// Project invitations
router.post('/projects/:id/decline', requireAuth, declineHandler('project_invitations'));
router.delete('/projects/:id', requireAuth, revokeHandler('project_invitations', 'project_id'));

// Agent invitations
router.post('/agents/:id/decline', requireAuth, declineHandler('agent_invitations'));
router.delete('/agents/:id', requireAuth, revokeHandler('agent_invitations', 'agent_id'));

// Skill invitations
router.post('/skills/:id/decline', requireAuth, declineHandler('skill_invitations'));
router.delete('/skills/:id', requireAuth, revokeHandler('skill_invitations', 'skill_id'));

// Context invitations
router.post('/contexts/:id/decline', requireAuth, declineHandler('context_invitations'));
router.delete('/contexts/:id', requireAuth, revokeHandler('context_invitations', 'context_id'));

// Backwards-compat: keep the legacy unprefixed endpoints (assumed project type)
// in case anything still hits them.
router.post('/:id/decline', requireAuth, declineHandler('project_invitations'));
router.delete('/:id', requireAuth, revokeHandler('project_invitations', 'project_id'));

export default router;
