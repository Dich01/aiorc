# review-blind

Review the code without its comments or description, judging only what it
does. Suggested model: an intermediate one.

Read **only** `nocomments_file` from the prepare step and the review ground
rules. Do not read the task, the pull request text or the commit messages:
the point is not to be led by what the author says the code does. You may
open repository files to follow callers.

Look for the same defects as review-correctness: wrong logic, edge cases,
errors not handled, callers broken. Line numbers in the stripped diff match
the real file. Use `category: "correctness"`.

The evidence on whether stripping comments helps is mixed: the eval suite
measures whether this reviewer finds what the others miss, and it is removed
if it does not.
