import React, { useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { StartNodeData } from '../types';

export default function StartNode({ id, data, selected }: NodeProps) {
  const d = data as StartNodeData;
  const [isHover, setHover] = useState(false);

  return (
    <div
      className={`fe-marker fe-marker-start${selected ? ' selected' : ''}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="fe-marker-icon">▶</div>
      <div className="fe-marker-label">Start</div>
      {(isHover || selected) && d.onDeleteNode && (
        <button
          className="fe-marker-delete"
          onClick={(e) => { e.stopPropagation(); d.onDeleteNode!(id); }}
          title="Delete Start"
        >×</button>
      )}
      <Handle type="source" position={Position.Bottom} className="fe-handle" />
    </div>
  );
}
