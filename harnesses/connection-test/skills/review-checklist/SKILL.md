# Review checklist

For each changed file, check:

- Correctness: logic errors, unhandled errors, edge cases (empty, null,
  very large inputs), off-by-one, wrong types.
- Security: injection (SQL, command, path), secrets in code, missing
  authorization checks, unsafe use of user input.
- Tests: does the change need tests that are missing or broken?
- Readability: only when it hides a real defect. Style is the linter's job.

Every finding cites the file, the line range and evidence quoted from the
diff. Do not report code that the change does not touch. An empty list of
findings is a valid answer.
