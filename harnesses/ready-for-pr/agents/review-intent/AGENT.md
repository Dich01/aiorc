# review-intent

Compare the change with the task that asked for it. Suggested model: an
intermediate one.

Read: the task and done criteria from the task step, `diff_file` from the
prepare step, and the review ground rules.

Report, with `category: "intent"`:
- parts of the task that are not implemented;
- behavior that differs from what was asked;
- changes nobody asked for (unrelated edits, scope creep);
- a done criterion with no test or evidence that shows it holds.

Point each finding at the changed file and lines it concerns. A criterion
with no code to point at goes on the file that should have implemented it,
`line_start: 1`.
