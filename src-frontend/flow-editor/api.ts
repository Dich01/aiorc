import type { BackendNode, BackendEdge, AgentSummary, SkillSummary, ContextSummary } from './types';

export interface FlowData {
  nodes: BackendNode[];
  edges: BackendEdge[];
}

function getAuth(): { projectId: string; token: string } {
  const root = document.getElementById('flow-root');
  return {
    projectId: root?.dataset.projectId ?? '',
    token: root?.dataset.token ?? '',
  };
}

function headers(token: string): HeadersInit {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

export async function fetchFlow(): Promise<FlowData> {
  const { projectId, token } = getAuth();
  const res = await fetch(`/projects/${projectId}/flow`, { headers: headers(token) });
  if (!res.ok) throw new Error(`Failed to load flow: ${res.status}`);
  const data = await res.json();
  return data.flow ?? { nodes: [], edges: [] };
}

export async function saveFlow(
  nodes: BackendNode[],
  edges: BackendEdge[]
): Promise<{ validation_errors?: string[] }> {
  const { projectId, token } = getAuth();
  const res = await fetch(`/projects/${projectId}/flow`, {
    method: 'PUT',
    headers: headers(token),
    body: JSON.stringify({ nodes, edges }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { validation_errors: body.validation_errors ?? [`HTTP ${res.status}: ${res.statusText}`] };
  }
  return {};
}

export async function fetchProjectAgents(): Promise<AgentSummary[]> {
  const { projectId, token } = getAuth();
  const res = await fetch(`/agents?project_id=${encodeURIComponent(projectId)}`, { headers: headers(token) });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function fetchProjectSkills(): Promise<SkillSummary[]> {
  const { projectId, token } = getAuth();
  const res = await fetch(`/skills?project_id=${encodeURIComponent(projectId)}`, { headers: headers(token) });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// Every context the project's agents can carry (owned by the project's owner).
export async function fetchAvailableContexts(): Promise<ContextSummary[]> {
  const { projectId, token } = getAuth();
  const res = await fetch(`/contexts?for_project=${encodeURIComponent(projectId)}`, { headers: headers(token) });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data.map((c: ContextSummary) => ({ id: c.id, name: c.name, description: c.description })) : [];
}

// Add or remove one skill or context on an agent: read its current list and
// write it back (the API replaces the whole list).
async function updateAgentLinks(agentId: string, kind: 'skills' | 'contexts', change: (ids: string[]) => string[]): Promise<void> {
  const { token } = getAuth();
  const agentRes = await fetch(`/agents/${agentId}`, { headers: headers(token) });
  if (!agentRes.ok) throw new Error('Failed to load agent');
  const agent = await agentRes.json();
  const current: string[] = (agent[kind] ?? []).map((x: { id: string }) => x.id);
  const next = change(current);
  if (next.length === current.length && next.every((id, i) => id === current[i])) return;
  const putRes = await fetch(`/agents/${agentId}`, {
    method: 'PUT',
    headers: headers(token),
    body: JSON.stringify(kind === 'skills' ? { skill_ids: next } : { context_ids: next }),
  });
  if (!putRes.ok) throw new Error(`Failed to update the agent's ${kind}`);
}

export const attachSkillToAgent = (agentId: string, skillId: string) =>
  updateAgentLinks(agentId, 'skills', ids => (ids.includes(skillId) ? ids : [...ids, skillId]));
export const detachSkillFromAgent = (agentId: string, skillId: string) =>
  updateAgentLinks(agentId, 'skills', ids => ids.filter(id => id !== skillId));
export const attachContextToAgent = (agentId: string, contextId: string) =>
  updateAgentLinks(agentId, 'contexts', ids => (ids.includes(contextId) ? ids : [...ids, contextId]));
export const detachContextFromAgent = (agentId: string, contextId: string) =>
  updateAgentLinks(agentId, 'contexts', ids => ids.filter(id => id !== contextId));
