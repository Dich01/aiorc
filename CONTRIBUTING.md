# Contributing to AIOrc

Thanks for considering a contribution. AIOrc is early stage (v0.1) and small enough that a single well-scoped PR can move it meaningfully.

## Getting set up

Requires Node 20 or newer. `better-sqlite3` compiles a native module, so on Linux you may need `build-essential` and `python3`.

```bash
npm install
npm run build:flow   # builds the React Flow editor bundle (required for the flow editor UI)
npm run dev          # API + UI on http://localhost:3001
```

Open `http://localhost:3001`, register a user, create a project, then add agents and draw a flow.

`npm run seed` loads sample data if you want something to look at immediately.

## Running the checks

```bash
npm test             # 42 tests — engine transitions, skip analysis, eval grading, audit signing
npm run build        # tsc typecheck + emit
npm run build:flow   # Vite build of the editor bundle
```

All three run in CI on Node 20 and 22. Please make sure they pass locally before opening a PR.

The test runner is a small custom harness in `src/tests/run.ts` — there is no Jest or Vitest. To add a test, register it in that file following the existing pattern. Tests are plain assertions against the orchestrator and library functions; they do not need a running server.

## Project layout

| Path | What lives there |
|---|---|
| `src/routes/` | Express route handlers, one file per resource |
| `src/orchestrator/` | The execution engine — graph transitions, step validation, invocation caps |
| `src/mcp/` | MCP server (`workflow.start`, `workflow.next`, `workflow`, `workflow.report`, `workflow.eval`) over JSON-RPC 2.0 |
| `src/lib/` | Control plane, skip analysis, eval grading, audit signing, tags, usage |
| `src/db/` | Schema and SQLite client (WAL mode) |
| `src/middleware/` | JWT auth and project-key auth |
| `public/` | Vanilla HTML/JS/CSS pages — no build step |
| `src-frontend/flow-editor/` | React Flow editor, bundled by Vite into `public/` |

## Conventions

- **TypeScript** on the backend. Keep types explicit at module boundaries.
- **The server never calls an LLM.** AIOrc is the contract and the auditor; the consuming model does the work. A PR that adds an LLM dependency to the server path is very unlikely to be merged.
- **Existing code comments and test names are in Spanish.** You are welcome to write new comments in English or Spanish — please don't translate existing ones as part of an unrelated PR.
- **No emoji in UI copy, labels or code.**
- Match the style of the file you're editing rather than introducing a new one.

## Never commit a database

`data/` is gitignored and holds real runtime data. `*.db`, `*.db-wal`, `*.db-shm` and `*.bak` files must never enter a commit — they contain user emails, password hashes and project API keys. If you think you may have committed one, say so in the PR before it gets merged; it is far easier to fix before it lands.

Likewise: `.env`, `.jwt-secret`, `.audit-secret` and any `*.key` or `*.pem` are ignored and must stay that way.

## Pull requests

1. Open an issue first for anything larger than a bugfix, so we can agree on the approach before you spend time.
2. Branch off `development`, not `main`.
3. Keep the PR focused on one thing. Unrelated cleanups are welcome, but as separate PRs.
4. Explain what changed and how you verified it. If it touches the orchestrator, say which test covers the new behavior.
5. Add or update tests for behavior changes.

## Areas where help is most useful

- **Postgres support** alongside SQLite — currently single-node only, and this is the main thing blocking larger deployments.
- **Broader test coverage**, especially routes and the MCP surface.
- **Docs**: the MCP integration path is the hardest part to get right from the README alone.
- **Accessibility** in the vanilla pages under `public/`.

## Reporting security issues

Please do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
