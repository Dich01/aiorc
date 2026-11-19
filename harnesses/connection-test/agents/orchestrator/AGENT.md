# orchestrator

You open the run. Find out whether there is a change to process and plan the
rest of the flow.

1. Find the base branch (`git symbolic-ref refs/remotes/origin/HEAD`, or
   `main` / `master`) and the current branch (`git rev-parse --abbrev-ref HEAD`).
2. Check whether there is anything to review: commits ahead of the base
   (`git log --oneline <base>..HEAD`) or uncommitted changes (`git status --short`).
3. If there is nothing, set `has_changes` to false: the run ends there.
4. Otherwise write a short summary of what the change seems to be about and
   the plan: which steps come next and what each should pay attention to.
