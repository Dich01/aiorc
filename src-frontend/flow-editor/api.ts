import type { BackendNode, BackendEdge, AgentSummary, SkillSummary } from './types';

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

export async function attachSkillToAgent(agentId: string, skillId: string): Promise<void> {
  const { token } = getAuth();
  const agentRes = await fetch(`/agents/${agentId}`, { headers: headers(token) });
  if (!agentRes.ok) throw new Error('Failed to load agent');
  const agent = await agentRes.json();
  const existingIds: string[] = (agent.skills ?? []).map((s: { id: string }) => s.id);
  if (existingIds.includes(skillId)) return;
  const newIds = [...existingIds, skillId];
  const putRes = await fetch(`/agents/${agentId}`, {
    method: 'PUT',
    headers: headers(token),
    body: JSON.stringify({ skill_ids: newIds }),
  });
  if (!putRes.ok) throw new Error('Failed to attach skill');
}

export async function detachSkillFromAgent(agentId: string, skillId: string): Promise<void> {
  const { token } = getAuth();
  const agentRes = await fetch(`/agents/${agentId}`, { headers: headers(token) });
  if (!agentRes.ok) throw new Error('Failed to load agent');
  const agent = await agentRes.json();
  const existingIds: string[] = (agent.skills ?? []).map((s: { id: string }) => s.id);
  const newIds = existingIds.filter((id) => id !== skillId);
  const putRes = await fetch(`/agents/${agentId}`, {
    method: 'PUT',
    headers: headers(token),
    body: JSON.stringify({ skill_ids: newIds }),
  });
  if (!putRes.ok) throw new Error('Failed to detach skill');
}
