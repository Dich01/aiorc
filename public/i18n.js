// Interface translations.
//
// Every page loads, first thing in <head>:
//   <script src="/i18n/es.js"></script><script src="/i18n.js"></script>
//
// The pages are written in English. When the chosen language is not English,
// this script translates the page as it is built and whenever it changes
// (MutationObserver), using the dictionary in window.AIORC_I18N[lang]:
//   text:     { "English text": "Texto" }          exact text of a text node or attribute
//   html:     { "Click <b>Save</b>": "Pulsa <b>Guardar</b>" }   whole innerHTML of an element
//                                                   with inline markup
//   patterns: [ { re: "^(\\d+) agents$", es: "$1 agentes" } ]   text with variable parts
//   pages:    { dashboard: { text, html, patterns } }   entries for one page only; they win there
// Keys are compared with whitespace collapsed. The dictionary source lives in
// src-frontend/i18n/es/*.json; `npm run build:i18n` writes public/i18n/es.js.
//
// The choice is kept in a cookie (it survives log out, which clears localStorage).
// Changing language reloads the page. Add ?i18n-debug=1 to collect untranslated
// text in window.__i18nMisses.
(function () {
  const LANGS = { en: 'English', es: 'Español' };
  const HTML_LANG = { en: 'en', es: 'es-419' };
  const COOKIE = 'aiorc_lang';

  function readCookie() {
    const m = document.cookie.match(new RegExp('(?:^|; )' + COOKIE + '=([a-z]{2})'));
    return m ? m[1] : null;
  }
  function detect() {
    const saved = readCookie();
    if (saved && LANGS[saved]) return saved;
    const nav = (navigator.languages && navigator.languages[0]) || navigator.language || 'en';
    return /^es\b/i.test(nav) ? 'es' : 'en';
  }
  function setLang(lang) {
    if (!LANGS[lang]) return;
    document.cookie = COOKIE + '=' + lang + '; path=/; max-age=31536000; SameSite=Lax';
    window.location.reload();
  }

  const lang = detect();
  document.documentElement.setAttribute('lang', HTML_LANG[lang]);

  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
  const dict = (window.AIORC_I18N && window.AIORC_I18N[lang]) || null;
  const active = lang !== 'en' && !!dict;

  // ---- dictionary --------------------------------------------------------
  const TEXT = new Map();
  const HTML = new Map();
  const PATTERNS = [];
  if (active) {
    // Shared entries first, then this page's own, which win over the shared ones.
    const page = (location.pathname.split('/').pop() || 'index.html').replace(/\.html$/, '') || 'index';
    const pageDict = (dict.pages && dict.pages[page]) || {};
    const tpl = document.createElement('template');
    const PAGE_PATTERNS = [];
    for (const d of [dict, pageDict]) {
      for (const [k, v] of Object.entries(d.text || {})) TEXT.set(norm(k), v);
      for (const [k, v] of Object.entries(d.html || {})) {
        // Re-serialize so the key matches what the browser gives back for innerHTML.
        tpl.innerHTML = norm(k);
        HTML.set(norm(tpl.innerHTML), v);
      }
      for (const p of d.patterns || []) {
        try { (d === pageDict ? PAGE_PATTERNS : PATTERNS).push([new RegExp(p.re), p.es]); } catch (e) { console.warn('[i18n] bad pattern', p.re); }
      }
    }
    PATTERNS.unshift(...PAGE_PATTERNS);
  }

  const debug = /[?&]i18n-debug=1/.test(location.search);
  const misses = new Set();
  const produced = new Set(); // translated text, so debug mode does not report it as missing
  if (debug) {
    window.__i18nMisses = misses;
    for (const v of TEXT.values()) produced.add(norm(v));
    const tpl2 = document.createElement('template');
    for (const v of HTML.values()) { tpl2.innerHTML = v;
      const w = document.createTreeWalker(tpl2.content, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) produced.add(norm(n.data));
    }
  }

  // Translate one string. Returns null when there is no translation.
  function lookup(s) {
    const key = norm(s);
    if (!key) return null;
    if (TEXT.has(key)) return TEXT.get(key);
    for (const [re, rep] of PATTERNS) {
      if (re.test(key)) {
        return key.replace(re, (...m) => rep.replace(/\$(\d)/g, (_, i) => {
          const g = m[Number(i)];
          return g == null ? '' : (TEXT.get(norm(g)) ?? g);
        }));
      }
    }
    if (debug && /[A-Za-z]{2}/.test(key) && !produced.has(key)) misses.add(key);
    return null;
  }
  function t(s) {
    if (!active || s == null) return s;
    const r = lookup(s);
    if (r == null) return s;
    const str = String(s);
    const lead = str.match(/^\s*/)[0];
    const trail = str.match(/\s*$/)[0];
    return lead + r + trail;
  }
  window.i18n = { lang, t, setLang, languages: LANGS };

  // ---- DOM ---------------------------------------------------------------
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'KBD', 'SAMP', 'NOSCRIPT']);
  const INLINE = new Set(['B', 'STRONG', 'EM', 'I', 'U', 'A', 'SPAN', 'CODE', 'BR', 'SMALL', 'KBD', 'SUP', 'SUB', 'MARK', 'ABBR']);
  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'data-tooltip'];
  const done = new WeakMap(); // node -> value we wrote, to skip our own mutations

  function skipped(el) {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      if (SKIP_TAGS.has(e.tagName.toUpperCase())) return true;
      if (e.isContentEditable || e.getAttribute('translate') === 'no' || e.classList.contains('notranslate')) return true;
    }
    return false;
  }

  function onlyInline(el) {
    let hasEl = false;
    for (const c of el.querySelectorAll('*')) {
      if (!INLINE.has(c.tagName.toUpperCase())) return false;
      hasEl = true;
    }
    return hasEl;
  }

  function translateText(node) {
    if (done.get(node) === node.data) return;
    const r = lookup(node.data);
    if (r != null) {
      const lead = node.data.match(/^\s*/)[0];
      const trail = node.data.match(/\s*$/)[0];
      node.data = lead + r + trail;
    }
    done.set(node, node.data);
  }

  function translateAttrs(el) {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (!v || done.get(el) === a + '\u0000' + v) continue;
      const r = lookup(v);
      if (r != null) { el.setAttribute(a, r); done.set(el, a + '\u0000' + r); }
    }
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type) && el.value) {
      const r = lookup(el.value);
      if (r != null) el.value = r;
    }
  }

  function walk(root) {
    if (root.nodeType === 3) {
      if (root.parentElement && !skipped(root.parentElement)) translateText(root);
      return;
    }
    if (root.nodeType !== 1) return;
    if (root.tagName === 'TEXTAREA') { if (!skipped(root.parentElement)) translateAttrs(root); return; }
    if (skipped(root)) return;
    translateEl(root);
  }

  // Whole-element translation for text broken by inline tags. Returns true when applied.
  function tryHtml(el) {
    if (!HTML.size || !el.firstElementChild || !onlyInline(el)) return false;
    const key = norm(el.innerHTML);
    if (done.get(el) === key) return false;
    const r = HTML.get(key);
    if (r == null) return false;
    el.innerHTML = r;
    done.set(el, norm(el.innerHTML));
    for (const c of el.querySelectorAll('*')) translateAttrs(c);
    return true;
  }

  function translateEl(el) {
    translateAttrs(el);
    if (tryHtml(el)) return;
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) translateText(c);
      else if (c.nodeType === 1 && c.tagName === 'TEXTAREA') translateAttrs(c); // placeholder only, never the content
      else if (c.nodeType === 1 && !SKIP_TAGS.has(c.tagName.toUpperCase())
        && !c.isContentEditable && c.getAttribute('translate') !== 'no' && !c.classList.contains('notranslate')) translateEl(c);
    }
  }

  // ---- language switch ---------------------------------------------------
  const SWITCH_SLOTS = '.sidebar-footer, .site-nav-cta, .nav-cta';
  function mountSwitches(root) {
    const slots = [];
    if (root.matches && root.matches(SWITCH_SLOTS)) slots.push(root);
    if (root.querySelectorAll) slots.push(...root.querySelectorAll(SWITCH_SLOTS));
    for (const slot of slots) {
      if (slot.querySelector(':scope > .lang-switch')) continue;
      const box = document.createElement('div');
      box.className = 'lang-switch notranslate';
      box.setAttribute('role', 'group');
      box.setAttribute('aria-label', lang === 'es' ? 'Idioma' : 'Language');
      for (const code of Object.keys(LANGS)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = code.toUpperCase();
        b.title = LANGS[code];
        b.setAttribute('aria-pressed', String(code === lang));
        if (code === lang) b.className = 'is-active';
        b.addEventListener('click', () => { if (code !== lang) setLang(code); });
        box.appendChild(b);
      }
      slot.appendChild(box);
    }
  }
  const style = document.createElement('style');
  style.textContent = `
    .lang-switch { display:inline-flex; gap:2px; align-items:center; font-size:0.72rem; }
    .lang-switch button { background:transparent; border:1px solid transparent; color:inherit; opacity:0.55;
      font:inherit; font-weight:600; letter-spacing:0.04em; padding:2px 6px; border-radius:4px; cursor:pointer; }
    .lang-switch button:hover { opacity:0.9; }
    .lang-switch button.is-active { opacity:1; border-color:currentColor; cursor:default; }
    .sidebar.collapsed .lang-switch { flex-direction:column; }
    /* Spanish labels are longer: keep the top menus on one line. */
    html[lang^="es"] .nav-links, html[lang^="es"] .site-nav-links { gap:22px; }
    html[lang^="es"] .nav-links a, html[lang^="es"] .site-nav-links a,
    html[lang^="es"] .nav-cta button, html[lang^="es"] .site-nav-cta a { white-space:nowrap; }
  `;
  document.head ? document.head.appendChild(style) : document.documentElement.appendChild(style);

  // ---- native dialogs ----------------------------------------------------
  if (active) {
    for (const name of ['alert', 'confirm', 'prompt']) {
      const orig = window[name];
      if (typeof orig !== 'function') continue;
      window[name] = function (msg, ...rest) { return orig.call(window, t(msg), ...rest); };
    }
  }

  // ---- run ---------------------------------------------------------------
  let titleDone = null;
  function translateTitle() {
    if (!active || document.title === titleDone) return;
    const r = lookup(document.title);
    if (r != null) document.title = r;
    titleDone = document.title;
  }

  const obs = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'childList') {
        // el.innerHTML = '...' : the container itself may match an html entry.
        if (active && m.addedNodes.length && m.target.nodeType === 1 && m.target.isConnected
          && !skipped(m.target) && tryHtml(m.target)) continue;
        for (const n of m.addedNodes) {
          if (n.nodeType === 1) mountSwitches(n);
          if (active) walk(n);
        }
        if (active && m.target.nodeType === 1 && m.target.tagName === 'TITLE') translateTitle();
      } else if (!active) {
        continue;
      } else if (m.type === 'characterData') {
        const p = m.target.parentElement;
        if (p && p.tagName === 'TITLE') translateTitle();
        else if (p && !skipped(p)) translateText(m.target);
      } else if (m.type === 'attributes' && m.target.nodeType === 1
        && !skipped(m.target.tagName === 'TEXTAREA' ? m.target.parentElement : m.target)) {
        translateAttrs(m.target);
      }
    }
  });
  // Translate once the document is parsed, then watch for changes. Watching during parsing
  // would see elements half-built and translate a fragment of a sentence on its own, which
  // stops the whole-element (html) entry from matching later.
  function initial() {
    mountSwitches(document.body || document.documentElement);
    if (active) { translateTitle(); walk(document.body || document.documentElement); }
    obs.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true,
      attributes: active, attributeFilter: active ? ATTRS.concat(['value']) : undefined,
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initial);
  else initial();
})();
