// Mirror of backend schema — keep in sync with src/db/schema.ts

export type FlowNodeType = 'start' | 'agent' | 'parallel' | 'end';

export interface BackendNode {
  id: string;
  type: FlowNodeType;
  agent_id?: string;
  agent_name?: string;
  max_invocations?: number;
  outcome?: string;
  label?: string;
  x: number;
  y: number;
}

export interface BackendEdge {
  id: string;
  from: string;
  to: string;
  condition?: string;
  priority?: number;
}

export interface BackendFlow {
  nodes: BackendNode[];
  edges: BackendEdge[];
}

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  skills?: SkillSummary[];
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
}

// Data stored in React Flow node.data
export interface AgentNodeData extends Record<string, unknown> {
  nodeType: 'agent';
  agentId: string;
  agentName: string;
  maxInvocations: number;
  skills?: SkillSummary[];
  onDropSkill?: (agentId: string, skillId: string) => void;
  onRemoveSkill?: (agentId: string, skillId: string) => void;
  onShowContent?: (agentId: string, agentName: string) => void;
  onDeleteNode?: (nodeId: string) => void;
  onEditMaxInvocations?: (nodeId: string) => void;
}

export interface StartNodeData extends Record<string, unknown> {
  nodeType: 'start';
  onDeleteNode?: (nodeId: string) => void;
}

export interface EndNodeData extends Record<string, unknown> {
  nodeType: 'end';
  outcome?: string;
  onDeleteNode?: (nodeId: string) => void;
  onEditOutcome?: (nodeId: string) => void;
}

export interface ParallelNodeData extends Record<string, unknown> {
  nodeType: 'parallel';
  label?: string;
  onDeleteNode?: (nodeId: string) => void;
  onEditLabel?: (nodeId: string) => void;
}

export type AnyNodeData = AgentNodeData | StartNodeData | EndNodeData | ParallelNodeData;

export interface EdgeData extends Record<string, unknown> {
  condition?: string;
  priority?: number;
  onEditCondition?: (edgeId: string) => void;
}
