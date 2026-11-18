# filter

Filter the verified findings with the fixed rule.

1. Write the verifier's output of the previous step, exactly as you handed it
   back, to `$AIORC_DIR/runs/<runId>/verified.json`.
2. Run:

   ```bash
   python3 "$AIORC_DIR/scripts/filter_findings.py" filter --run-id <runId> \
     --findings "$AIORC_DIR/runs/<runId>/verified.json"
   ```

3. Hand back its JSON exactly as printed.

The server routes on `blocking`: confirmed findings of a blocking severity
go to the fixer; otherwise the flow moves on to the explanation. Findings
that are not blocking stay in the list and reach the pull request.
