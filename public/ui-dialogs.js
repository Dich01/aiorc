// In-app replacements for window.alert / window.confirm / window.prompt.
// All three return a Promise so callers can `await` them.
//   uiAlert(message, { title?, okLabel? })           -> Promise<void>
//   uiConfirm(message, { title?, danger?, okLabel?, cancelLabel? }) -> Promise<boolean>
//   uiPrompt(message, defaultValue?, { title?, placeholder?, okLabel? }) -> Promise<string|null>
(function () {
  if (window.uiAlert) return;

  let active = null;

  function ensureStyles() {
    if (document.getElementById('ui-dialogs-styles')) return;
    const s = document.createElement('style');
    s.id = 'ui-dialogs-styles';
    s.textContent = `
      .ui-dlg-backdrop {
        position: fixed; inset: 0; background: rgba(15,23,42,0.45);
        display: flex; align-items: center; justify-content: center;
        z-index: 9999; animation: ui-dlg-fade .12s ease-out;
      }
      @keyframes ui-dlg-fade { from { opacity: 0 } to { opacity: 1 } }
      .ui-dlg-box {
        background: #fff; border-radius: 10px;
        box-shadow: 0 12px 38px rgba(0,0,0,0.20);
        width: min(440px, calc(100% - 32px));
        padding: 22px 24px; font-family: inherit; color: #1f2937;
        animation: ui-dlg-pop .14s ease-out;
      }
      @keyframes ui-dlg-pop { from { transform: translateY(8px); opacity: 0 } to { transform: translateY(0); opacity: 1 } }
      .ui-dlg-title { font-size: 1rem; font-weight: 700; margin-bottom: 8px; color: #0a0a1f; }
      .ui-dlg-msg   { font-size: .92rem; line-height: 1.55; margin-bottom: 18px; white-space: pre-wrap; word-break: break-word; }
      .ui-dlg-input {
        width: 100%; box-sizing: border-box;
        padding: 9px 12px; border: 1px solid #e5e7eb; border-radius: 6px;
        font-size: .92rem; margin-bottom: 18px; font-family: inherit; color: #1f2937; background: #fff;
      }
      .ui-dlg-input:focus { outline: none; border-color: #4361ee; box-shadow: 0 0 0 3px rgba(67,97,238,0.15); }
      .ui-dlg-actions { display: flex; gap: 10px; justify-content: flex-end; }
      .ui-dlg-btn {
        padding: 8px 16px; border-radius: 6px; font-weight: 600; font-size: .88rem;
        cursor: pointer; border: 1px solid transparent; font-family: inherit; line-height: 1.2;
      }
      .ui-dlg-btn.ghost   { background: transparent; color: #6b7280; border-color: #e5e7eb; }
      .ui-dlg-btn.ghost:hover { background: #f9fafb; color: #374151; }
      .ui-dlg-btn.primary { background: #4361ee; color: #fff; }
      .ui-dlg-btn.primary:hover { background: #3451d1; }
      .ui-dlg-btn.danger  { background: #dc2626; color: #fff; }
      .ui-dlg-btn.danger:hover { background: #b91c1c; }
    `;
    document.head.appendChild(s);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function close() {
    if (active) {
      active.backdrop.remove();
      document.removeEventListener('keydown', active.onKey);
      active = null;
    }
  }

  function show(opts) {
    ensureStyles();
    close();
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'ui-dlg-backdrop';
      const box = document.createElement('div');
      box.className = 'ui-dlg-box';

      const titleHtml = opts.title ? `<div class="ui-dlg-title">${escapeHtml(opts.title)}</div>` : '';
      const msgHtml   = `<div class="ui-dlg-msg">${escapeHtml(opts.message || '')}</div>`;
      const inputHtml = opts.input
        ? `<input class="ui-dlg-input" type="text" value="${escapeHtml(opts.defaultValue || '')}" placeholder="${escapeHtml(opts.placeholder || '')}" />`
        : '';
      const cancelBtn = (opts.cancel !== false)
        ? `<button type="button" class="ui-dlg-btn ghost" data-act="cancel">${escapeHtml(opts.cancelLabel || 'Cancel')}</button>`
        : '';
      const okClass   = opts.danger ? 'danger' : 'primary';
      const okBtn     = `<button type="button" class="ui-dlg-btn ${okClass}" data-act="ok">${escapeHtml(opts.okLabel || 'OK')}</button>`;

      box.innerHTML = titleHtml + msgHtml + inputHtml + `<div class="ui-dlg-actions">${cancelBtn}${okBtn}</div>`;
      backdrop.appendChild(box);
      document.body.appendChild(backdrop);

      const input = box.querySelector('.ui-dlg-input');
      const okEl  = box.querySelector('[data-act="ok"]');
      const ccEl  = box.querySelector('[data-act="cancel"]');

      const finish = (val) => { close(); resolve(val); };

      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          finish(opts.input ? null : false);
        } else if (e.key === 'Enter') {
          // Only swallow Enter when focus is on the input (or no input present and focus is on a button).
          if (input && document.activeElement === input) {
            e.preventDefault();
            finish(input.value);
          } else if (!input && document.activeElement && document.activeElement.classList.contains('ui-dlg-btn')) {
            // Let default click handle it.
          } else if (!input) {
            e.preventDefault();
            finish(true);
          }
        }
      };
      document.addEventListener('keydown', onKey);
      active = { backdrop, onKey };

      okEl.addEventListener('click', () => finish(opts.input ? (input ? input.value : '') : true));
      if (ccEl) ccEl.addEventListener('click', () => finish(opts.input ? null : false));
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) finish(opts.input ? null : false);
      });

      setTimeout(() => {
        if (input) { input.focus(); input.select(); }
        else { okEl.focus(); }
      }, 30);
    });
  }

  window.uiAlert = function (message, options) {
    return show({
      message,
      cancel: false,
      okLabel: (options && options.okLabel) || 'OK',
      title:   options && options.title,
    });
  };

  window.uiConfirm = function (message, options) {
    const o = options || {};
    return show({
      message,
      danger: o.danger,
      okLabel: o.okLabel || (o.danger ? 'Delete' : 'OK'),
      cancelLabel: o.cancelLabel || 'Cancel',
      title: o.title,
    });
  };

  window.uiPrompt = function (message, defaultValue, options) {
    const o = options || {};
    return show({
      message,
      input: true,
      defaultValue: defaultValue || '',
      placeholder: o.placeholder || '',
      okLabel: o.okLabel || 'OK',
      cancelLabel: o.cancelLabel || 'Cancel',
      title: o.title,
    });
  };
})();
