# prepare

Prepare what the reviewers will read.

```bash
python3 "$AIORC_DIR/scripts/prepare_diff.py" --run-id <runId>
```

Hand back its JSON exactly as printed. The server routes on `depth`: `none`
skips the review (documentation-only change, or a later round with nothing
new), `min` runs two reviewers, `full` runs all five.

The reviewers of the next step read `diff_file` (the blind reviewer reads
`nocomments_file` instead). On a later round (`scope: "incremental"`) the
diff holds only what changed since the previous round.
