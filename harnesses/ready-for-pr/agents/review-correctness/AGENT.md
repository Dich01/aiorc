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
