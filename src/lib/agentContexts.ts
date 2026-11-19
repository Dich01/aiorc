import { v4 as uuidv4 } from 'uuid';
import db from '../db/client';
import { copyEntityFiles, CONTEXT_FILES } from './entityFiles';
import { hasLiveInvitation, isAdminUser } from './access';

// Contexts of an agent that `userId` may take with a fork of that agent: their
// own, public ones, and ones they hold a live invitation to. The owner's private
// contexts stay with the owner.
export function contextCopyAllowed(contextId: string, userId: string): boolean {
  const c = db.prepare('SELECT user_id, is_public FROM contexts WHERE id = ?').get(contextId) as { user_id: string; is_public: number } | undefined;
  if (!c) return false;
  return c.user_id === userId || !!c.is_public || isAdminUser(userId) || hasLiveInvitation('context', contextId, userId);
}

// Copy the contexts attached to `fromAgent` onto `toAgent`, owned by `ownerId`.
// Only contexts the new owner may take are copied (see contextCopyAllowed);
// returns how many were left out.
export function copyAgentContexts(fromAgent: string, toAgent: string, ownerId: string, now: number, copies = new Map<string, string>()): number {
  const rows = db.prepare(
    `SELECT c.*, ac.ordinal AS _ord FROM agent_contexts ac JOIN contexts c ON c.id = ac.context_id
     WHERE ac.agent_id = ? ORDER BY ac.ordinal ASC`
  ).all(fromAgent) as { id: string; name: string; description: string; tags: string; content: string; _ord: number }[];
  const taken = new Set((db.prepare('SELECT name FROM contexts WHERE user_id = ?').all(ownerId) as { name: string }[]).map(r => r.name));
  let withheld = 0;
  for (const c of rows) {
    if (!contextCopyAllowed(c.id, ownerId)) { withheld++; continue; }
    let copyId = copies.get(c.id);
    if (!copyId) {
      copyId = uuidv4();
      let name = c.name;
      for (let n = 1; taken.has(name); n++) name = n === 1 ? `${c.name} (fork)` : `${c.name} (fork ${n})`;
      taken.add(name);
      db.prepare('INSERT INTO contexts (id, user_id, name, description, tags, content, is_public, forked_from, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)')
        .run(copyId, ownerId, name, c.description, c.tags ?? '', c.content, c.id, now);
      copyEntityFiles(c.id, copyId, CONTEXT_FILES);
      copies.set(c.id, copyId);
    }
    db.prepare('INSERT OR IGNORE INTO agent_contexts (agent_id, context_id, ordinal) VALUES (?, ?, ?)').run(toAgent, copyId, c._ord);
  }
  return withheld;
}
