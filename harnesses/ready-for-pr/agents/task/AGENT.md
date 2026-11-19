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
7. **Diagnosis.** Fill `diagnosis`. For a bug fix (`kind: "bug-fix"`), the
   cause the task gives ("it fails because X") is a **hypothesis**, not a
   fact, even when the user wrote it:
   - `claimed_cause`: the cause as the task or the developer states it.
   - Reproduce the original failure **the way the repository really runs**:
     the same test command, flags, configuration and environment as the
     profile's checks and CI, on the commit before the fix (a temporary
     `git worktree` at `base_sha` keeps the working copy untouched).
   - `reproduction`: the exact command, `same_config_as_repo`, and what
     happened. If you had to change the configuration to make it fail (other
     flags, a slower or faked dependency, a timing knob the repository does
     not use), set `same_config_as_repo: false` and describe the change in
     `config_changes`: a failure provoked that way shows the symptom can
     happen, not that it is the cause.
   - `status: "confirmed"` only when the failure was reproduced with the
     repository's own configuration and the fix makes it go away; otherwise
     `"unconfirmed"`, with the reason in `notes`. `"not-applicable"` for a
     feature, refactor or docs change (`reproduction: null`).
   - `alternatives`: other causes that would produce the same symptom, and
     whether you ruled each one out and how. Look at least at shared
     resources (ports, files, global state), ordering and concurrency, and
     the environment.
   An unconfirmed diagnosis does not stop the run: it is reported, and the
   change goes to a person.
8. Return `status: "ready"` with `head_sha` (`git rev-parse HEAD`) and
   `base_ref`.
