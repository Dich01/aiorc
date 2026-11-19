# Harness scripts

The deterministic steps of this flow are Python scripts that come with this
skill (the files below `SKILL.md`). A script decides; you only run it and
hand back what it printed. Never compute a script's answer yourself.

## Where they live

Everything goes under the repository's git directory, never in the working
tree, so nothing the harness writes appears in the change under review:

```bash
AIORC_DIR="$(git rev-parse --absolute-git-dir)/aiorc"
```

- `$AIORC_DIR/scripts/`: the scripts. The `task` step writes them there.
- `$AIORC_DIR/profile.json`: the repository profile. The `task` step writes it there.
- `$AIORC_DIR/runs/<runId>/`: everything a run produces (diffs, logs, findings).

## Writing them (the `task` step)

1. `mkdir -p "$AIORC_DIR/scripts"`.
2. Write each `.py` file of this skill to `$AIORC_DIR/scripts/<file name>`,
   byte for byte as given. Do not fix, reformat or "improve" anything.
3. Run `python3 "$AIORC_DIR/scripts/common.py" manifest` and hand back its
   `scripts` list unchanged: it is the SHA-256 of every file you wrote, so the
   signed record shows exactly which code ran.

If the scripts below are shown as withheld ("Non-Markdown file withheld"),
the project does not deliver files to the model: stop the `task` step with
`status: "setup-error"` and say that the project owner must enable
executable files for this project.

## Running one

- Run from the repository root, always with `--run-id <the runId of this run>`
  where the script takes it.
- `python3` is the only requirement. If it is missing, report `setup-error`
  in the `task` step.
- The script prints one JSON object. Hand it back **exactly as printed**, as
  the value the step's output contract names. Do not add, drop, rename or
  reword fields; do not round numbers.
- Exit code 2 means the script could not run: its JSON has an `error`. That is
  not a result. Fix the cause if it is yours (wrong directory, missing
  `--run-id`) and run it again; otherwise stop and tell the user.
- Never edit a script, never pass a different profile, never run a script
  from another location.

## The scripts

| Script | Used by | Decides |
|---|---|---|
| `common.py` | every script | shared code; `manifest` lists hashes |
| `classify_risk.py` | `risk` | risk level, review depth, merge path |
| `checks.py` | `checks` | whether the repository's checks pass |
| `detect_weakening.py` | `checks` | whether the change weakens tests or CI |
| `prepare_diff.py` | `prepare` | what the reviewers read, review depth |
| `filter_findings.py` | `filter`, `fixer`, `deliver` | blocking, decisions, summary |
