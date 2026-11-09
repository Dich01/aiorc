import { Router, Response } from 'express';
import db from '../db/client';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { Project, ProjectFlow } from '../db/schema';
import { normalizeFlow, validateProjectFlow } from '../orchestrator';

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

  const { nodes, edges } = req.body as { nodes?: unknown; edges?: unknown };
  if ((nodes !== undefined && !Array.isArray(nodes)) || (edges !== undefined && !Array.isArray(edges))) {
    res.status(400).json({ error: 'nodes and edges must be arrays' }); return;
  }

  // Whitelist fields, then normalize. Unknown fields are dropped; the editor
  // must send `when` and `default` back unchanged for rule edges to survive.
  const NODE_FIELDS = new Set(['id', 'type', 'agent_id', 'agent_name', 'max_invocations', 'outcome', 'label', 'x', 'y']);
  const EDGE_FIELDS = new Set(['id', 'from', 'to', 'condition', 'when', 'default', 'priority']);
  const pick = (o: unknown, fields: Set<string>) => {
    const src = (o ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of fields) if (k in src) out[k] = src[k];
    return out;
  };
  const flow = normalizeFlow({
    nodes: ((nodes as unknown[]) ?? []).map(n => pick(n, NODE_FIELDS)),
    edges: ((edges as unknown[]) ?? []).map(e => pick(e, EDGE_FIELDS)),
  });

  // An empty canvas can be saved (a project starts that way); anything else
  // must pass the same validation workflow.start applies.
  if (flow.nodes.length > 0) {
    const validationErrors = validateProjectFlow(project.id, flow);
    if (validationErrors.length > 0) {
      res.status(400).json({ error: 'Invalid flow', validation_errors: validationErrors });
      return;
    }
  }

  const flowJson = JSON.stringify(flow);
  const now = Date.now();
  const existing = db.prepare('SELECT 1 FROM project_flows WHERE project_id = ?').get(project.id);
  if (existing) {
    db.prepare('UPDATE project_flows SET flow_json = ?, updated_at = ? WHERE project_id = ?').run(flowJson, now, project.id);
  } else {
    db.prepare('INSERT INTO project_flows (project_id, flow_json, updated_at) VALUES (?, ?, ?)').run(project.id, flowJson, now);
  }

  res.json({ project_id: project.id, flow, updated_at: now });
});

export default router;
