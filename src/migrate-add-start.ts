// Migration: ensure every flow has a Start node connected to its entry agent.
//
// For flows without a Start:
//   - Find the entry agent (no incoming edges among agent->agent edges)
//   - Add a Start node to its left
//   - Connect Start → entry agent
//
// Flows already containing a Start are left alone.
// Run with: ./node_modules/.bin/ts-node src/migrate-add-start.ts

import db from './db/client';

interface Node {
  id: string;
  type?: string;
  agent_id?: string;
  agent_name?: string;
  max_invocations?: number;
  outcome?: string;
  x: number;
  y: number;
}
interface Edge {
  id: string;
  from: string;
  to: string;
  condition?: string;
  priority?: number;
}

function migrateFlow(flow: { nodes: Node[]; edges: Edge[] }): {
  nodes: Node[];
  edges: Edge[];
  changed: boolean;
} {
  const nodes = (flow.nodes ?? []).map(n => ({
    ...n,
    type: n.type ?? 'agent', // default legacy nodes to 'agent'
  }));
  const edges = flow.edges ?? [];

  const hasStart = nodes.some(n => n.type === 'start');
  if (hasStart) return { nodes, edges, changed: false };

  if (nodes.length === 0) return { nodes, edges, changed: false };

  // Find entry agent: agent node with no incoming edges
  const incoming = new Set<string>();
  for (const e of edges) incoming.add(e.to);
  const agentNodes = nodes.filter(n => n.type === 'agent');
  const entries = agentNodes.filter(n => !incoming.has(n.id));

  if (entries.length === 0) {
    // Cannot determine entry — pick first agent
    if (agentNodes.length === 0) return { nodes, edges, changed: false };
    entries.push(agentNodes[0]);
  }

  const entry = entries[0]; // pick first if multiple
  const minX = Math.min(...nodes.map(n => n.x));
  const minY = Math.min(...nodes.map(n => n.y));

  const startNode: Node = {
    id: `start-${Math.random().toString(36).slice(2, 10)}`,
    type: 'start',
    x: Math.max(0, entry.x - 60),
    y: Math.max(0, entry.y - 80),
  };

  const startEdge: Edge = {
    id: `e-${Math.random().toString(36).slice(2, 10)}`,
    from: startNode.id,
    to: entry.id,
  };

  // Default max_invocations on existing agent nodes
  const newNodes = [startNode, ...nodes.map(n => {
    if (n.type === 'agent' && (n.max_invocations === undefined || n.max_invocations === null)) {
      return { ...n, max_invocations: 10 };
    }
    return n;
  })];

  return {
    nodes: newNodes,
    edges: [startEdge, ...edges],
    changed: true,
  };
}

function main() {
  const flows = db.prepare('SELECT project_id, flow_json FROM project_flows').all() as { project_id: string; flow_json: string }[];

  console.log(`Checking ${flows.length} flows…\n`);

  let migrated = 0;
  let unchanged = 0;
  let failed = 0;

  for (const f of flows) {
    try {
      const flow = JSON.parse(f.flow_json) as { nodes: Node[]; edges: Edge[] };
      const result = migrateFlow(flow);
      if (!result.changed) {
        unchanged++;
        continue;
      }
      db.prepare('UPDATE project_flows SET flow_json = ?, updated_at = ? WHERE project_id = ?')
        .run(JSON.stringify({ nodes: result.nodes, edges: result.edges }), Date.now(), f.project_id);
      console.log(`✓ ${f.project_id}: added Start node + edge to entry agent`);
      migrated++;
    } catch (err) {
      console.error(`✗ ${f.project_id}: ${(err as Error).message}`);
      failed++;
    }
  }

  console.log(`\nDone. Migrated: ${migrated}, unchanged: ${unchanged}, failed: ${failed}`);
}

main();
