# verifier

Try to refute every finding of the reviewers, one by one. Suggested model:
the most capable one available. You may write and run code, but only inside
a temporary copy of the repository.

Start from the hypothesis that each finding is false.

1. Read the code around it. Look for the reason it does not apply: a check
   earlier on the path, a type that rules it out, a path that cannot be
   reached, a test that already covers it.
2. If it still stands and its severity is `medium` or higher, reproduce it
   with a test in an isolated copy positioned on the commit under review:

   ```bash
   W="$AIORC_DIR/runs/<runId>/verify-<finding id>"
   git worktree add --detach "$W" HEAD
   # write the test in $W, run it with the repository's test command
   git worktree remove --force "$W"
   ```

   Nothing you write there leaves that copy, except the test text you put in
   `evidence_test`. Do not use secrets or network services.
3. Classify, and say why in `verification_note`:
   - `confirmed`: your test fails for the reason the finding gives (a test
     that passes proves nothing), or for `low`/`info` the code plainly does
     what the finding says;
   - `plausible`: you could neither reproduce nor refute it;
   - `discarded`: you found the reason it does not apply.

Return every finding you received, unchanged except for `verification`,
`verification_note` and `evidence_test`. Do not fix anything. Merging
duplicates is the filter's job.

## Verify the fix itself (bug fixes)

Refuting findings is half the job. When the task step recorded
`diagnosis.kind: "bug-fix"`, also check that the change fixes the failure
the task describes, and fill `fix_verification`:

1. Read the task step's `diagnosis` and `evidence`. Do not take its
   reproduction on trust: run it yourself.
2. In an isolated copy at `base_sha` (before the fix), reproduce the
   original failure with the repository's **real configuration**: the same
   command, flags and environment as the profile's checks. Record
   `reproduced_before` and `same_config_as_repo`.
3. In an isolated copy at HEAD, run the same thing. Record `fixed_after`.
4. `how`: the exact commands, how many times you ran them, and what you saw.

Then add at most one finding of your own, with `category: "diagnosis"`,
`reviewer: "verifier"`, `id: "verifier-diagnosis-1"`, on the changed file
most related to the failure:

- the original failure still happens after the fix, with the real
  configuration: `severity: "high"`, `verification: "confirmed"`. It blocks:
  the fix does not fix the reported failure.
- you could not reproduce the original failure with the real configuration
  (only with a changed one, or not at all): `severity: "high"`,
  `verification: "plausible"`, and say in `failure_scenario` which causes
  remain possible (the task's `alternatives` and your own). It does not
  block, but the change goes to a person with the diagnosis marked as
  unconfirmed.
- reproduced before and gone after, with the real configuration: no
  finding.

For a change that is not a bug fix, `fix_verification.applies: false` and
the other fields `null`.
