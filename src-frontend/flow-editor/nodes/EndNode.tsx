import React, { useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { EndNodeData } from '../types';

export default function EndNode({ id, data, selected }: NodeProps) {
  const d = data as EndNodeData;
  const [isHover, setHover] = useState(false);

  return (
    <div
      className={`fe-marker fe-marker-end${selected ? ' selected' : ''}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Handle type="target" position={Position.Top} className="fe-handle" />
      <div className="fe-marker-icon">■</div>
      <div className="fe-marker-label">
        <span>End</span>
        <button
          className="fe-marker-edit-btn"
          onClick={(e) => { e.stopPropagation(); d.onEditOutcome?.(id); }}
          title="Edit outcome"
        >
          {d.outcome
            ? <span className="fe-marker-outcome">{d.outcome}</span>
            : <span className="fe-marker-outcome empty">+ outcome</span>}
        </button>
      </div>
      {(isHover || selected) && d.onDeleteNode && (
        <button
          className="fe-marker-delete"
          onClick={(e) => { e.stopPropagation(); d.onDeleteNode!(id); }}
          title="Delete End"
        >×</button>
      )}
    </div>
  );
}
