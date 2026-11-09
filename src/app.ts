import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import path from 'path';

import './db/client';

import authRouter from './routes/auth';
import usersRouter from './routes/users';
import invitationsRouter from './routes/invitations';
import projectsRouter from './routes/projects';
import issuesRouter from './routes/issues';
import agentsRouter from './routes/agents';
import skillsRouter from './routes/skills';
import contextsRouter from './routes/contexts';
import flowsRouter from './routes/flows';
import runsRouter from './routes/runs';
import analyticsRouter from './routes/analytics';
import evalsRouter from './routes/evals';
import adminRouter from './routes/admin';
import mcpRouter from './mcp/server';
import auditRouter from './routes/audit';

// Builds the Express app without opening a port, so tests can mount it on an
// ephemeral port. src/index.ts is the process entry point that listens.
export function createApp(): express.Express {
  const app = express();

  // Behind Caddy (or any reverse proxy) req.ip must be the client, not the
  // proxy, or login throttling would lock everyone out together. By default
  // only proxies on loopback/private networks are trusted, so a client
  // talking to the app directly cannot spoof X-Forwarded-For.
  app.set('trust proxy', process.env.AIORC_TRUST_PROXY ?? 'loopback, linklocal, uniquelocal');
  app.disable('x-powered-by');

  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(path.join(process.cwd(), 'public')));

  app.use('/auth', authRouter);
  app.use('/users', usersRouter);
  app.use('/invitations', invitationsRouter);
  app.use('/projects', projectsRouter);
  app.use('/issues', issuesRouter);
  app.use('/projects/:id/flow', flowsRouter);
  app.use('/agents', agentsRouter);
  app.use('/skills', skillsRouter);
  app.use('/contexts', contextsRouter);
  app.use('/runs', runsRouter);
  app.use('/analytics', analyticsRouter);
  app.use('/evals', evalsRouter);
  app.use('/admin', adminRouter);
  app.use('/mcp', mcpRouter);
  app.use('/audit', auditRouter);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: '1.0.0', timestamp: Date.now() });
  });

  // Last-resort error handler: malformed JSON bodies become 400 (JSON-RPC
  // parse errors on /mcp), anything else a 500 without internals. The process
  // never dies because of one bad request.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const e = err as { type?: string; status?: number; message?: string };
    const isMcp = req.originalUrl.startsWith('/mcp');
    if (e?.type === 'entity.parse.failed') {
      res.status(400).json(isMcp ? { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } : { error: 'Malformed JSON body' });
      return;
    }
    if (e?.type === 'entity.too.large') {
      res.status(413).json(isMcp ? { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large' } } : { error: 'Request body too large' });
      return;
    }
    console.error('[AIOrc] Unhandled error on', req.method, req.originalUrl, err);
    if (res.headersSent) return;
    res.status(500).json(isMcp ? { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } } : { error: 'Internal server error' });
  });

  return app;
}

const app = createApp();
export default app;
