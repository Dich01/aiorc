# AIOrc review runners

Two ways to run the `code-review` harness (`harnesses/code-review`) against an
AIOrc server: on a developer machine before a pull request exists, and in
GitHub Actions after it is opened. Both drive Claude Code in non-interactive
mode with read-only tools, and both decide what happened from the server's
signed audit export, never from what the model says.

Flags used, checked against `claude --help` (Claude Code 2.1.319):
`-p`, `--mcp-config`, `--strict-mcp-config`, `--tools`, `--allowedTools`
(rules such as `Bash(git diff *)`, and `mcp__aiorc` for every tool of that
server), `--permission-mode dontAsk`, `--output-format json`, `--model`,
`--max-budget-usd`.

## Before the pull request

`pre-pr/aiorc-review.sh` reviews `git merge-base <base> HEAD..HEAD`:

```bash
export AIORC_URL=https://aiorc.example.com
export AIORC_PROJECT_KEY=aiorc_pk_...       # key of code-review-pre-pr
export AIORC_TOKEN=aiorc_pat_...            # optional: verified identity
runners/pre-pr/aiorc-review.sh --base origin/main --out review.json
npm run audit:verify -- review.json --key aiorc-public.pem
```

It computes `base_sha`, `head_sha`, `changed_files` and the SHA-256 of
`git diff base head`, writes a temporary MCP config (mode 0600) that points
Claude Code at `$AIORC_URL/mcp` with the project key, runs Claude Code with
only `Read`, `Grep`, `Glob`, `git diff/log/show` and the AIOrc tools, then asks
the server (`GET /api/runs?head_sha=`) which run it was and downloads its
export (`GET /api/runs/:id/export`). Exit code 0 means the run reached an End.

- `pre-pr/pre-push`: optional git hook. Never blocks by default and lets the
  push through on any failure. With `AIORC_PRE_PUSH_BLOCK=1` it blocks only
  when the final findings contain a `critical` finding or a secret.
- `pre-pr/claude-command/aiorc-review.md`: slash command for interactive use.
  Copy it to `.claude/commands/` in the repository to review.

## After the pull request

`github/aiorc-review.yml` is a workflow template. In the repository to review:

1. Copy it to `.github/workflows/aiorc-review.yml`.
2. Copy `pre-pr/aiorc-review.sh` and `github/publish.mjs` to `.github/aiorc/`.
3. Secrets: `AIORC_PROJECT_KEY` (key of `code-review-post-pr`), `AIORC_TOKEN`
   (personal access token of a CI account), `ANTHROPIC_API_KEY`.
   Variables: `AIORC_URL`, `AIORC_AUDIT_PUBLIC_KEY` (the PEM from
   `GET $AIORC_URL/audit/keys`, pinned), optionally `AIORC_TEST_COMMAND`.

The `review` job (`contents: read`) runs gitleaks, semgrep and the tests,
records their tool, version, exit code and report hash as the deterministic
gates, runs the review, and uploads the export as an artifact. The `publish`
job (`pull-requests: write`, `checks: write`) checks out only `publish.mjs`
from the base commit, verifies the export (signature, hash chain, outputs,
and that it reviewed the PR's head commit) and publishes one updatable
comment, inline comments and a `neutral` check `aiorc/review`. It never
approves or requests changes.

Pull requests from forks and from bots are skipped, so untrusted code never
runs with the secrets. Same-repository pull requests can edit the workflow
and the runner script themselves; that is true of any workflow and is why
the publishing job does not trust the review job's output without verifying
its signature.

`github/publish.mjs --dry-run` prints what it would publish without calling
GitHub.
