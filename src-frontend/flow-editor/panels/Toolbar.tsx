import React from 'react';

interface Props {
  onAddStart: () => void;
  onAddEnd: () => void;
  onAddParallel: () => void;
  onSave: () => void;
  onClearFlow: () => void;
  saving: boolean;
  onTogglePalette: () => void;
  onToggleSkills: () => void;
  paletteVisible: boolean;
  skillsVisible: boolean;
}

export default function Toolbar({
  onAddStart,
  onAddEnd,
  onAddParallel,
  onSave,
  onClearFlow,
  saving,
  onTogglePalette,
  onToggleSkills,
  paletteVisible,
  skillsVisible,
}: Props) {
  return (
    <div className="fe-toolbar">
      <div className="fe-toolbar-group">
        <button
          className={`fe-btn fe-btn-toggle${paletteVisible ? ' active' : ''}`}
          onClick={onTogglePalette}
          title="Show/hide agents"
        >
          <span className="fe-btn-icon">◧</span> Agents
        </button>
        <button
          className={`fe-btn fe-btn-toggle${skillsVisible ? ' active' : ''}`}
          onClick={onToggleSkills}
          title="Show/hide skills"
        >
          Skills <span className="fe-btn-icon">◨</span>
        </button>
      </div>

      <div className="fe-toolbar-divider" />

      <div className="fe-toolbar-group">
        <span className="fe-toolbar-label">Add:</span>
        <button className="fe-btn fe-btn-add fe-add-start" onClick={onAddStart} title="Add Start node (one per flow)">
          ▶ <span>Start</span>
        </button>
        <button className="fe-btn fe-btn-add fe-add-parallel" onClick={onAddParallel} title="Add Parallel node (fork: run branches in parallel)">
          ⫲ <span>Parallel</span>
        </button>
        <button className="fe-btn fe-btn-add fe-add-end" onClick={onAddEnd} title="Add End node">
          ■ <span>End</span>
        </button>
      </div>

      <div className="fe-toolbar-spacer" />

      <div className="fe-toolbar-group">
        <button className="fe-btn fe-btn-ghost fe-btn-danger" onClick={onClearFlow} title="Delete all nodes and connections">
          🗑 Clear flow
        </button>
        <button
          className={`fe-btn fe-btn-primary${saving ? ' loading' : ''}`}
          onClick={onSave}
          disabled={saving}
          title="Save flow"
        >
          {saving ? '⟳ Saving…' : '💾 Save'}
        </button>
      </div>
    </div>
  );
}
