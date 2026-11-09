# Contributing to AIOrc

Thanks for considering a contribution. AIOrc is early stage (v0.1) and small enough that a single well-scoped PR can move it meaningfully.

## Getting set up

Requires Node 20 or newer. `better-sqlite3` compiles a native module, so on Linux you may need `build-essential` and `python3`.

```bash
npm install
npm run build:flow   # builds the React Flow editor bundle (required for the flow editor UI)
npm run dev          # API + UI on http://localhost:3001
```

There is no seed: a new database has no users. Create an admin, and load the reference harness if you want something to run:

```bash
AIORC_ADMIN_EMAIL=you@example.com AIORC_ADMIN_PASSWORD='at-least-12-chars' npm run admin:create
npm run harness:apply -- harnesses/code-review
```

Open `http://localhost:3001` and log in. If your local database was created by an older build, the server refuses to start; run it once with `AIORC_DB_RESET=1` (the old file is kept as `*.bak`). Local data is test data: there are no migrations.

## Running the checks

```bash
npm test             # unit tests and integration tests against the real app
npm run build        # tsc typecheck + emit
npm run build:flow   # Vite build of the editor bundle
```

All three run in CI on Node 20 and 22. Please make sure they pass locally before opening a PR.

The test runner is a small custom harness (`src/tests/harness.ts`, entry point `src/tests/run.ts`) — there is no Jest or Vitest. Unit tests live in `src/tests/unit/`, integration tests in `src/tests/integration/`; add a file there and import it from `run.ts`. Integration tests mount the real app on an ephemeral port against a throwaway database (`src/tests/env.ts`), and talk to it with `api()` and `mcp()` from `src/tests/integration/helpers.ts`. A behavior change to the engine or the MCP surface needs an integration test that drives it over MCP.

## Project layout

| Path | What lives there |
|---|---|
| `src/routes/` | Express route handlers, one file per resource |
| `src/shared/flow.ts` | Flow model, transition rules and graph validation, imported by the server and the editor |
| `src/orchestrator/` | The execution engine — run snapshots, step dispatch, output validation, transitions, invocation caps |
| `src/mcp/` | MCP server (`workflow.start`, `workflow.next`, `workflow.eval`) over JSON-RPC 2.0, with ajv-validated arguments |
| `src/lib/` | Audit chain and signing, eval grading, outbound guard, canonical JSON, usage |
| `src/db/` | Schema (single `CREATE_TABLES_SQL`, versioned) and SQLite client (WAL mode) |
| `src/harness/`, `harnesses/` | Harness loader/applier, and the reference `code-review` harness |
| `src/scripts/` | `admin:create`, `harness:apply`, `audit:verify` |
| `runners/` | Review runners for before and after a pull request |
| `src/middleware/` | JWT auth and project-key auth |
| `public/` | Vanilla HTML/JS/CSS pages — no build step |
| `src-frontend/flow-editor/` | React Flow editor, bundled by Vite into `public/` |

## Conventions

- **TypeScript** on the backend. Keep types explicit at module boundaries.
- **Schema changes** go into `CREATE_TABLES_SQL` and bump `SCHEMA_VERSION` in `src/db/schema.ts`. There are no in-place migrations.
- **Harness changes** (prompts, schemas, flows, evals) are files under `harnesses/`; run `npm run harness:apply -- <dir> --dry-run` to validate them.
- **The server never calls an LLM.** AIOrc is the contract and the auditor; the consuming model does the work. A PR that adds an LLM dependency to the server path is very unlikely to be merged.
- **Existing code comments and test names are in Spanish.** You are welcome to write new comments in English or Spanish — please don't translate existing ones as part of an unrelated PR.
- **No emoji in UI copy, labels or code.**
- Match the style of the file you're editing rather than introducing a new one.

## Never commit a database

`data/` is gitignored and holds real runtime data. `*.db`, `*.db-wal`, `*.db-shm` and `*.bak` files must never enter a commit — they contain user emails, password hashes and project API keys. If you think you may have committed one, say so in the PR before it gets merged; it is far easier to fix before it lands.

Likewise: `.env`, `.jwt-secret`, `.audit-ed25519.key` and any `*.key` or `*.pem` are ignored and must stay that way.

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
