# filter

Filter the verified findings with the fixed rule.

1. Pass the verifier's output of the previous step, exactly as you handed it
   back, on standard input (the edit tools of some clients refuse to write
   inside `.git`, so do not write it to a file yourself):

   ```bash
   python3 "$AIORC_DIR/scripts/filter_findings.py" filter --run-id <runId> --findings - <<'JSON'
   <the verifier output, unchanged>
   JSON
   ```

   The script keeps a copy of what it received in the run folder.
2. If two findings share an id, the script renames the later one
   (`corr-1-review-blind`): use the ids of its output from here on.
3. Hand back its JSON exactly as printed.

The server routes on `blocking`: confirmed findings of a blocking severity
go to the fixer; otherwise the flow moves on to the explanation. Findings
that are not blocking stay in the list and reach the pull request.
