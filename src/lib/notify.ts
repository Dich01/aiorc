import { v4 as uuidv4 } from 'uuid';
import db from '../db/client';

// In-app notifications. An unread notification of the same kind for the same
// user and project is updated in place (newest line first, newest time), so a
// busy project produces one entry, not fifty.

export type NotificationKind =
  | 'upstream_changed'   // the project your fork came from changed
  | 'shared_changed'     // a project shared with you changed
  | 'invitation'         // you were invited to a project, agent, skill or context
  | 'forked'             // someone forked something of yours
  | 'run_problem'        // a run of your project ended capped, failed or cancelled
  | 'issue';             // someone opened an issue on something of yours

export interface NotifyInput {
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  link?: string;
  projectId?: string;
  entityKind?: string;
  entityId?: string;
  coalesce?: boolean;   // merge into an unread one of the same kind and project
}

const MAX_BODY = 2000;

export function notify(n: NotifyInput): void {
  if (!n.userId) return;
  const exists = db.prepare('SELECT 1 FROM users WHERE id = ?').get(n.userId);
  if (!exists) return;
  const now = Date.now();
  const body = (n.body ?? '').slice(0, MAX_BODY);
  if (n.coalesce && n.projectId) {
    const prev = db.prepare(
      'SELECT id, body FROM notifications WHERE user_id = ? AND kind = ? AND project_id = ? AND read_at IS NULL ORDER BY created_at DESC LIMIT 1'
    ).get(n.userId, n.kind, n.projectId) as { id: string; body: string } | undefined;
    if (prev) {
      const merged = prev.body.split('\n').includes(body) ? prev.body : [body, prev.body].filter(Boolean).join('\n').slice(0, MAX_BODY);
      db.prepare('UPDATE notifications SET title = ?, body = ?, link = ?, created_at = ? WHERE id = ?')
        .run(n.title, merged, n.link ?? '', now, prev.id);
      return;
    }
  }
  db.prepare(
    `INSERT INTO notifications (id, user_id, kind, title, body, link, project_id, entity_kind, entity_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(uuidv4(), n.userId, n.kind, n.title, body, n.link ?? '', n.projectId ?? '', n.entityKind ?? '', n.entityId ?? '', now);
}

// The people a project is shared with: pending or accepted invitations,
// resolved to user ids by id or email. The owner is not included.
export function projectMembers(projectId: string): string[] {
  const rows = db.prepare(
    `SELECT DISTINCT u.id FROM project_invitations i
     JOIN users u ON u.id = i.invitee_user_id OR LOWER(u.email) = LOWER(i.invitee_email)
     WHERE i.project_id = ? AND i.status IN ('pending', 'accepted')`
  ).all(projectId) as { id: string }[];
  const owner = (db.prepare('SELECT user_id FROM projects WHERE id = ?').get(projectId) as { user_id: string } | undefined)?.user_id;
  return rows.map(r => r.id).filter(id => id !== owner);
}

export function displayName(userId: string): string {
  const u = db.prepare('SELECT nickname, email FROM users WHERE id = ?').get(userId) as { nickname: string; email: string } | undefined;
  return u ? (u.nickname ? '@' + u.nickname : u.email) : 'someone';
}

// A run that ended badly: the project owner and whoever started it hear about
// it, except the person who caused it (who already knows).
export function notifyRunProblem(runId: string, what: string, actorId = ''): void {
  const r = db.prepare('SELECT r.project_id, r.caller_user_id, p.user_id AS owner_id, p.name FROM runs r JOIN projects p ON p.id = r.project_id WHERE r.id = ?')
    .get(runId) as { project_id: string; caller_user_id: string; owner_id: string; name: string } | undefined;
  if (!r) return;
  for (const userId of new Set([r.owner_id, r.caller_user_id].filter(Boolean))) {
    if (userId === actorId) continue;
    notify({ userId, kind: 'run_problem', projectId: r.project_id, title: `A run of "${r.name}" ${what}`, link: `audit.html#${runId}` });
  }
}
