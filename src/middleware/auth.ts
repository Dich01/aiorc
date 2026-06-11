import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// Secret resolution: env var → .jwt-secret file (auto-created on first run) →
// never the old hardcoded dev string. The file makes the secret survive however
// the server gets started (npm run dev, online.sh, launchd...).
import fs from 'fs';
import path from 'path';

function resolveJwtSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(process.cwd(), '.jwt-secret');
  try {
    const secret = fs.readFileSync(file, 'utf8').trim();
    if (secret) return secret;
  } catch { /* no file yet */ }
  const generated = require('crypto').randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(file, generated + '\n', { mode: 0o600 });
    console.warn('[AIOrc] Generated a new JWT secret at .jwt-secret');
  } catch {
    console.warn('[AIOrc] Could not persist .jwt-secret — sessions will reset on restart.');
  }
  return generated;
}

export const JWT_SECRET = resolveJwtSecret();

export interface AuthRequest extends Request {
  userId?: string;
  userEmail?: string;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId: string; email: string };
    req.userId = payload.userId;
    req.userEmail = payload.email;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
