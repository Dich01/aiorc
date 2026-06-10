import React, { useCallback, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { AgentNodeData, SkillSummary } from '../types';

export default function AgentNode({ id, data, selected }: NodeProps) {
  const d = data as AgentNodeData;
  const [isHover, setHover] = useState(false);
  const [isDropTarget, setDropTarget] = useState(false);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropTarget(true);
  }, []);

  const onDragLeave = useCallback(() => setDropTarget(false), []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(false);
      const skillId = e.dataTransfer.getData('skill-id');
      if (skillId && d.onDropSkill) d.onDropSkill(d.agentId, skillId);
    },
    [d]
  );

  const initials = (d.agentName || '?').slice(0, 2).toUpperCase();
  const skills = d.skills || [];

  return (
    <div
      className={`fe-node fe-node-agent${selected ? ' selected' : ''}${isDropTarget ? ' drop-target' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Handle type="target" position={Position.Top} className="fe-handle" />

      <div className="fe-node-header fe-agent-header">
        <div className="fe-node-icon">{initials}</div>
        <div className="fe-node-title">
          <div className="fe-node-name">{d.agentName || 'Unnamed agent'}</div>
          <div className="fe-node-kind">
            Agent · <button
              className="fe-max-inv-btn"
              onClick={(e) => { e.stopPropagation(); d.onEditMaxInvocations?.(id); }}
              title="Change max invocations"
            >max ×{d.maxInvocations ?? 10}</button>
          </div>
        </div>
        {(isHover || selected) && (
          <div className="fe-node-actions">
            {d.onShowContent && (
              <button
                className="fe-node-action"
                onClick={(e) => {
                  e.stopPropagation();
                  d.onShowContent!(d.agentId, d.agentName);
                }}
                title="View agent content"
              >
                ⟶
              </button>
            )}
            {d.onDeleteNode && (
              <button
                className="fe-node-action fe-node-action-delete"
                onClick={(e) => {
                  e.stopPropagation();
                  d.onDeleteNode!(id);
                }}
                title="Delete node"
              >
                ×
              </button>
            )}
          </div>
        )}
      </div>

      {skills.length > 0 ? (
        <div className="fe-node-body">
          <div className="fe-node-section-label">SKILLS</div>
          <div className="fe-skills-list">
            {skills.map((s: SkillSummary) => (
              <div key={s.id} className="fe-skill-pill" title={s.description}>
                <span className="fe-skill-name">{s.name}</span>
                {d.onRemoveSkill && (
                  <button
                    className="fe-skill-remove"
                    onClick={(e) => {
                      e.stopPropagation();
                      d.onRemoveSkill!(d.agentId, s.id);
                    }}
                    title="Remove skill"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="fe-node-body fe-node-body-empty">
          <span className="fe-node-hint">Drop a skill here</span>
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="fe-handle" />
    </div>
  );
}
