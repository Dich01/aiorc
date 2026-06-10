import React, { useState } from 'react';

export type NodeConfigMode = 'agent_max_inv' | 'end_outcome' | 'parallel_label';

interface Props {
  mode: NodeConfigMode;
  initialValue: string | number;
  onSave: (value: string | number) => void;
  onClose: () => void;
}

export default function NodeConfigModal({ mode, initialValue, onSave, onClose }: Props) {
  const [value, setValue] = useState<string>(String(initialValue ?? ''));

  function handleSave() {
    if (mode === 'agent_max_inv') {
      const n = Math.max(1, Math.min(50, parseInt(value, 10) || 10));
      onSave(n);
    } else {
      onSave(value.trim());
    }
  }

  const title =
    mode === 'agent_max_inv' ? 'Max invocations'
    : mode === 'end_outcome' ? 'End outcome'
    : 'Parallel label';
  const hint =
    mode === 'agent_max_inv'
      ? 'How many times this agent can be invoked at most during a workflow execution. Default 10, max 50.'
      : mode === 'end_outcome'
        ? 'Free text describing in what state the flow ends when this End is reached. E.g.: "all OK", "critical failure", "needs manual approval". Optional.'
        : 'Optional label to identify this fork in the compiled prompt. E.g.: "QA gates", "domain". If left empty, it is shown as "Parallel".';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <strong>{title}</strong>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {mode === 'agent_max_inv' ? (
            <input
              type="number"
              min={1}
              max={50}
              className="modal-input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
            />
          ) : (
            <input
              type="text"
              className="modal-input"
              placeholder={
                mode === 'end_outcome'
                  ? 'E.g.: all OK, critical failure, needs manual review'
                  : 'E.g.: QA gates, domain, validations'
              }
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
            />
          )}
          <p className="modal-hint">{hint}</p>
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  );
}
