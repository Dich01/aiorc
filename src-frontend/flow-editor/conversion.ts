import type { Node, Edge } from '@xyflow/react';
import type { BackendNode, BackendEdge, AnyNodeData, EdgeData, FlowNodeType } from './types';

export function toReactFlow(
  backendNodes: BackendNode[],
  backendEdges: BackendEdge[]
): { nodes: Node<AnyNodeData>[]; edges: Edge<EdgeData>[] } {
  const nodes: Node<AnyNodeData>[] = backendNodes.map((bn) => {
    const type: FlowNodeType = bn.type ?? 'agent';
    let data: AnyNodeData;
    if (type === 'start') {
      data = { nodeType: 'start' };
    } else if (type === 'end') {
      data = { nodeType: 'end', outcome: bn.outcome };
    } else if (type === 'parallel') {
      data = { nodeType: 'parallel', label: bn.label };
    } else {
      data = {
        nodeType: 'agent',
        agentId: bn.agent_id ?? '',
        agentName: bn.agent_name ?? '',
        maxInvocations: bn.max_invocations ?? 10,
      };
    }
    return {
      id: bn.id,
      type,
      position: { x: bn.x, y: bn.y },
      data,
    };
  });

  const edges: Edge<EdgeData>[] = backendEdges.map((be) => ({
    id: be.id,
    source: be.from,
    target: be.to,
    type: 'conditional',
    data: {
      condition: be.condition,
      when: be.when,
      isDefault: be.default,
      priority: be.priority,
    },
  }));

  return { nodes, edges };
}

export function toBackend(
  rfNodes: Node<AnyNodeData>[],
  rfEdges: Edge<EdgeData>[]
): { nodes: BackendNode[]; edges: BackendEdge[] } {
  const nodes: BackendNode[] = rfNodes.map((rn) => {
    const d = rn.data;
    const bn: BackendNode = {
      id: rn.id,
      type: d.nodeType,
      x: rn.position.x,
      y: rn.position.y,
    };
    if (d.nodeType === 'agent') {
      bn.agent_id = d.agentId;
      bn.agent_name = d.agentName;
      bn.max_invocations = d.maxInvocations;
    } else if (d.nodeType === 'end') {
      bn.outcome = d.outcome;
    } else if (d.nodeType === 'parallel') {
      bn.label = d.label;
    }
    return bn;
  });

  // `when` and `default` are not editable in the canvas yet, but they must
  // round-trip unchanged or saving a flow would silently drop its rules.
  const edges: BackendEdge[] = rfEdges.map((re) => {
    const be: BackendEdge = { id: re.id, from: re.source, to: re.target };
    if (re.data?.condition) be.condition = re.data.condition;
    if (re.data?.when) be.when = re.data.when;
    if (re.data?.isDefault) be.default = true;
    if (typeof re.data?.priority === 'number') be.priority = re.data.priority;
    return be;
  });

  return { nodes, edges };
}
