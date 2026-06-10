// One-shot migration: convert legacy graph flows (with Decision/Gate/Loop/End
// control nodes) into the simplified agent-only model. Routes edges THROUGH
// control nodes, preserving conditions where possible.
//
// Run with: npx ts-node src/migrate-flows.ts

import db from './db/client';

interface LegacyNode {
  id: string;
  agent_id?: string;
  agent_name?: string;
  x: number;
  y: number;
  node_type?: string;
  label?: string;
  config?: Record<string, unknown>;
}

interface LegacyEdge {
  id: string;
  from: string;
  to: string;
  condition?: string;
  priority?: number;
  is_loop_back?: boolean;
}

interface NewNode {
  id: string;
  agent_id: string;
  agent_name?: string;
  x: number;
  y: number;
}

interface NewEdge {
  id: string;
  from: string;
  to: string;
  condition?: string;
  priority?: number;
}

function migrateFlow(legacy: { nodes: LegacyNode[]; edges: LegacyEdge[] }): {
  nodes: NewNode[];
  edges: NewEdge[];
  max_iterations: number;
} {
  const isAgent = (n: LegacyNode) => (n.node_type ?? 'agent') === 'agent' && !!n.agent_id;
  const agentNodes = legacy.nodes.filter(isAgent);
  const controlNodes = legacy.nodes.filter(n => !isAgent(n));
  const controlIds = new Set(controlNodes.map(n => n.id));

  const newNodes: NewNode[] = agentNodes.map(n => ({
    id: n.id,
    agent_id: n.agent_id!,
    agent_name: n.agent_name,
    x: n.x,
    y: n.y,
  }));

  // Adjacency for path-finding through control nodes
  const outgoing = new Map<string, LegacyEdge[]>();
  for (const n of legacy.nodes) outgoing.set(n.id, []);
  for (const e of legacy.edges) outgoing.get(e.from)?.push(e);

  const newEdges: NewEdge[] = [];
  const seen = new Set<string>();

  for (const startEdge of legacy.edges) {
    // We process every edge whose `from` is an agent.
    // If `to` is also an agent → keep edge as-is.
    // If `to` is a control node → walk forward, accumulating conditions, until we hit an agent.
    const fromNode = legacy.nodes.find(n => n.id === startEdge.from);
    if (!fromNode || !isAgent(fromNode)) continue;

    type Walk = { currentTo: string; carriedCondition?: string; visitedControls: Set<string> };
    const walks: Walk[] = [{
      currentTo: startEdge.to,
      carriedCondition: startEdge.condition && startEdge.condition.trim() ? startEdge.condition : undefined,
      visitedControls: new Set(),
    }];

    while (walks.length > 0) {
      const w = walks.shift()!;
      const toNode = legacy.nodes.find(n => n.id === w.currentTo);
      if (!toNode) continue;

      if (isAgent(toNode)) {
        // Found an agent destination — emit edge
        const key = `${startEdge.from}|${toNode.id}|${w.carriedCondition ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        newEdges.push({
          id: `e-${Math.random().toString(36).slice(2, 10)}`,
          from: startEdge.from,
          to: toNode.id,
          condition: w.carriedCondition,
          priority: startEdge.priority ?? 1000,
        });
        continue;
      }

      // toNode is a control node — walk through its outgoing edges
      if (w.visitedControls.has(toNode.id)) continue; // cycle through controls — abort path
      const visited = new Set(w.visitedControls);
      visited.add(toNode.id);

      for (const e of outgoing.get(toNode.id) ?? []) {
        // Combine conditions: prefer the most specific. If we already carry one,
        // skip the control node's own condition (rare in legacy data anyway).
        const combinedCondition = w.carriedCondition ?? e.condition;
        walks.push({
          currentTo: e.to,
          carriedCondition: combinedCondition && combinedCondition.trim() ? combinedCondition : undefined,
          visitedControls: visited,
        });
      }
    }
  }

  return {
    nodes: newNodes,
    edges: newEdges,
    max_iterations: 10,
  };
}

function main() {
  const flows = db.prepare('SELECT project_id, flow_json FROM project_flows').all() as { project_id: string; flow_json: string }[];

  console.log(`Migrating ${flows.length} flows…\n`);

  let migrated = 0;
  let unchanged = 0;
  let failed = 0;

  for (const f of flows) {
    try {
      const legacy = JSON.parse(f.flow_json) as { nodes: LegacyNode[]; edges: LegacyEdge[] };
      const hasControlNodes = (legacy.nodes ?? []).some(n => n.node_type && n.node_type !== 'agent');
      const hasOldEdgeFlags = (legacy.edges ?? []).some(e => e.is_loop_back);
      const lacksMaxIter = !('max_iterations' in legacy);

      if (!hasControlNodes && !hasOldEdgeFlags && !lacksMaxIter) {
        unchanged++;
        continue;
      }

      const newFlow = migrateFlow(legacy);
      db.prepare('UPDATE project_flows SET flow_json = ?, updated_at = ? WHERE project_id = ?')
        .run(JSON.stringify(newFlow), Date.now(), f.project_id);

      console.log(`✓ ${f.project_id}: ${legacy.nodes.length} → ${newFlow.nodes.length} nodes, ${(legacy.edges ?? []).length} → ${newFlow.edges.length} edges`);
      migrated++;
    } catch (err) {
      console.error(`✗ ${f.project_id}: ${(err as Error).message}`);
      failed++;
    }
  }

  console.log(`\nDone. Migrated: ${migrated}, unchanged: ${unchanged}, failed: ${failed}`);
}

main();
