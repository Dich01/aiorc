import React, { useState } from 'react';
import type { SkillSummary } from '../types';

interface Props {
  skills: SkillSummary[];
  visible: boolean;
  onToggle: () => void;
  onShowContent?: (id: string, name: string) => void;
}

export default function SkillsPanel({ skills, visible, onToggle, onShowContent }: Props) {
  const [filter, setFilter] = useState('');

  function onDragStart(e: React.DragEvent, skill: SkillSummary) {
    e.dataTransfer.setData('skill-id', skill.id);
    e.dataTransfer.effectAllowed = 'copy';
  }

  const filtered = skills.filter((s) =>
    !filter || s.name.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className={`fe-side-panel fe-skills-side${visible ? '' : ' hidden'}`}>
      <div className="fe-panel-header">
        <button className="fe-panel-toggle" onClick={onToggle} title="Hide">
          ›
        </button>
        <span className="fe-panel-title">Skills <span className="fe-panel-count">{skills.length}</span></span>
      </div>
      <div className="fe-panel-search">
        <input
          type="text"
          className="fe-search-input"
          placeholder="🔍 Filter skills…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="fe-panel-hint">
        Drag a skill onto an agent to attach it.
      </div>
      <div className="fe-panel-body">
        {skills.length === 0 ? (
          <p className="fe-panel-empty">No skills in this project.</p>
        ) : filtered.length === 0 ? (
          <p className="fe-panel-empty">No results.</p>
        ) : (
          filtered.map((s) => (
            <div
              key={s.id}
              className="fe-palette-item fe-skill-card"
              draggable
              onDragStart={(e) => onDragStart(e, s)}
              title={s.description}
            >
              <div className="fe-palette-avatar fe-skill-avatar">⚙</div>
              <div className="fe-palette-info">
                <div
                  className={`fe-palette-name${onShowContent ? ' clickable' : ''}`}
                  onClick={(e) => { if (onShowContent) { e.stopPropagation(); onShowContent(s.id, s.name); } }}
                  title={onShowContent ? 'Click to view content' : s.name}
                >
                  {s.name}
                </div>
                {s.description && <div className="fe-palette-desc">{s.description}</div>}
              </div>
              <div className="fe-palette-grip">⋮⋮</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
