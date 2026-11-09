import express from 'express';
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

// Builds the Express app without opening a port, so tests can mount it on an
// ephemeral port. src/index.ts is the process entry point that listens.
export function createApp(): express.Express {
  const app = express();

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

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: '1.0.0', timestamp: Date.now() });
  });

  return app;
}

const app = createApp();
export default app;
