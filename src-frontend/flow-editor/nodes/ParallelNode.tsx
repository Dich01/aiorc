import React, { useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ParallelNodeData } from '../types';

export default function ParallelNode({ id, data, selected }: NodeProps) {
  const d = data as ParallelNodeData;
  const [isHover, setHover] = useState(false);

  return (
    <div
      className={`fe-marker fe-marker-parallel${selected ? ' selected' : ''}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Handle type="target" position={Position.Top} className="fe-handle" />
      <div className="fe-marker-icon">⫲</div>
      <div className="fe-marker-label">
        <span>Parallel</span>
        <button
          className="fe-marker-edit-btn"
          onClick={(e) => { e.stopPropagation(); d.onEditLabel?.(id); }}
          title="Edit label"
        >
          {d.label
            ? <span className="fe-marker-outcome">{d.label}</span>
            : <span className="fe-marker-outcome empty">+ label</span>}
        </button>
      </div>
      {(isHover || selected) && d.onDeleteNode && (
        <button
          className="fe-marker-delete"
          onClick={(e) => { e.stopPropagation(); d.onDeleteNode!(id); }}
          title="Delete Parallel"
        >×</button>
      )}
      <Handle type="source" position={Position.Bottom} className="fe-handle" />
    </div>
  );
}
