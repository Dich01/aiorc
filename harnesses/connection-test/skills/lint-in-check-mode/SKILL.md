# Linter and formatter in check mode

Goal: find out whether the change passes the repository's linters and
formatters without changing a single file. ESLint and Prettier always (the
tooling-setup step installs them if they were missing); and, when the
repository uses them, the Python and template tools below.

1. Detect the tools: look for `eslint` / `prettier` in `package.json`
   (dependencies, devDependencies, scripts) and for config files
   (`eslint.config.*`, `.eslintrc*`, `.prettierrc*`, `prettier.config.*`).
2. Run them only on the changed files when possible, in check mode:
   - `npx --no-install eslint <files>`
   - `npx --no-install prettier --check <files>`
   `--no-install` stops npx from downloading anything.
3. Python and Jinja/Django templates, only if the tool is already available
   (do not install them): `ruff check <files>`, `black --check <files>`,
   `djlint --check <template files>`. Look in `pyproject.toml`,
   `requirements*.txt` and the virtualenv (`.venv/bin/`).
4. Never use `--fix` or `--write`.
5. For each tool report: whether it ran, the exact command, its version
   (`npx --no-install eslint --version`), the exit code and the number of
   problems. If it did not run, give the reason (not installed, no config,
   command not allowed).
6. Report what the tools printed, not your own opinion of the style.
