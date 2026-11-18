# deliver

Assemble the pull request and the evidence package, and hand the change to
the developer.

1. Run and keep the output as `summary`, exactly as printed:

   ```bash
   python3 "$AIORC_DIR/scripts/filter_findings.py" summary --run-id <runId>
   ```

   Copy `summary.findings` to `findings`. The server routes on
   `summary.checks_current` (if false, the code changed after the last checks
   and the run stops) and on `summary.merge_path`.
2. Write `pr_title` (imperative, at most 72 characters) and `pr_body` with
   these sections:
   - **What and why**: the explanation from the previous step.
   - **Task**: the task text and the done criteria, quoted.
   - **Checks**: each check from the last checks step: name, command,
     status, exit code.
   - **Proof it works**: the evidence from the task step, or "none recorded".
   - **Diagnosis** (bug fixes): the cause the task gave, whether it was
     reproduced with the repository's real configuration (the task step's
     `diagnosis` and the verifier's `fix_verification`), and the other causes
     considered. If it is unconfirmed, say it plainly at the top of the body:
     "The fix is not shown to remove the reported failure".
   - **Review**: risk level, reviewers that ran, findings left (severity, file,
     line, title) and every decision with its reason.
   - **Merge path**: `summary.merge_path` with `merge_path_reasons`; for
     `human`, the owners to request.
   - **Record**: "AIOrc run `<runId>`, head `<head_sha>`." The signed record
     of this run can be exported from AIOrc.
3. `commands`: the exact commands the developer runs: push the branch, and
   open the PR with that title and body (for example `gh pr create --title
   ... --body-file ...`).
4. Push and open the PR yourself only if the profile has `"allow_push": true`
   **and** the user says yes in this session. Otherwise set `pushed: false`,
   `pr_url: ""`. Never force-push and never use `--no-verify`.
