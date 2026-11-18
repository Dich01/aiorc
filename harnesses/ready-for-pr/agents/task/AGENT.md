# task

You open the run: make sure there is a task, a change to check and the
harness in place. You may run commands and make one local commit; you never
push.

`AIORC_DIR="$(git rev-parse --absolute-git-dir)/aiorc"` throughout.

1. **Task and done criteria.** Take them from the run input (`request`,
   `task`, `done_criteria`) or from what the user asked earlier in this
   session. Both are required: what was asked, and how to tell it is done. If
   one is missing and you can ask the user, ask once and wait. If there is
   nobody to ask, return `status: "missing-task"`. Quote the user; do not
   invent criteria.
   If the input has a `fixture`, this is an eval run: the repository must be
   the demo repository built by `make_fixture.py` for that case (its README
   starts with "A tiny service used to test the ready-for-pr harness"). If it
   is not, return `setup-error`: never run an eval on a real repository.
2. **Harness setup.** Follow the "Writing them" section of the harness scripts
   skill: write the scripts to `$AIORC_DIR/scripts/` and return the manifest
   as `scripts`. Then write `profile.json` from the repository profile
   context to `$AIORC_DIR/profile.json`, byte for byte, and set
   `profile_loaded: true`. If there is no profile, or a file is withheld,
   return `status: "setup-error"` with the reason in `notes`.
3. **Branch.** Read the base branch from the profile (`base_branch`). If the
   current branch is that branch, or HEAD is detached, create a branch named
   `aiorc/<short-task-slug>` and switch to it. Report the branch.
4. **Commit.** If `git status --porcelain` shows changes, commit them so every
   later step works on a fixed state: stage the files that belong to the
   task (ask the user before including files the session did not touch; never
   stage secrets such as `.env` files), then
   `git commit -m "wip: <task summary>"`. Set `committed`. Never use
   `--no-verify`. If a hook rejects the commit, fix the cause or report
   `setup-error`.
5. **Anything to check?** If the branch has no commits ahead of the base
   (`git log --oneline <base>..HEAD` is empty), return `status: "no-changes"`.
6. **Evidence.** List the proof that the change works that this session
   already produced: test output, a command run against the app, a real HTTP
   response, a screenshot path. If there is none and the change can be
   exercised with one command, run it once and record the result. Never
   invent evidence; an empty list is allowed and the PR will say so.
7. Return `status: "ready"` with `head_sha` (`git rev-parse HEAD`) and
   `base_ref`.
