import React from 'react';

interface Props {
  errors: string[];
  onClose: () => void;
}

export default function ValidationModal({ errors, onClose }: Props) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box validation-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <strong>⚠ The flow cannot be saved</strong>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <ul className="validation-error-list">
            {errors.map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>
        </div>
        <div className="modal-footer">
          <button className="btn-primary" onClick={onClose}>Got it</button>
        </div>
      </div>
    </div>
  );
}
