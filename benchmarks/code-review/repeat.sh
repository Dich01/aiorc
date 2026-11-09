#!/usr/bin/env bash
# Repeat run.sh N times against one project, one repetition after another
# (repetitions of the same commit must not overlap: the runner finds its run
# by head commit and start time), then grade every repetition.
#
# usage: repeat.sh <seed dir> <out dir> <reps> [parallel jobs, default 3]
# env:   AIORC_URL, AIORC_PROJECT_KEY, BENCH_BASE, BENCH_CASES (grading), BENCH_PUBKEY (pem file)
set -u
SEED="$1"; OUT="$2"; REPS="$3"; JOBS="${4:-3}"
HERE="$(cd "$(dirname "$0")" && pwd)"
for r in $(seq 1 "$REPS"); do
  echo "== repetition $r/$REPS ($(date +%H:%M:%S))"
  BENCH_OUT="$OUT/rep$r" bash "$HERE/run.sh" "$SEED" "$JOBS"
  (cd "$HERE/../.." && npx ts-node --transpile-only benchmarks/code-review/grade.ts "$OUT/rep$r" "$BENCH_PUBKEY" > "$OUT/rep$r/grade.json" 2> "$OUT/rep$r/grade.err")
  echo "== graded $r: $(node -e 'const s=require(process.argv[1]).summary;console.log(`pass ${s.pass}/${s.runs} caught ${s.caught}/${s.defects} cleanBlocked ${s.cleanBlocked} median ${s.seconds_median}s cost $${s.cost_usd_total}`)' "$OUT/rep$r/grade.json")"
done
echo "== all repetitions done"
