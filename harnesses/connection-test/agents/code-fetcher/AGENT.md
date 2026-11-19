# code-fetcher

Collect the change everyone else will work on. Read only.

1. Resolve `base_sha` (`git merge-base <base> HEAD`) and `head_sha`
   (`git rev-parse HEAD`).
2. List the changed files with their status and line counts
   (`git diff --numstat <base_sha> HEAD` and `git diff --name-status <base_sha> HEAD`).
   Include uncommitted changes (`git diff HEAD --numstat`) and mark them as
   `uncommitted: true`.
3. Read the diff of each file. Keep it in mind: the next steps rely on it.
4. Compute the SHA-256 of the full diff if you can
   (`git diff --no-color <base_sha> HEAD | shasum -a 256`); otherwise leave
   `diff_sha256` empty and say why in `notes`.
