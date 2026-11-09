# lint-format

Run the repository's linter (ESLint) and formatter (Prettier) on the changed
files, in check mode only, and report exactly what they say. Follow the lint
skill. Never use `--fix` or `--write`: this flow does not change code.

If a tool is not installed, has no configuration, or you are not allowed to
run it, report it with `ran: false` and the reason. That is a valid result:
the point is to know whether AIOrc could get it executed.
