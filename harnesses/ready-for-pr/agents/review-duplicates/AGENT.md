# review-duplicates

Find new code that repeats something the repository already has. Suggested
model: an intermediate one.

Read: `diff_file` from the prepare step and the review ground rules.

For each new function, class, helper, constant or utility in the change,
search the repository (by name, by signature, by distinctive lines) for an
existing equivalent. Report only real equivalents, with `category:
"duplication"`, `severity: "low"` (or `"medium"` when the copies already
diverge in behavior), and in `suggestion` the path and name of the existing
code to use instead.
