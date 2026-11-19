// The "Notifications" item of the app sidebar, with a red dot and the number
// of unread notifications. Added to every sidebar on the page (the shared one
// from site-shell.js and the ones written into the workspace pages), refreshed
// on load and every 60 seconds.
(function () {
  const BELL = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 8.5a4.5 4.5 0 0 1 9 0c0 3.6 1.5 5 1.5 5H4s1.5-1.4 1.5-5z"/><path d="M8.6 16.2a1.6 1.6 0 0 0 2.8 0"/></svg>';

  function addStyle() {
    if (document.getElementById('notif-style')) return;
    const s = document.createElement('style');
    s.id = 'notif-style';
    s.textContent = `
      .sidebar-item[data-key="notifications"] { position: relative; }
      .notif-dot { margin-left: auto; background: #d0342c; color: #fff; font-size: 0.66rem; font-weight: 700; padding: 1px 6px; border-radius: 9px; min-width: 16px; text-align: center; line-height: 1.4; }
      .notif-dot[hidden] { display: none; }
      .sidebar.collapsed .notif-dot { position: absolute; top: 4px; right: 4px; padding: 0; min-width: 8px; width: 8px; height: 8px; font-size: 0; }`;
    document.head.appendChild(s);
  }

  function attach() {
    if (!localStorage.getItem('token')) return;
    addStyle();
    document.querySelectorAll('.sidebar').forEach((sb) => {
      if (sb.querySelector('[data-key="notifications"]')) return;
      const team = sb.querySelector('[data-key="team"]');
      const nav = team ? team.parentElement : sb.querySelector('.sidebar-nav');
      if (!nav) return;
      const a = document.createElement('a');
      a.className = 'sidebar-item' + (/notifications\.html$/.test(location.pathname) ? ' active' : '');
      a.dataset.key = 'notifications';
      a.href = 'notifications.html';
      a.title = 'Notifications';
      a.innerHTML = `<span class="sidebar-item-glyph">${BELL}</span><span class="sidebar-item-label">Notifications</span><span class="notif-dot" hidden></span>`;
      if (team) team.after(a); else nav.appendChild(a);
    });
    refresh();
  }

  function show(n) {
    document.querySelectorAll('.notif-dot').forEach((d) => {
      d.textContent = n > 99 ? '99+' : String(n);
      d.hidden = !(n > 0);
      d.parentElement.title = n > 0 ? `Notifications (${n} unread)` : 'Notifications';
    });
  }

  function refresh() {
    const token = localStorage.getItem('token');
    if (!token) return;
    fetch('/notifications/unread-count', { headers: { Authorization: 'Bearer ' + token } })
      .then((r) => (r.ok ? r.json() : null)).then((b) => { if (b) show(b.unread); }).catch(() => {});
  }

  window.AIOrcNotifications = { attach, refresh, show };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach); else attach();
  // Pages that build their sidebar after load (site-shell) call attach() again; this catches the rest.
  window.addEventListener('load', attach);
  setInterval(refresh, 60000);
})();
