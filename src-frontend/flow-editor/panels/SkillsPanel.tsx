import React, { useState } from 'react';
import type { SkillSummary, ContextSummary } from '../types';

type Tab = 'skills' | 'contexts';

interface Props {
  skills: SkillSummary[];
  contexts: ContextSummary[];
  visible: boolean;
  onToggle: () => void;
  onShowSkill?: (id: string, name: string) => void;
  onShowContext?: (id: string, name: string) => void;
}

const SKILL_ICON = (
  <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3 3 6.5 10 10l7-3.5z"/><path d="m3 10 7 3.5 7-3.5"/><path d="m3 13.5 7 3.5 7-3.5"/></svg>
);
const CONTEXT_ICON = (
  <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 3h7l3 3v11H5z"/><path d="M12 3v3h3"/><path d="M7.5 10h5M7.5 13h5"/></svg>
);

// The right-hand library: skills and contexts, both dragged onto an agent.
// A context dropped on an agent is delivered only in that agent's steps.
export default function SkillsPanel({ skills, contexts, visible, onToggle, onShowSkill, onShowContext }: Props) {
  const [tab, setTab] = useState<Tab>('skills');
  const [filter, setFilter] = useState('');
  const items: { id: string; name: string; description: string }[] = tab === 'skills' ? skills : contexts;
  const onShow = tab === 'skills' ? onShowSkill : onShowContext;

  function onDragStart(e: React.DragEvent, id: string) {
    e.dataTransfer.setData(tab === 'skills' ? 'skill-id' : 'context-id', id);
    e.dataTransfer.effectAllowed = 'copy';
  }

  const filtered = items.filter((s) => !filter || s.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className={`fe-side-panel fe-skills-side${visible ? '' : ' hidden'}`}>
      <div className="fe-panel-header">
        <button className="fe-panel-toggle" onClick={onToggle} title="Hide">›</button>
        <div className="fe-panel-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'skills'} className={`fe-panel-tab${tab === 'skills' ? ' active' : ''}`} onClick={() => setTab('skills')}>
            Skills <span className="fe-panel-count">{skills.length}</span>
          </button>
          <button role="tab" aria-selected={tab === 'contexts'} className={`fe-panel-tab${tab === 'contexts' ? ' active' : ''}`} onClick={() => setTab('contexts')}>
            Contexts <span className="fe-panel-count">{contexts.length}</span>
          </button>
        </div>
      </div>
      <div className="fe-panel-search">
        <input
          type="text"
          className="fe-search-input"
          placeholder={tab === 'skills' ? 'Filter skills…' : 'Filter contexts…'}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="fe-panel-hint">
        {tab === 'skills'
          ? 'Drag a skill onto an agent to attach it.'
          : 'Drag a context onto the agent that needs it. Only that agent receives it, in its own step.'}
      </div>
      <div className="fe-panel-body">
        {items.length === 0 ? (
          <p className="fe-panel-empty">{tab === 'skills' ? 'No skills in this project.' : 'No contexts yet. Create them in Contexts.'}</p>
        ) : filtered.length === 0 ? (
          <p className="fe-panel-empty">No results.</p>
        ) : (
          filtered.map((s) => (
            <div
              key={s.id}
              className="fe-palette-item fe-skill-card"
              draggable
              onDragStart={(e) => onDragStart(e, s.id)}
              title={s.description}
            >
              <div className={`fe-palette-avatar ${tab === 'skills' ? 'fe-skill-avatar' : 'fe-context-avatar'}`}>
                {tab === 'skills' ? SKILL_ICON : CONTEXT_ICON}
              </div>
              <div className="fe-palette-info">
                <div
                  className={`fe-palette-name${onShow ? ' clickable' : ''}`}
                  onClick={(e) => { if (onShow) { e.stopPropagation(); onShow(s.id, s.name); } }}
                  title={onShow ? 'Click to view content' : s.name}
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
