import { Router, Response } from 'express';
import db from '../db/client';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { Project, ProjectFlow, Agent, FlowNode, FlowEdge } from '../db/schema';
import { validateFlow } from '../orchestrator';

const router = Router({ mergeParams: true });

router.get('/', requireAuth, (req: AuthRequest, res: Response): void => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params['id']) as Project | undefined;
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }

  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId!) as { role: string } | undefined;
  if (user?.role !== 'admin' && project.user_id !== req.userId) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }

  const flow = db.prepare('SELECT * FROM project_flows WHERE project_id = ?').get(project.id) as ProjectFlow | undefined;
  const flowJson = flow?.flow_json || '{"nodes":[],"edges":[]}';

  res.json({ project_id: project.id, flow: JSON.parse(flowJson), updated_at: flow?.updated_at });
});

router.put('/', requireAuth, (req: AuthRequest, res: Response): void => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params['id']) as Project | undefined;
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }

  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId!) as { role: string } | undefined;
  if (user?.role !== 'admin' && project.user_id !== req.userId) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }

  const { nodes, edges } = req.body as { nodes?: unknown[]; edges?: unknown[] };

  const NODE_FIELDS = new Set(['id', 'type', 'agent_id', 'agent_name', 'max_invocations', 'outcome', 'label', 'x', 'y']);
  const EDGE_FIELDS = new Set(['id', 'from', 'to', 'condition', 'priority']);

  const cleanNodes = (nodes || []).map((n) => {
    const node = n as Record<string, unknown>;
    const clean: Record<string, unknown> = {};
    for (const k of NODE_FIELDS) if (k in node) clean[k] = node[k];
    // Default type to 'agent' for backwards compat
    if (!clean.type) clean.type = 'agent';
    return clean;
  });
  const cleanEdges = (edges || []).map((e) => {
    const edge = e as Record<string, unknown>;
    const clean: Record<string, unknown> = {};
    for (const k of EDGE_FIELDS) if (k in edge) clean[k] = edge[k];
    return clean;
  });

  if (cleanNodes.length > 0) {
    const projectAgents = db.prepare('SELECT * FROM agents WHERE user_id = ?').all(project.user_id) as Agent[];
    const agentsById = new Map(projectAgents.map(a => [a.id, a]));
    const validationErrors = validateFlow(
      cleanNodes as unknown as FlowNode[],
      cleanEdges as unknown as FlowEdge[],
      agentsById
    );
    if (validationErrors.length > 0) {
      res.status(400).json({
        error: 'Invalid flow',
        validation_errors: validationErrors,
      });
      return;
    }
  }

  const flowJson = JSON.stringify({ nodes: cleanNodes, edges: cleanEdges });
  const now = Date.now();

  const existing = db.prepare('SELECT 1 FROM project_flows WHERE project_id = ?').get(project.id);
  if (existing) {
    db.prepare('UPDATE project_flows SET flow_json = ?, updated_at = ? WHERE project_id = ?').run(flowJson, now, project.id);
  } else {
    db.prepare('INSERT INTO project_flows (project_id, flow_json, updated_at) VALUES (?, ?, ?)').run(project.id, flowJson, now);
  }

  res.json({
    project_id: project.id,
    flow: { nodes: cleanNodes, edges: cleanEdges },
    updated_at: now,
  });
});

export default router;
