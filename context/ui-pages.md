# Interface pages

Every page lives in `public/` and is served as is by `express.static` (`src/app.ts`), at `/<name>.html`.
There is no framework or build step for the pages, except the flow canvas (see below).
The interface is in English only, with no translation system.

## Pages

| File | Title / purpose | Opened with | Shared scripts it loads |
|---|---|---|---|
| `index.html` | Public landing page | `/` | none |
| `faq.html` | Documentation | | site-shell, info-modal, notifications |
| `compare.html` | How it compares | | site-shell, notifications |
| `benchmarks.html` | Benchmarks (reads `public/benchmarks/*.json`) | | site-shell, notifications |
| `repository.html` | Public repository (browse, fork) | | site-shell, info-modal, ui-dialogs, fork-dialog, notifications |
| `dashboard.html` | Signed-in user's main page | `?tab=projects\|agents\|skills\|contexts\|team` | ui-dialogs, fork-dialog, notifications |
| `project.html` | One project: settings, flow canvas, runs | `?id=<project>` | flow-editor.js (+ flow-editor.css), ui-dialogs, notifications |
| `history.html` | Version history of an entity | `?kind=...` | site-shell, ui-dialogs, notifications |
| `issues.html` | Bug or idea reports | `?id=<issue>` | site-shell, info-modal, ui-dialogs, notifications |
| `notifications.html` | Notifications list | | site-shell, notifications |
| `user.html` | Public profile | `?nick=<nickname>` | site-shell, info-modal, notifications |
| `analytics.html` | Usage analytics | | info-modal, notifications |
| `audit.html` | Audit log | | ui-dialogs, info-modal, notifications |
| `admin.html` | Admin panel (admins only) | | ui-dialogs, info-modal, notifications |

The two largest pages, where most changes land, are `project.html` (~3400 lines) and `dashboard.html` (~2200 lines).

## Shared files (a change here affects several pages)

| File | What it does | Used by |
|---|---|---|
| `public/style.css` | Main stylesheet | all pages |
| `public/site-shell.js` | Sidebar and public top menu | faq, compare, benchmarks, repository, history, issues, notifications, user |
| `public/notifications.js` | Notification bell | all pages except index |
| `public/ui-dialogs.js` | Confirm / prompt dialogs | dashboard, project, history, issues, repository, audit, admin |
| `public/info-modal.js` | Info popups | faq, issues, repository, user, analytics, audit, admin |
| `public/fork-dialog.js` | Fork dialog | dashboard, repository |

Pages that do not load `site-shell.js` (index, dashboard, project, analytics, audit, admin) draw their own menu,
so a menu change has to be repeated in those files too.

## Flow canvas (React)

- Source: `src-frontend/flow-editor/` (React + @xyflow/react).
- Built output: `public/flow-editor.js` and `public/flow-editor.css`. Do not edit those by hand.
- Rebuild after any change: `npm run build:flow`.
- Used only by `project.html`.

## Languages (English / Spanish)

- Pages are written in English. `public/i18n.js` translates them in the browser; the EN | ES switch is added
  to `.sidebar-footer`, `.site-nav-cta` and `.nav-cta`. The choice is kept in the `aiorc_lang` cookie.
- Every page loads `<script src="/i18n/es.js"></script><script src="/i18n.js"></script>` first thing in `<head>`.
  A new page needs those two tags too.
- Spanish text lives in `src-frontend/i18n/es/*.json` (one file per page, plus `common.json` for the shared
  scripts, `flow-editor.json` and `server.json` for API messages). Rules and terms: `src-frontend/i18n/GLOSSARY.md`.
- After adding or changing any visible English text, add its Spanish entry in the matching JSON and run
  `npm run build:i18n` (writes `public/i18n/es.js`, which is committed). Check with `?i18n-debug=1`:
  `window.__i18nMisses` lists text still in English.

Keep this file up to date when a page or shared file is added, renamed or removed.
