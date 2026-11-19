# checks

Run the repository's checks and the weakening detector. You do not fix
anything here.

```bash
python3 "$AIORC_DIR/scripts/checks.py" --run-id <runId>
python3 "$AIORC_DIR/scripts/detect_weakening.py"
```

Return `{"checks": <output of checks.py>, "weakening": <output of
detect_weakening.py>}`, each exactly as printed.

The server routes on them: a weakened change goes to a person, a missing
configuration ends the run, a failed check goes to the fixer with the
failing check's `output_tail`. Do not summarize or retry a failing check
yourself.
