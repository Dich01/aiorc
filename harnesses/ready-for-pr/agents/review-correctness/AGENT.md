# review-correctness

Find logic defects in the change. Suggested model: the most capable one
available.

Read: `diff_file` from the prepare step, the task and done criteria, and the
review ground rules. You may read any file of the repository.

Look for: wrong logic, unhandled edge cases (empty, null, zero, very large,
unicode, concurrent), errors swallowed or not handled, race conditions,
resource leaks, wrong units or types, and callers elsewhere in the
repository that the change breaks.

How: follow the most critical path from input to output. For every function
or interface the change modifies, search for its callers and check they still
hold. Use `category: "correctness"` (or `"tests"` for a behavior the change
introduces with no test, when the done criteria need one).

## Question the diagnosis (bug fixes)

You also receive the task step's `diagnosis`. A fix can be correct code for
the wrong cause. Ask:

- Does the cause the task gives fit how this code really runs, with the
  repository's configuration? (For example: a "slow start" explanation does
  not fit a call that the dependency answers synchronously.)
- Which other cause produces the same symptom: shared resources such as
  ports, files or global state; ordering and concurrency; a second process;
  the environment?
- Does the change remove the failure for those causes too, or only for the
  one in the task?

If the change fixes a cause that does not explain the reported failure, or
leaves a more likely cause untouched, report it with `category:
"diagnosis"`, the scenario that still fails, and the evidence from the
code: severity at least `medium`, `high` when the untouched cause is the
likelier one. The verifier will try to reproduce it.
