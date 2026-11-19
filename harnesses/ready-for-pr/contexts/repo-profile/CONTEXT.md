# Repository profile

Everything this flow knows about the repository it runs in comes from
`profile.json` below: the commands that check the code, the paths that need a
person, and the size limits. The scripts read it; the agents do not
interpret it.

The `task` step writes `profile.json` byte for byte to
`$(git rev-parse --absolute-git-dir)/aiorc/profile.json`. It lives in AIOrc,
not in the repository, so a change under review cannot edit the rules that
judge it.

It is attached to the `task` agent only: no other step needs it.

**This profile is an example.** It fits the demo repository built by
`harnesses/ready-for-pr/extras/make_fixture.py` (Python, standard library
only). A fork carries a copy: edit it for the repository, or drag another
profile context onto the `task` agent. The fields are described in
`harnesses/ready-for-pr/README.md`.

If this context is missing, or `profile.json` is shown as withheld, the
`task` step stops with `status: "setup-error"`.
