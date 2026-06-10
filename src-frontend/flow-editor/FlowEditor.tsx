import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  Background,
  Controls,
  MiniMap,
  type Connection,
  type Node,
  type Edge,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import AgentNode from './nodes/AgentNode';
import StartNode from './nodes/StartNode';
import EndNode from './nodes/EndNode';
import ParallelNode from './nodes/ParallelNode';
import ConditionalEdge from './edges/ConditionalEdge';
import PalettePanel from './panels/PalettePanel';
import SkillsPanel from './panels/SkillsPanel';
import Toolbar from './panels/Toolbar';
import EdgeConditionPopover from './popover/EdgeConditionPopover';
import NodeConfigModal, { type NodeConfigMode } from './popover/NodeConfigModal';
import ValidationModal from './popover/ValidationModal';

import {
  fetchFlow, saveFlow, fetchProjectAgents, fetchProjectSkills,
  attachSkillToAgent, detachSkillFromAgent
} from './api';
import { toReactFlow, toBackend } from './conversion';
import { validateFlowClient } from './validation';
import type {
  AgentSummary, SkillSummary, AnyNodeData, AgentNodeData, EndNodeData, ParallelNodeData, EdgeData
} from './types';

const nodeTypes = {
  agent: AgentNode,
  start: StartNode,
  end: EndNode,
  parallel: ParallelNode,
};
const edgeTypes = { conditional: ConditionalEdge };

function genNodeId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}
function genEdgeId() {
  return 'e-' + Math.random().toString(36).slice(2, 10);
}

