// Shared site shell for pages that work both signed in and signed out
// (documentation, benchmarks, public repository, issues, profiles).
// Signed in: the app sidebar, the same as on the workspace pages.
// Signed out: the public top nav, the same as on the landing page.
// Usage: <div id="shell-mount" data-active="docs"></div> then
//   mount.outerHTML = SiteShell.sidebarHTML(active)  or  SiteShell.publicNavHTML(active)
// (or SiteShell.mount() to do both and wire the sidebar).
(function () {
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function sidebarHTML(active) {
    const userNickname = localStorage.getItem('userNickname') || '';
    const userEmail = localStorage.getItem('userEmail') || '';
    const isAdmin = localStorage.getItem('userRole') === 'admin';
    let html = `
        <aside class="sidebar" id="sidebar">
          <div class="sidebar-header">
            <div class="sidebar-logo"><a href="dashboard.html">AI<span>Orc</span></a></div>
            <button class="sidebar-collapse-btn" id="sidebar-toggle" onclick="toggleSidebar()">‹</button>
          </div>
          <div class="sidebar-section-title">Workspace</div>
          <nav class="sidebar-nav">
            <a class="sidebar-item" data-key="projects" href="dashboard.html?tab=projects"><span class="sidebar-item-glyph"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h3.8l1.9 2h5.3A1.5 1.5 0 0 1 17 8.5v6a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z"/></svg></span><span class="sidebar-item-label">Projects</span></a>
            <a class="sidebar-item" data-key="agents" href="dashboard.html?tab=agents"><span class="sidebar-item-glyph"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="6.5" width="12" height="9.5" rx="2.2"/><path d="M10 3.5v3M7.6 10.6h.01M12.4 10.6h.01M8.3 13.4h3.4"/></svg></span><span class="sidebar-item-label">Agents</span></a>
            <a class="sidebar-item" data-key="skills" href="dashboard.html?tab=skills"><span class="sidebar-item-glyph"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3 3 6.5 10 10l7-3.5z"/><path d="m3 10 7 3.5 7-3.5"/><path d="m3 13.5 7 3.5 7-3.5"/></svg></span><span class="sidebar-item-label">Skills</span></a>
            <a class="sidebar-item" data-key="contexts" href="dashboard.html?tab=contexts"><span class="sidebar-item-glyph"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 4.5A1.5 1.5 0 0 1 6 3h9.5v11H6a1.5 1.5 0 0 0-1.5 1.5z"/><path d="M4.5 15.5A1.5 1.5 0 0 0 6 17h9.5v-3"/></svg></span><span class="sidebar-item-label">Contexts</span></a>
            <a class="sidebar-item" id="sb-team" data-key="team" href="dashboard.html?tab=team"><span class="sidebar-item-glyph"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="7" r="2.8"/><path d="M2.8 16.5a5.2 5.2 0 0 1 10.4 0"/><path d="M13 4.4a2.8 2.8 0 0 1 0 5.2M15.2 12.2a5.2 5.2 0 0 1 2 4.3"/></svg></span><span class="sidebar-item-label">Team</span><span id="team-badge" class="team-badge" style="display:none">0</span></a>
          </nav>
          <div class="sidebar-section-title">Insights</div>
          <nav class="sidebar-nav">
            <a class="sidebar-item" data-key="analytics" href="analytics.html"><span class="sidebar-item-glyph"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 16V10M10 16V4.5M15.5 16v-6"/></svg></span><span class="sidebar-item-label">Usage analytics</span></a>
            <a class="sidebar-item" data-key="audit" href="audit.html" title="Audit"><span class="sidebar-item-glyph"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 2.8 4.2 5.2v4.3c0 3.6 2.5 6.4 5.8 7.7 3.3-1.3 5.8-4.1 5.8-7.7V5.2z"/><path d="m7.6 10 1.7 1.7 3.2-3.4"/></svg></span><span class="sidebar-item-label">Audit</span></a>
            ${isAdmin ? `<a class="sidebar-item" data-key="admin" href="admin.html" title="Admin panel"><span class="sidebar-item-glyph"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 6h7.5M14.5 6h2M3.5 14h2M9 14h7.5"/><circle cx="12.8" cy="6" r="1.8"/><circle cx="7.2" cy="14" r="1.8"/></svg></span><span class="sidebar-item-label">Admin panel</span></a>` : ''}
          </nav>
          <div class="sidebar-section-title">Community</div>
          <nav class="sidebar-nav">
            <a class="sidebar-item" data-key="repository" href="repository.html"><span class="sidebar-item-glyph"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M3 10h14M10 3c1.9 2.1 2.7 4.4 2.7 7s-.8 4.9-2.7 7c-1.9-2.1-2.7-4.4-2.7-7S8.1 5.1 10 3z"/></svg></span><span class="sidebar-item-label">Public repository</span></a>
            <a class="sidebar-item" data-key="issues" href="issues.html"><span class="sidebar-item-glyph"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="1.6" fill="currentColor" stroke="none"/></svg></span><span class="sidebar-item-label">Issues</span></a>
          </nav>
          <div class="sidebar-section-title">Help</div>
          <nav class="sidebar-nav">
            <button class="sidebar-item" onclick="openInfoModal()"><span class="sidebar-item-glyph"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M8.1 8.1a2 2 0 1 1 2.7 1.9c-.5.2-.8.6-.8 1.1v.4M10 13.9h.01"/></svg></span><span class="sidebar-item-label">How to use AIOrc</span></button>
            <a class="sidebar-item" data-key="docs" href="faq.html"><span class="sidebar-item-glyph"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 2.8h6.5L15 6.3v10.9H5z"/><path d="M11.5 2.8v3.5H15M7.6 10h4.8M7.6 13h4.8"/></svg></span><span class="sidebar-item-label">Documentation</span></a>
      <a class="sidebar-item" data-key="benchmarks" href="benchmarks.html" title="Benchmarks"><span class="sidebar-item-glyph"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 16.5h13"/><path d="M5.5 16.5V11M10 16.5V6M14.5 16.5V8.5"/></svg></span><span class="sidebar-item-label">Benchmarks</span></a>
          </nav>
          <div class="sidebar-footer">
            <div class="sidebar-user" style="font-weight:600">${userNickname ? '@' + esc(userNickname) : esc(userEmail)}</div>
            <div class="sidebar-user" style="font-size:0.74rem;opacity:0.6">${esc(userEmail)}</div>
            <a href="#" class="sidebar-logout" id="logout-btn">Log out</a>
          </div>
        </aside>`;
    if (active) html = html.replace(`data-key="${active}"`, `data-key="${active}" aria-current="page"`).replace(new RegExp('class="sidebar-item"([^>]*data-key="' + active + '")'), 'class="sidebar-item active"$1');
    return html;
  }

  const PUBLIC_LINKS = [
    ['docs', 'faq.html', 'Documentation'],
    ['benchmarks', 'benchmarks.html', 'Benchmarks'],
    ['repository', 'repository.html', 'Public repository'],
    ['about', 'index.html#origen', 'About'],
  ];
  function publicNavHTML(active) {
    const links = PUBLIC_LINKS.map(([k, href, label]) => `<a href="${href}"${k === active ? ' aria-current="page"' : ''}>${label}</a>`).join('');
    return `<nav class="site-nav"><div class="site-nav-inner">
      <a href="index.html" class="site-nav-logo">AI<span>Orc</span></a>
      <div class="site-nav-links">${links}</div>
      <div class="site-nav-cta"><a href="index.html#login" class="site-nav-login">Log in</a><a href="index.html#register" class="site-nav-start">Get started</a></div>
    </div></nav>`;
  }

  // Sidebar behaviour: collapse (shared key with the workspace pages), log out, invitations badge.
  function wireSidebar() {
    const KEY = 'aiorc.sidebar.collapsed';
    const apply = () => {
      const c = localStorage.getItem(KEY) === '1';
      document.getElementById('sidebar')?.classList.toggle('collapsed', c);
      const b = document.getElementById('sidebar-toggle'); if (b) b.textContent = c ? '›' : '‹';
    };
    window.toggleSidebar = () => { localStorage.setItem(KEY, localStorage.getItem(KEY) === '1' ? '0' : '1'); apply(); };
    apply();
    document.getElementById('logout-btn')?.addEventListener('click', (e) => { e.preventDefault(); localStorage.clear(); window.location.href = 'index.html'; });
    const token = localStorage.getItem('token');
    if (token) fetch('/invitations/incoming', { headers: { Authorization: 'Bearer ' + token } })
      .then((r) => (r.ok ? r.json() : [])).then((list) => {
        const n = (list || []).filter((i) => i.status === 'pending').length;
        const badge = document.getElementById('team-badge');
        if (badge && n > 0) { badge.textContent = n; badge.style.display = ''; }
      }).catch(() => {});
  }

  function mount() {
    const el = document.getElementById('shell-mount');
    if (!el) return false;
    const active = el.getAttribute('data-active') || '';
    const signedIn = !!localStorage.getItem('token');
    if (signedIn) { document.body.classList.add('has-sidebar'); el.outerHTML = sidebarHTML(active); wireSidebar(); }
    else { el.outerHTML = publicNavHTML(active); }
    return signedIn;
  }

  window.SiteShell = { sidebarHTML, publicNavHTML, wireSidebar, mount, esc };
})();
