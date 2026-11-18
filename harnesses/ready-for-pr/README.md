# ready-for-pr

A harness that leaves a change ready for its pull request before it is
pushed: the risk comes from a fixed rule, the repository's own checks run,
a detector stops changes that weaken tests or CI, reviewers look at it in
parallel, a verifier tries to refute each finding, the author's agent fixes
what is blocking (at most three rounds), and the pull request gets an
explanation and the evidence. The goal is that the reviewer gets a clean
change with its proof, or that a normal change needs no reviewer at all.

It is language- and repository-agnostic. Everything specific to a
repository lives in one file, the **profile**, attached as a context.

## The flow

```
start → task → risk → checks ⇄ fix-checks (≤5)
                        ↓
                     prepare → [2 reviewers | 5 reviewers | none] → verifier → filter
                        ↑                                                       ↓
                        └──────────────── fix-findings (≤3) ←── blocking ───────┤
                                                                                ↓
                                                              explain → deliver → End
```

| End | Meaning |
|---|---|
| `ready` | Normal change: the author can merge once CI is green. |
| `ready-human-review` | Sensitive path, or a blocker the author rejected: a person from the owning team approves. |
| `ready-auto-merge` | Only files in `auto_paths` (docs): can merge on green CI. |
| `split-change` | Over the size limits: split it into smaller pull requests. |
| `needs-human` | The change weakens tests or CI: a person decides. |
| `fixer-stuck` | The fixer could not make progress. |
| `needs-profile` | The profile defines no checks: nothing could be verified. |
| `checks-stale` | The code changed after the last checks. |
| `no-changes`, `needs-task`, `setup-error` | Nothing to do, no task or done criteria, setup failed. |
| run `capped` | A fourth round of fixes was needed: the developer rethinks the solution. |

### Who decides what

| Piece | Kind | Notes |
|---|---|---|
| Order of steps, caps, parallel joins, routing | AIOrc server | Enforced: a step cannot be skipped, an invalid output is refused. |
| Risk, depth, merge path, blocking, weakening | Python scripts | Fixed rules; the server routes on their output. |
| Repository checks | Your commands, run by `checks.py` | From the profile. |
| Reviews, verification, fixes, explanation | The model | Opinions; only verified blocking findings block. |

**Known limit.** The scripts are run by the model, which relays their
output. The server checks the shape of that output (including the script's
SHA-256), not that the script really ran. The official result is still CI:
this harness makes the change arrive at CI clean and explained.

## Set it up on an AIOrc server

```bash
npm run harness:apply -- harnesses/ready-for-pr      # prints the project key once
```

Then, in the project's settings, **enable executable files**
(`PATCH /projects/:id/executable-files {"allow": true}`): the scripts and
`profile.json` are delivered to the model only with it on. Without it the
first step stops with `setup-error`.

## Use it on a repository: fork it

1. Fork the `ready-for-pr` project in AIOrc.
2. In the fork, enable executable files again (a fork does not copy it).
3. Create a context for the repository with a `CONTEXT.md` and a
   `profile.json` (fields below) and attach it to the fork. Domain knowledge
   the reviewers need (business rules, invariants) can go in the same context
   or another one.
4. Connect Claude Code to the fork (the project's Connect AI tab), and add a
   line to the repository's `CLAUDE.md` saying to run the AIOrc flow before
   opening a pull request. `extras/ready-for-pr.md` is an optional slash
   command for that.
5. Optional hard limits: `extras/claude-settings.example.json`.

A fork does not copy the eval cases or the executable-files setting. If you
fork your own project, its agents get a "(fork)" suffix.

## The profile

```json
{
  "base_branch": "origin/main",
  "checks": [
    { "name": "types", "command": "npx tsc --noEmit", "timeout_seconds": 300 },
    { "name": "lint", "command": "npx eslint {changed_files:*.ts,*.tsx}" },
    { "name": "tests", "command": "npm test" },
    { "name": "secrets", "command": "gitleaks git --log-opts=origin/main..HEAD", "required": true },
    { "name": "mutation", "command": "npx stryker run --mutate {changed_files}", "required": false }
  ],
  "sensitive_paths": ["src/auth/**", "src/payments/**", "migrations/**", ".github/workflows/**", ".claude/**"],
  "auto_paths": ["**/*.md", "docs/**"],
  "test_paths": ["**/*.test.*", "tests/**"],
  "ci_paths": [".github/workflows/**"],
  "coverage_config_paths": ["jest.config.*", "package.json"],
  "max_changed_lines": 600,
  "max_changed_files": 40,
  "full_review_levels": ["sensitive"],
  "block_severities": ["high", "critical"],
  "owners": [{ "paths": ["src/payments/**"], "team": "payments" }],
  "allow_push": false
}
```

| Field | Meaning | Default |
|---|---|---|
| `base_branch` | Branch the change is compared with | `origin/HEAD`, then main/master |
| `checks` | Commands, in order, cheapest first. The first required failure stops the rest. `{changed_files}` becomes the changed files; `{changed_files:*.py,*.pyi}` only those matching (a check with no match is skipped). `required: false` reports without failing. | none (the run ends at `needs-profile`) |
| `sensitive_paths` | Globs that need a person and get all five reviewers | none |
| `auto_paths` | Globs that need no review when they are all a change touches | docs and markdown |
| `test_paths`, `ci_paths`, `coverage_config_paths` | Where the weakening detector looks | common layouts |
| `max_changed_lines`, `max_changed_files` | Above either, the change must be split | 600, 40 |
| `full_review_levels` | Risk levels that get the five reviewers | `["sensitive"]` |
| `block_severities` | Severities that block when confirmed (secrets always do) | high, critical |
| `owners` | Team per path, listed in the pull request for sensitive changes | none |
| `allow_push` | Let the last step push and open the PR, after the user says yes | false |

Globs: `*` stays inside a directory, `**` crosses directories, and a pattern
without `/` matches the file name anywhere.

## Where things are written

Only under `$(git rev-parse --absolute-git-dir)/aiorc/`, never in the
working tree: the scripts, the profile, one folder per run (diffs, check
logs, findings, decisions), the marker of the last passing checks, and
`rejected.json`, the findings the team rejected, which later runs stop
reporting. The task step makes one local `wip:` commit and the fixer one
commit per round; nothing is pushed unless the profile allows it and the user
agrees.

## Evals

`extras/make_fixture.py` builds a demo repository for each eval case
(`--list` shows them). The example profile in `contexts/repo-profile` fits
it. Run a case from inside its repository with `workflow.start {"evalCase":
"<id>"}`; the server grades the run from its event chain.

## Scripts

All in `skills/harness-scripts/`, Python 3.8+ with only the standard library.
Each one documents its arguments and output at the top. They can be run by
hand from any repository, for example
`python3 skills/harness-scripts/classify_risk.py --profile my-profile.json`.