function FlowEditorInner() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<AnyNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge<EdgeData>>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [saving, setSaving] = useState(false);
  const [paletteVisible, setPaletteVisible] = useState(true);
  const [skillsVisible, setSkillsVisible] = useState(true);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [edgePopover, setEdgePopover] = useState<{ edgeId: string; condition: string } | null>(null);
  const [nodeConfig, setNodeConfig] = useState<{ nodeId: string; mode: NodeConfigMode; initial: string | number } | null>(null);
  const rfInstance = useRef<ReactFlowInstance<Node<AnyNodeData>, Edge<EdgeData>> | null>(null);
  const { screenToFlowPosition } = useReactFlow();

  const handleShowAgentContent = useCallback((agentId: string, agentName: string) => {
    const w = window as Window & { showAgentContent?: (id: string, name: string) => void };
    if (typeof w.showAgentContent === 'function') w.showAgentContent(agentId, agentName);
  }, []);

  const handleShowSkillContent = useCallback((skillId: string, skillName: string) => {
    const w = window as Window & { showSkillContent?: (id: string, name: string) => void };
    if (typeof w.showSkillContent === 'function') w.showSkillContent(skillId, skillName);
  }, []);

  const handleDeleteNode = useCallback((nodeId: string) => {
    setNodes((prev) => prev.filter((n) => n.id !== nodeId));
    setEdges((prev) => prev.filter((e) => e.source !== nodeId && e.target !== nodeId));
  }, [setNodes, setEdges]);

  const handleEditMaxInvocations = useCallback((nodeId: string) => {
    setNodes((prev) => {
      const n = prev.find(x => x.id === nodeId);
      if (n) {
        const cur = (n.data as AgentNodeData).maxInvocations ?? 10;
        setNodeConfig({ nodeId, mode: 'agent_max_inv', initial: cur });
      }
      return prev;
    });
  }, [setNodes]);

  const handleEditEndOutcome = useCallback((nodeId: string) => {
    setNodes((prev) => {
      const n = prev.find(x => x.id === nodeId);
      if (n) {
        const cur = (n.data as EndNodeData).outcome ?? '';
        setNodeConfig({ nodeId, mode: 'end_outcome', initial: cur });
      }
      return prev;
    });
  }, [setNodes]);

  const handleEditParallelLabel = useCallback((nodeId: string) => {
    setNodes((prev) => {
      const n = prev.find(x => x.id === nodeId);
      if (n) {
        const cur = (n.data as ParallelNodeData).label ?? '';
        setNodeConfig({ nodeId, mode: 'parallel_label', initial: cur });
      }
      return prev;
    });
  }, [setNodes]);

  const handleDropSkillOnAgent = useCallback(async (agentId: string, skillId: string) => {
    await attachSkillToAgent(agentId, skillId);
    const newAgents = await fetchProjectAgents();
    setAgents(newAgents);
  }, []);

  const handleRemoveSkillFromAgent = useCallback(async (agentId: string, skillId: string) => {
    await detachSkillFromAgent(agentId, skillId);
    const newAgents = await fetchProjectAgents();
    setAgents(newAgents);
  }, []);

  const handleEditEdge = useCallback((edgeId: string) => {
    setEdges((prev) => {
      const e = prev.find((x) => x.id === edgeId);
      if (e) setEdgePopover({ edgeId, condition: e.data?.condition ?? '' });
      return prev;
    });
  }, [setEdges]);

  // Re-inject callbacks whenever underlying data changes
  useEffect(() => {
    setNodes((prev) =>
      prev.map((n) => {
        const d = n.data;
        if (d.nodeType === 'agent') {
          const agent = agents.find((a) => a.id === d.agentId);
          const resolvedSkills: SkillSummary[] = (agent?.skills ?? []).map((s) => ({
            id: s.id, name: s.name, description: s.description,
          }));
          return {
            ...n,
            data: {
              ...d,
              agentName: agent?.name || d.agentName,
              skills: resolvedSkills,
              onDropSkill: handleDropSkillOnAgent,
              onRemoveSkill: handleRemoveSkillFromAgent,
              onShowContent: handleShowAgentContent,
              onDeleteNode: handleDeleteNode,
              onEditMaxInvocations: handleEditMaxInvocations,
            } as AgentNodeData,
          };
        }
        if (d.nodeType === 'start') {
          return { ...n, data: { ...d, onDeleteNode: handleDeleteNode } };
        }
        if (d.nodeType === 'end') {
          return {
            ...n,
            data: { ...d, onDeleteNode: handleDeleteNode, onEditOutcome: handleEditEndOutcome } as EndNodeData,
          };
        }
        if (d.nodeType === 'parallel') {
          return {
            ...n,
            data: { ...d, onDeleteNode: handleDeleteNode, onEditLabel: handleEditParallelLabel } as ParallelNodeData,
          };
        }
        return n;
      })
    );
  }, [agents, setNodes, handleDropSkillOnAgent, handleRemoveSkillFromAgent, handleShowAgentContent, handleDeleteNode, handleEditMaxInvocations, handleEditEndOutcome, handleEditParallelLabel]);

  useEffect(() => {
    setEdges((prev) =>
      prev.map((e) => ({
        ...e,
        type: 'conditional',
        data: { ...e.data, onEditCondition: handleEditEdge },
      }))
    );
  }, [setEdges, handleEditEdge]);

  // Initial load
  useEffect(() => {
    Promise.all([fetchFlow(), fetchProjectAgents(), fetchProjectSkills()]).then(
      ([flow, agentList, skillList]) => {
        setAgents(agentList);
        setSkills(skillList);
        const { nodes: rfNodes, edges: rfEdges } = toReactFlow(flow.nodes, flow.edges);
        setNodes(rfNodes);
        setEdges(rfEdges);
      }
    ).catch((err) => console.error('Failed to load flow:', err));
  }, []);

  const onConnect = useCallback(
    (connection: Connection) => {
      const newEdge: Edge<EdgeData> = {
        id: genEdgeId(),
        source: connection.source,
        target: connection.target,
        type: 'conditional',
        data: { onEditCondition: handleEditEdge },
      };
      setEdges((eds) => addEdge(newEdge, eds));
    },
    [setEdges, handleEditEdge]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const agentId = e.dataTransfer.getData('agent-id');
      if (!agentId) return;
      const fullAgent = agents.find((a) => a.id === agentId);
      if (!fullAgent) return;
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const skillsForAgent: SkillSummary[] = (fullAgent.skills ?? []).map((s) => ({
        id: s.id, name: s.name, description: s.description,
      }));
      const newNode: Node<AnyNodeData> = {
        id: genNodeId('agent'),
        type: 'agent',
        position,
        data: {
          nodeType: 'agent',
          agentId,
          agentName: fullAgent.name,
          maxInvocations: 10,
          skills: skillsForAgent,
          onDropSkill: handleDropSkillOnAgent,
          onRemoveSkill: handleRemoveSkillFromAgent,
          onShowContent: handleShowAgentContent,
          onDeleteNode: handleDeleteNode,
          onEditMaxInvocations: handleEditMaxInvocations,
        } as AgentNodeData,
      };
      setNodes((ns) => [...ns, newNode]);
    },
    [screenToFlowPosition, agents, setNodes, handleDropSkillOnAgent, handleRemoveSkillFromAgent, handleShowAgentContent, handleDeleteNode, handleEditMaxInvocations]
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  function getViewportCenter(): { x: number; y: number } {
    const canvas = document.querySelector<HTMLElement>('.flow-canvas-wrap');
    if (!canvas) return { x: 240, y: 240 };
    const rect = canvas.getBoundingClientRect();
    return screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  }

  function handleAddStart() {
    if (nodes.some(n => n.data.nodeType === 'start')) {
      setValidationErrors(['There is already a Start node. Only one is allowed per flow.']);
      return;
    }
    const newNode: Node<AnyNodeData> = {
      id: genNodeId('start'),
      type: 'start',
      position: getViewportCenter(),
      data: { nodeType: 'start', onDeleteNode: handleDeleteNode },
    };
    setNodes((ns) => [...ns, newNode]);
  }

  function handleAddEnd() {
    const pos = getViewportCenter();
    const newNode: Node<AnyNodeData> = {
      id: genNodeId('end'),
      type: 'end',
      position: { x: pos.x + 40, y: pos.y + 40 },
      data: {
        nodeType: 'end',
        onDeleteNode: handleDeleteNode,
        onEditOutcome: handleEditEndOutcome,
      } as EndNodeData,
    };
    setNodes((ns) => [...ns, newNode]);
  }

  function handleAddParallel() {
    const pos = getViewportCenter();
    const newNode: Node<AnyNodeData> = {
      id: genNodeId('parallel'),
      type: 'parallel',
      position: { x: pos.x - 40, y: pos.y - 40 },
      data: {
        nodeType: 'parallel',
        onDeleteNode: handleDeleteNode,
        onEditLabel: handleEditParallelLabel,
      } as ParallelNodeData,
    };
    setNodes((ns) => [...ns, newNode]);
  }

  function handleSaveEdgeCondition(edgeId: string, condition: string) {
    setEdges((prev) =>
      prev.map((e) =>
        e.id === edgeId ? { ...e, data: { ...e.data, condition: condition || undefined } } : e
      )
    );
    setEdgePopover(null);
  }

  function handleDeleteEdge(edgeId: string) {
    setEdges((prev) => prev.filter((e) => e.id !== edgeId));
    setEdgePopover(null);
  }

  function handleSaveNodeConfig(value: string | number) {
    if (!nodeConfig) return;
    const { nodeId, mode } = nodeConfig;
    setNodes((prev) =>
      prev.map((n) => {
        if (n.id !== nodeId) return n;
        if (mode === 'agent_max_inv' && n.data.nodeType === 'agent') {
          return { ...n, data: { ...n.data, maxInvocations: value as number } as AgentNodeData };
        }
        if (mode === 'end_outcome' && n.data.nodeType === 'end') {
          return { ...n, data: { ...n.data, outcome: (value as string) || undefined } as EndNodeData };
        }
        if (mode === 'parallel_label' && n.data.nodeType === 'parallel') {
          return { ...n, data: { ...n.data, label: (value as string) || undefined } as ParallelNodeData };
        }
        return n;
      })
    );
    setNodeConfig(null);
  }

  function handleClearFlow() {
    if (window.confirm('Delete all nodes and connections from the flow?')) {
      setNodes([]);
      setEdges([]);
    }
  }

  async function handleSave() {
    const errs = validateFlowClient(nodes, edges);
    if (errs.length > 0) {
      setValidationErrors(errs);
      return;
    }
    setSaving(true);
    const { nodes: backendNodes, edges: backendEdges } = toBackend(nodes, edges);
    const result = await saveFlow(backendNodes, backendEdges);
    setSaving(false);
    if (result.validation_errors && result.validation_errors.length > 0) {
      setValidationErrors(result.validation_errors);
    }
  }

  return (
    <div className="flow-editor-root">
      <Toolbar
        onAddStart={handleAddStart}
        onAddEnd={handleAddEnd}
        onAddParallel={handleAddParallel}
        onSave={handleSave}
        onClearFlow={handleClearFlow}
        saving={saving}
        onTogglePalette={() => setPaletteVisible((v) => !v)}
        onToggleSkills={() => setSkillsVisible((v) => !v)}
        paletteVisible={paletteVisible}
        skillsVisible={skillsVisible}
      />
      <div className="flow-canvas-area">
        {paletteVisible && (
          <PalettePanel
            agents={agents}
            visible={paletteVisible}
            onToggle={() => setPaletteVisible(false)}
            onShowContent={handleShowAgentContent}
          />
        )}
        <div className="flow-canvas-wrap" onDrop={onDrop} onDragOver={onDragOver}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onInit={(instance) => { rfInstance.current = instance; }}
            deleteKeyCode={['Backspace', 'Delete']}
            fitView
            fitViewOptions={{ padding: 0.2 }}
          >
            <Background gap={16} color="#334155" />
            <Controls />
            <MiniMap nodeColor={(n) => {
              const t = (n.data as AnyNodeData)?.nodeType;
              if (t === 'start') return '#22c55e';
              if (t === 'end') return '#ef4444';
              if (t === 'parallel') return '#f59e0b';
              return '#4f46e5';
            }} />
          </ReactFlow>
          {nodes.length === 0 && (
            <div className="canvas-empty-hint">
              <p>Drag an agent from the palette, or add a Start from the toolbar</p>
            </div>
          )}
        </div>
        {skillsVisible && (
          <SkillsPanel
            skills={skills}
            visible={skillsVisible}
            onToggle={() => setSkillsVisible(false)}
            onShowContent={handleShowSkillContent}
          />
        )}
      </div>

      {edgePopover && (
        <EdgeConditionPopover
          edgeId={edgePopover.edgeId}
          initialCondition={edgePopover.condition}
          onSave={handleSaveEdgeCondition}
          onDelete={handleDeleteEdge}
          onClose={() => setEdgePopover(null)}
        />
      )}

      {nodeConfig && (
        <NodeConfigModal
          mode={nodeConfig.mode}
          initialValue={nodeConfig.initial}
          onSave={handleSaveNodeConfig}
          onClose={() => setNodeConfig(null)}
        />
      )}

      {validationErrors.length > 0 && (
        <ValidationModal errors={validationErrors} onClose={() => setValidationErrors([])} />
      )}
    </div>
  );
}

export default function FlowEditor() {
  return (
    <ReactFlowProvider>
      <FlowEditorInner />
    </ReactFlowProvider>
  );
}
