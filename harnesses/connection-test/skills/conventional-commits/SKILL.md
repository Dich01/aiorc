# Conventional Commits

Commit messages follow Conventional Commits 1.0:

```
<type>(<scope>): <subject>

<body>

<footer>
```

- `type`: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.
- `scope`: optional, the area touched (a folder or module), lowercase.
- `subject`: imperative mood ("add", not "added"), no final period,
  at most 72 characters including type and scope.
- `body`: what changed and why, wrapped at 72 columns. Not how.
- Breaking changes: `!` after the type or scope, and a
  `BREAKING CHANGE: <description>` footer.
- One commit message for the whole change. If the change mixes unrelated
  things, say so in your output and propose how to split it.
