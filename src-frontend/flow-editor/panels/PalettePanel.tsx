import React, { useState } from 'react';
import type { AgentSummary } from '../types';

interface Props {
  agents: AgentSummary[];
  visible: boolean;
  onToggle: () => void;
  onShowContent?: (id: string, name: string) => void;
}

export default function PalettePanel({ agents, visible, onToggle, onShowContent }: Props) {
  const [filter, setFilter] = useState('');

  function onDragStart(e: React.DragEvent, agent: AgentSummary) {
    e.dataTransfer.setData('agent-id', agent.id);
    e.dataTransfer.setData('agent-name', agent.name);
    e.dataTransfer.effectAllowed = 'copy';
  }

  const filtered = agents.filter((a) =>
    !filter || a.name.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className={`fe-side-panel fe-palette-panel${visible ? '' : ' hidden'}`}>
      <div className="fe-panel-header">
        <span className="fe-panel-title">Agents <span className="fe-panel-count">{agents.length}</span></span>
        <button className="fe-panel-toggle" onClick={onToggle} title="Hide">
          ‹
        </button>
      </div>
      <div className="fe-panel-search">
        <input
          type="text"
          className="fe-search-input"
          placeholder="🔍 Filter agents…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="fe-panel-body">
        {agents.length === 0 ? (
          <p className="fe-panel-empty">No agents in this project.</p>
        ) : filtered.length === 0 ? (
          <p className="fe-panel-empty">No results.</p>
        ) : (
          filtered.map((a) => (
            <div
              key={a.id}
              className="fe-palette-item"
              draggable
              onDragStart={(e) => onDragStart(e, a)}
              title={a.description}
            >
              <div className="fe-palette-avatar">{a.name.slice(0, 2).toUpperCase()}</div>
              <div className="fe-palette-info">
                <div
                  className={`fe-palette-name${onShowContent ? ' clickable' : ''}`}
                  onClick={(e) => { if (onShowContent) { e.stopPropagation(); onShowContent(a.id, a.name); } }}
                  title={onShowContent ? 'Click to view content' : a.name}
                >
                  {a.name}
                </div>
                {a.description && <div className="fe-palette-desc">{a.description}</div>}
              </div>
              <div className="fe-palette-grip">⋮⋮</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
