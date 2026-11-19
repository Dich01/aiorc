import db from '../db/client';

// Who may read the full content (instructions, files) of an agent, skill or
// context. Public only means "listed in the repository": its description is
// visible, but the content is read by forking it. An invitation counts while it
// is pending or accepted; a declined or revoked one gives no access.

export type ContentKind = 'agent' | 'skill' | 'context';

const TABLE: Record<ContentKind, string> = { agent: 'agents', skill: 'skills', context: 'contexts' };
const INVITES: Record<ContentKind, [string, string]> = {
  agent: ['agent_invitations', 'agent_id'],
  skill: ['skill_invitations', 'skill_id'],
  context: ['context_invitations', 'context_id'],
};

export function isAdminUser(userId: string): boolean {
  return (db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: string } | undefined)?.role === 'admin';
}

// A pending or accepted invitation to this entity (by user id or email).
export function hasLiveInvitation(kind: ContentKind | 'project', id: string, userId: string): boolean {
  const [table, col] = kind === 'project' ? ['project_invitations', 'project_id'] : INVITES[kind];
  const me = db.prepare('SELECT email FROM users WHERE id = ?').get(userId) as { email: string } | undefined;
  if (!me) return false;
  return !!db.prepare(
    `SELECT 1 FROM ${table} WHERE ${col} = ? AND status IN ('pending', 'accepted')
     AND (invitee_user_id = ? OR LOWER(invitee_email) = LOWER(?))`
  ).get(id, userId, me.email);
}

// Full content: owner, admin, or a live invitation to it.
export function canReadContent(kind: ContentKind, id: string, userId: string): boolean {
  const row = db.prepare(`SELECT user_id FROM ${TABLE[kind]} WHERE id = ?`).get(id) as { user_id: string } | undefined;
  if (!row) return false;
  return row.user_id === userId || isAdminUser(userId) || hasLiveInvitation(kind, id, userId);
}

// What a reader without content access sees of a public entity: everything but
// the content and its files.
export function withoutContent<T extends Record<string, unknown>>(entity: T): Omit<T, 'content' | 'files'> & { content_hidden: true } {
  const { content: _c, files: _f, ...rest } = entity;
  void _c; void _f;
  return { ...rest, content_hidden: true };
}
