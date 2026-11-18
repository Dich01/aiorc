import { v4 as uuidv4 } from 'uuid';
import db from '../db/client';
import { copyEntityFiles, CONTEXT_FILES } from './entityFiles';

// Deep-copy the contexts attached to `fromAgent` into `ownerId`'s workspace and
// attach the copies to `toAgent`. `copies` reuses one copy per source context
// when several agents of the same fork share it. Used by agent and project forks.
export function copyAgentContexts(fromAgent: string, toAgent: string, ownerId: string, now: number, copies = new Map<string, string>()): void {
  const rows = db.prepare(
    `SELECT c.*, ac.ordinal AS _ord FROM agent_contexts ac JOIN contexts c ON c.id = ac.context_id
     WHERE ac.agent_id = ? ORDER BY ac.ordinal ASC`
  ).all(fromAgent) as { id: string; name: string; description: string; tags: string; content: string; _ord: number }[];
  const taken = new Set((db.prepare('SELECT name FROM contexts WHERE user_id = ?').all(ownerId) as { name: string }[]).map(r => r.name));
  for (const c of rows) {
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
}
