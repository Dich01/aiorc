import type { Node, Edge } from '@xyflow/react';
import type { AnyNodeData, EdgeData } from './types';

// Mirrors backend validateFlow: only structural sanity.

export function validateFlowClient(
  nodes: Node<AnyNodeData>[],
  edges: Edge<EdgeData>[]
): string[] {
  const errors: string[] = [];

  if (nodes.length === 0) return [];

  const nodeIds = new Set(nodes.map(n => n.id));
  const startNodes = nodes.filter(n => n.data.nodeType === 'start');
  const endNodes = nodes.filter(n => n.data.nodeType === 'end');
  const agentNodes = nodes.filter(n => n.data.nodeType === 'agent');
  const parallelNodes = nodes.filter(n => n.data.nodeType === 'parallel');

  if (startNodes.length === 0) {
    errors.push('The flow has no Start node. Add one from the toolbar.');
  } else if (startNodes.length > 1) {
    errors.push(`The flow has ${startNodes.length} Start nodes. Only one is allowed.`);
  }

  for (const start of startNodes) {
    const incoming = edges.filter(e => e.target === start.id);
    const outgoing = edges.filter(e => e.source === start.id);
    if (incoming.length > 0) errors.push('The Start node cannot have incoming edges.');
    if (outgoing.length === 0) errors.push('The Start node must connect to the first agent.');
    if (outgoing.length > 1) errors.push(`The Start node has ${outgoing.length} outgoing edges. Only one is allowed.`);
  }

  for (const end of endNodes) {
    const outgoing = edges.filter(e => e.source === end.id);
    if (outgoing.length > 0) {
      const out = (end.data as { outcome?: string }).outcome;
      const label = out ? `End "${out}"` : `End ${end.id}`;
      errors.push(`The ${label} node cannot have outgoing edges.`);
    }
  }

  for (const node of agentNodes) {
    const ad = node.data as { agentId: string };
    if (!ad.agentId) errors.push(`Agent node ${node.id} has no agent assigned.`);
  }

  for (const par of parallelNodes) {
    const incoming = edges.filter(e => e.target === par.id);
    const outgoing = edges.filter(e => e.source === par.id);
    const lab = (par.data as { label?: string }).label;
    const label = lab ? `Parallel "${lab}"` : `Parallel ${par.id}`;
    if (incoming.length === 0) errors.push(`The ${label} node has no incoming edges.`);
    if (outgoing.length < 2) {
      errors.push(`The ${label} node has ${outgoing.length} outgoing edge(s). A Parallel node needs at least 2 (it is a fork).`);
    }
  }

  for (const edge of edges) {
    if (!nodeIds.has(edge.source)) errors.push(`Edge ${edge.id}: source node does not exist.`);
    if (!nodeIds.has(edge.target)) errors.push(`Edge ${edge.id}: target node does not exist.`);
  }

  return errors;
}
