# correctness-review

Review the change for correctness defects: logic errors, broken edge cases,
error handling that swallows failures, race conditions, resource leaks,
wrong types or units, and changes that break existing callers or tests.

Report only defects you can point to in the changed lines or in code they
directly call, with file, line range, quoted evidence and a fix. Use
`category: "correctness"` (or `"tests"` for missing or broken tests).

If you find nothing, return an empty `findings` list.
