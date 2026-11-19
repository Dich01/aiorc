#!/usr/bin/env bash
# Run a review harness on every seeded case with Claude Code, in
# parallel, and save each run's signed export.
#
# usage: run.sh <work dir from seed.py> [parallel jobs, default 3] [case ids...]
# env:   AIORC_URL, AIORC_PROJECT_KEY (the project that runs the review harness)
#        BENCH_BASE base ref of the reviewed diff (default origin/development)
#        BENCH_OUT  where exports and logs go (default: the work dir), so the
#                   same seeded clones can be run against several projects,
#                   e.g. one in verified mode and one in compiled mode.
set -u
WORK="$1"; JOBS="${2:-3}"; shift 2 || true
HERE="$(cd "$(dirname "$0")" && pwd)"
RUNNER="$HERE/../../runners/pre-pr/aiorc-review.sh"
OUT="${BENCH_OUT:-$WORK}"
mkdir -p "$OUT/exports" "$OUT/logs"
IDS=("$@")
[ ${#IDS[@]} -eq 0 ] && IDS=($(node -e 'console.log(require(process.argv[1]).map(c=>c.id).join(" "))' "$WORK/seeded.json"))

run_case() {
  local id="$1" start end
  start=$(date +%s)
  (cd "$WORK/$id" && AIORC_CLAUDE_JSON_OUT="$OUT/logs/$id.claude.json" bash "$RUNNER" --base "${BENCH_BASE:-origin/development}" --out "$OUT/exports/$id.json") > "$OUT/logs/$id.log" 2>&1
  local rc=$?
  end=$(date +%s)
  echo "$id exit=$rc $((end-start))s"
  echo "$((end-start))" > "$OUT/logs/$id.seconds"
}
export -f run_case
export WORK RUNNER OUT BENCH_BASE
printf '%s\n' "${IDS[@]}" | xargs -P "$JOBS" -I{} bash -c 'run_case "$@"' _ {}
