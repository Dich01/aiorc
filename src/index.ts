import express from 'express';
import cors from 'cors';
import path from 'path';

import './db/client';
import { backfillUsageFromRuns } from './lib/usage';

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

import { seed } from './seed';

const app = express();
const PORT = Number(process.env.PORT) || 3001;

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

(async () => {
  try {
    await seed();
    backfillUsageFromRuns();
    app.listen(PORT, () => {
      console.log(`[AIOrc] Server running at http://localhost:${PORT}`);
      console.log(`[AIOrc] MCP endpoint: http://localhost:${PORT}/mcp`);
    });
  } catch (err) {
    console.error('[AIOrc] Startup error:', err);
    process.exit(1);
  }
})();

export default app;
