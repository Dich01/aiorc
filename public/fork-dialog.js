// The dialog shown before forking a project: which of the contexts the owner
// shares to copy, and a warning about the private ones that stay behind.
//   AIOrcForkDialog.confirmProjectFork(projectId, token)
//     -> Promise<null | { copy_context_ids: string[] }>   (null = cancelled)
(function () {
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function ensureStyles() {
    if (document.getElementById('fork-dlg-styles')) return;
    const s = document.createElement('style');
    s.id = 'fork-dlg-styles';
    s.textContent = `
      .fork-dlg-backdrop { position: fixed; inset: 0; background: rgba(15,23,42,0.45); display: flex; align-items: center; justify-content: center; z-index: 9999; padding: 16px; }
      .fork-dlg { background: #fff; border-radius: 10px; box-shadow: 0 12px 38px rgba(0,0,0,0.2); width: min(520px, 100%); max-height: calc(100vh - 32px); display: flex; flex-direction: column; color: #1f2937; font-family: inherit; }
      .fork-dlg-head { padding: 20px 22px 0; }
      .fork-dlg-title { font-size: 1.05rem; font-weight: 700; color: #0a0a1f; margin: 0; }
      .fork-dlg-sub { font-size: 0.86rem; color: #565e74; margin: 6px 0 0; line-height: 1.5; }
      .fork-dlg-body { padding: 14px 22px; overflow-y: auto; }
      .fork-dlg-label { font-weight: 600; font-size: 0.86rem; margin: 0 0 6px; }
      .fork-dlg-list { border: 1px solid #e3e6ee; border-radius: 8px; }
      .fork-dlg-item { display: flex; gap: 10px; align-items: flex-start; padding: 9px 12px; border-top: 1px solid #e3e6ee; cursor: pointer; font-size: 0.85rem; }
      .fork-dlg-item:first-child { border-top: 0; }
      .fork-dlg-item input { margin-top: 3px; width: 16px; height: 16px; flex-shrink: 0; }
      .fork-dlg-name { font-weight: 600; }
      .fork-dlg-where { display: block; font-size: 0.76rem; color: #565e74; margin-top: 1px; }
      .fork-dlg-warn { margin-top: 12px; background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 10px 12px; font-size: 0.84rem; color: #92400e; line-height: 1.5; }
      .fork-dlg-none { font-size: 0.84rem; color: #565e74; }
      .fork-dlg-foot { display: flex; justify-content: flex-end; gap: 10px; padding: 14px 22px 18px; border-top: 1px solid #eef0f4; }
      .fork-dlg-btn { font: inherit; font-size: 0.86rem; font-weight: 600; padding: 8px 16px; border-radius: 8px; cursor: pointer; border: 1px solid #d1d5db; background: #fff; color: #1f2937; }
      .fork-dlg-btn.primary { background: #4361ee; border-color: #4361ee; color: #fff; }
      .fork-dlg-btn.primary:hover { background: #2f4bd6; }
      .fork-dlg-btn:focus-visible { outline: 2px solid #4361ee; outline-offset: 2px; }`;
    document.head.appendChild(s);
  }

  async function confirmProjectFork(projectId, token) {
    let preview = null;
    try {
      const r = await fetch(`/projects/${encodeURIComponent(projectId)}/fork-preview`, { headers: { Authorization: 'Bearer ' + token } });
      if (r.ok) preview = await r.json();
    } catch { /* fall back to a plain confirmation */ }
    ensureStyles();
    return new Promise((resolve) => {
      const shared = preview?.shared || [];
      const priv = preview?.private_count || 0;
      const back = document.createElement('div');
      back.className = 'fork-dlg-backdrop';
      back.innerHTML = `
        <div class="fork-dlg" role="dialog" aria-modal="true" aria-labelledby="fork-dlg-title">
          <div class="fork-dlg-head">
            <h2 class="fork-dlg-title" id="fork-dlg-title">Fork ${preview ? '"' + esc(preview.project.name) + '"' : 'this project'}?</h2>
            <p class="fork-dlg-sub">You get your own editable copy of its flow, agents and skills. When the original changes you are told, and you can update your copy in one step.</p>
          </div>
          <div class="fork-dlg-body">
            ${shared.length ? `
              <p class="fork-dlg-label">Contexts the owner shares</p>
              <div class="fork-dlg-list">${shared.map((c) => `
                <label class="fork-dlg-item"><input type="checkbox" value="${esc(c.id)}" checked />
                  <span><span class="fork-dlg-name">${esc(c.name)}</span>
                  <span class="fork-dlg-where">${c.scope === 'project' ? 'Whole project' : 'Agent' + (c.agents.length === 1 ? ' ' : 's ') + esc(c.agents.join(', '))}${c.description ? ' · ' + esc(c.description) : ''}</span></span>
                </label>`).join('')}</div>`
              : `<p class="fork-dlg-none">The owner shares no contexts with forks.</p>`}
            ${priv ? `<div class="fork-dlg-warn">${priv} private context${priv === 1 ? '' : 's'} ${priv === 1 ? 'is' : 'are'} not copied${preview.private_agents.length ? ` (used by ${esc(preview.private_agents.join(', '))})` : ''}. Your copy runs without ${priv === 1 ? 'it' : 'them'}: add your own context with your project's knowledge where those agents need it.</div>` : ''}
          </div>
          <div class="fork-dlg-foot">
            <button type="button" class="fork-dlg-btn" data-act="cancel">Cancel</button>
            <button type="button" class="fork-dlg-btn primary" data-act="ok">Fork</button>
          </div>
        </div>`;
      const done = (v) => { document.removeEventListener('keydown', onKey); back.remove(); resolve(v); };
      const ok = () => done({ copy_context_ids: [...back.querySelectorAll('input[type=checkbox]')].filter((i) => i.checked).map((i) => i.value) });
      const onKey = (e) => { if (e.key === 'Escape') done(null); };
      back.addEventListener('click', (e) => {
        if (e.target === back) return done(null);
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'cancel') done(null);
        if (act === 'ok') ok();
      });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(back);
      back.querySelector('[data-act="ok"]').focus();
    });
  }

  window.AIOrcForkDialog = { confirmProjectFork };
})();
