# Installing ESLint and Prettier

The only change this flow is allowed to make to the repository, and only by
the tooling-setup agent.

1. Check first. If `eslint` and `prettier` are already installed (listed in
   a `package.json` at the repository root and present in `node_modules`),
   change nothing and report `installed: false`.
2. Otherwise, at the repository root:
   - if there is no `package.json`, create it with `npm init -y`;
   - run `npm install --save-dev eslint prettier`;
   - create a config only if none exists: `eslint.config.mjs` exporting a
     minimal flat config (`export default [{ files: ["**/*.js"] }];`) and a
     `.prettierrc` containing `{}`;
   - make sure `node_modules/` is in `.gitignore` (append it if missing).
3. Do not touch any other file. Do not change source code, do not format
   anything, do not run `--fix` or `--write`.
4. Report every file you created or modified, the exact commands you ran,
   the installed versions (`npx --no-install eslint --version`,
   `npx --no-install prettier --version`) and anything that failed.
5. These files are tooling, not part of the developer's change: later steps
   must leave them out of the proposed commit and mention them separately.
