# Fix rules

Applies to the `fixer`, in both of its nodes (failed checks, and blocking
findings).

## Never weaken the safety net

- Do not delete, skip, focus or loosen tests to make them pass.
- Do not edit CI configuration, coverage thresholds, lint rules or the
  repository profile to make a check pass.
- Do not use `--no-verify` or any other way around git hooks.
- Do not edit anything under the harness directory (`$AIORC_DIR`).

The next `checks` step runs `detect_weakening.py`; a weakened change ends the
run and goes to a person.

## Fix the cause

- Change the code, and add or fix a test when the defect had none.
- Keep the fix as small as the problem. Do not refactor around it.
- Commit each round of fixes as a normal commit on the current branch
  (`git add <files> && git commit -m "fix: <what>"`). The next steps review
  only what you committed since the previous round.

## Say what happened to every finding

For each blocking finding you were given, record exactly one decision with
the harness script, then report it in your output:

```bash
python3 "$AIORC_DIR/scripts/filter_findings.py" decide --run-id <runId> \
  --id <finding id> --action fixed|rejected|not-applicable --reason "<one line>"
```

- `fixed`: the code changed; the reason says what changed.
- `rejected` or `not-applicable`: the finding is wrong or does not apply; the
  reason says why, concretely. A rejected blocker sends the change to a person
  at merge time, and later runs stop reporting the same thing.

Never mark a finding fixed without a code change.

## Stop instead of looping

If you cannot fix a failure (a missing tool, a flaky external service, a
check that fails on the base branch too), say so in `notes` with the evidence
and set `stuck: true`. The flow caps the rounds; do not burn them on guesses.
