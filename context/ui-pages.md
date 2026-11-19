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

Keep this file up to date when a page or shared file is added, renamed or removed.
