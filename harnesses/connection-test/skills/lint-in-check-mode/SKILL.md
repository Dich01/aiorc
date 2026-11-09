# Linter and formatter in check mode

Goal: find out whether the change passes the repository's linter (ESLint)
and formatter (Prettier) without changing a single file.

1. Detect the tools: look for `eslint` / `prettier` in `package.json`
   (dependencies, devDependencies, scripts) and for config files
   (`eslint.config.*`, `.eslintrc*`, `.prettierrc*`, `prettier.config.*`).
2. Run them only on the changed files when possible, in check mode:
   - `npx --no-install eslint <files>`
   - `npx --no-install prettier --check <files>`
   `--no-install` stops npx from downloading anything.
3. Never use `--fix` or `--write`.
4. For each tool report: whether it ran, the exact command, its version
   (`npx --no-install eslint --version`), the exit code and the number of
   problems. If it did not run, give the reason (not installed, no config,
   command not allowed).
5. Report what the tools printed, not your own opinion of the style.
