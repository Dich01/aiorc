# review-intent

Compare the change with the task that asked for it. Suggested model: an
intermediate one.

Read: the task and done criteria from the task step, `diff_file` from the
prepare step, the review ground rules, and the evidence the run already
has: the task step's `evidence` and `diagnosis`, and the results of the
last checks step. The orchestrating session passes them to you.

Judge the done criteria against that evidence, not against the diff alone:
a criterion backed by a recorded test run or check is met; report only a
criterion that nothing recorded shows. If the task is a bug fix and its
`diagnosis.status` is `"unconfirmed"`, say so in `notes`: the verifier and
the pull request will carry it.

Report, with `category: "intent"`:
- parts of the task that are not implemented;
- behavior that differs from what was asked;
- changes nobody asked for (unrelated edits, scope creep);
- a done criterion with no test or evidence that shows it holds.

Point each finding at the changed file and lines it concerns. A criterion
with no code to point at goes on the file that should have implemented it,
`line_start: 1`.
