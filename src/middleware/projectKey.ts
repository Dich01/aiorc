import { Request, Response, NextFunction } from 'express';
import db from '../db/client';
import { Project } from '../db/schema';

export interface ProjectKeyRequest extends Request {
  project?: Project;
}

export function requireProjectKey(req: ProjectKeyRequest, res: Response, next: NextFunction): void {
  const apiKey = req.headers['x-project-key'] as string | undefined;
  const projectId = req.headers['x-project-id'] as string | undefined;

  if (apiKey) {
    const project = db.prepare('SELECT * FROM projects WHERE api_key = ?').get(apiKey) as Project | undefined;
    if (!project) {
      res.status(401).json({ error: 'Invalid project API key' });
      return;
    }
    req.project = project;
    next();
    return;
  }

  if (projectId) {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
    if (!project) {
      res.status(401).json({ error: 'Unknown project' });
      return;
    }
    if (!project.is_public) {
      res.status(401).json({ error: 'This project is private — x-project-key header required' });
      return;
    }
    req.project = project;
    next();
    return;
  }

  res.status(401).json({ error: 'Missing x-project-key or x-project-id header' });
}
