import React, { useState } from 'react';

interface Props {
  edgeId: string;
  initialCondition: string;
  onSave: (edgeId: string, condition: string) => void;
  onDelete: (edgeId: string) => void;
  onClose: () => void;
}

export default function EdgeConditionPopover({
  edgeId,
  initialCondition,
  onSave,
  onDelete,
  onClose,
}: Props) {
  const [condition, setCondition] = useState(initialCondition);

  function handleSave() {
    onSave(edgeId, condition.trim());
  }

  function handleDelete() {
    onDelete(edgeId);
  }

  return (
    <div className="edge-popover-backdrop" onClick={onClose}>
      <div className="edge-popover" onClick={(e) => e.stopPropagation()}>
        <div className="popover-header">
          <strong>Edge condition</strong>
          <button className="popover-close" onClick={onClose}>×</button>
        </div>
        <div className="popover-body">
          <label>Condition (free text, natural language)</label>
          <textarea
            className="condition-input"
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
            placeholder="E.g.: when the test fails, or when the reviewer found bugs"
            rows={3}
            style={{ resize: 'vertical', fontFamily: 'inherit', minHeight: 60 }}
            autoFocus
          />
          <p className="modal-hint">
            The LLM will interpret this condition when executing the flow.
            If you leave it empty, this edge is the default transition (fallback) when no other one matches.
          </p>
        </div>
        <div className="popover-footer">
          <button className="btn-secondary" onClick={handleDelete} style={{ marginRight: 'auto', color: '#ef4444' }}>
            🗑 Delete edge
          </button>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  );
}
