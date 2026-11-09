import { Request, Response, NextFunction } from 'express';
import db from '../db/client';
import { Project } from '../db/schema';
import { sha256Hex, USER_TOKEN_PREFIX } from '../lib/secrets';

export interface VerifiedCaller {
  userId: string;
  email: string;
}

export interface ProjectKeyRequest extends Request {
  project?: Project;
  // 'key': the project key was presented — may start and drive runs.
  // 'public': only x-project-id of a public project — read-only (tools/list, workflow.eval).
  projectAuth?: 'key' | 'public';
  caller?: VerifiedCaller | null;   // from a personal access token, verified
  declaredCaller?: string;          // from x-user-email, NOT verified
}

// Resolve `Authorization: Bearer aiorc_pat_...` to a user. Returns undefined
// when no Authorization header was sent, null when it was sent but is invalid.
export function resolvePersonalToken(header: string | undefined): VerifiedCaller | null | undefined {
  if (!header) return undefined;
  const m = header.match(/^Bearer\s+(\S+)$/i);
  if (!m || !m[1]!.startsWith(USER_TOKEN_PREFIX)) return null;
  const row = db.prepare(
    `SELECT t.id, u.id AS user_id, u.email FROM user_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ? AND t.revoked_at IS NULL`
  ).get(sha256Hex(m[1]!)) as { id: string; user_id: string; email: string } | undefined;
  if (!row) return null;
  db.prepare('UPDATE user_tokens SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id);
  return { userId: row.user_id, email: row.email };
}

export function requireProjectKey(req: ProjectKeyRequest, res: Response, next: NextFunction): void {
  const apiKey = req.headers['x-project-key'];
  const projectId = req.headers['x-project-id'];

  const caller = resolvePersonalToken(req.headers.authorization);
  if (caller === null) {
    res.status(401).json({ error: 'Invalid personal access token in the Authorization header' });
    return;
  }
  req.caller = caller ?? null;
  req.declaredCaller = String(req.headers['x-user-email'] ?? '').trim().slice(0, 254);

  if (typeof apiKey === 'string' && apiKey) {
    const project = db.prepare('SELECT * FROM projects WHERE api_key_hash = ?').get(sha256Hex(apiKey)) as Project | undefined;
    if (!project) {
      res.status(401).json({ error: 'Invalid project API key' });
      return;
    }
    req.project = project;
    req.projectAuth = 'key';
    next();
    return;
  }

  if (typeof projectId === 'string' && projectId) {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
    if (!project || !project.is_public) {
      res.status(401).json({ error: 'Unknown or private project: the x-project-key header is required' });
      return;
    }
    req.project = project;
    req.projectAuth = 'public';
    next();
    return;
  }

  res.status(401).json({ error: 'Missing x-project-key header' });
}
