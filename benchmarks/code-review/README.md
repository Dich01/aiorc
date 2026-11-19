# Code-review benchmark tooling

Measures how well an AIOrc review harness finds **seeded defects**, in either
execution mode (server-orchestrated or model-orchestrated), from the signed
audit exports the server produces. The published results are on
`public/benchmarks.html`.

This folder holds only the tooling. **Case files and results that contain a
real codebase's code, paths or rules stay outside this repository**; the
public page and its data file (`public/benchmarks/*.json`) are anonymised.

## Pieces

| File | What it does |
|---|---|
| `seed.py` | Builds one throwaway clone per case (`git clone --no-local`, the source repository is only read) and applies the case's patches as one commit. `BENCH_BASE` pins the base commit. |
| `run.sh` | Runs every seeded case through `runners/pre-pr/aiorc-review.sh` with Claude Code, in parallel, and keeps each run's signed export, seconds and Claude Code JSON (cost, tokens, turns). `BENCH_OUT` separates outputs, so one set of clones can be run against several projects (one per mode). |
| `repeat.sh` | Repeats `run.sh` N times against one project and grades each repetition. |
| `grade.ts` | Verifies each signed export and matches its final findings against the answer key (file, category, minimum severity). Server-orchestrated runs are graded from the last validated step; model-orchestrated runs from the self-declared report. |
| `aggregate.py` | Merges graded repetitions into one dataset and checks every finding against the harness finding schema. |
| `schemacheck.js` | The schema check alone, for one set of exports. |

## Case file format

```json
{
  "source_repo": "/path/to/the/codebase",
  "base_branch": "main",
  "max_extra_findings": { "defect": 3, "clean": 1 },
  "cases": [
    {
      "id": "x01-short-name",
      "kind": "defect",
      "summary": "What was seeded and why it is wrong (the answer key).",
      "commit": "A realistic commit message that does not reveal the defect",
      "patches": [{ "file": "path/in/repo", "find": "exact text, once", "replace": "new text" }],
      "expected": [{ "file": "path/in/repo", "category": "security", "min_severity": "high" }]
    }
  ]
}
```

`kind: "clean"` cases have `"expected": []`. A patch can also be
`{ "file": "...", "create": "whole file" }`.

## Run

```
export AIORC_URL=http://localhost:3001 BENCH_BASE=<commit> \
       BENCH_CASES=/private/path/cases.json BENCH_SCHEMA=/private/path/finding.schema.json \
       BENCH_PUBKEY=<pem from GET /audit/keys>
python3 benchmarks/code-review/seed.py "$BENCH_CASES" <work>/seed
AIORC_PROJECT_KEY=<server-orchestrated project key> bash benchmarks/code-review/repeat.sh <work>/seed <work>/server 3
AIORC_PROJECT_KEY=<model-orchestrated project key>  bash benchmarks/code-review/repeat.sh <work>/seed <work>/model 3
python3 benchmarks/code-review/aggregate.py <work>/data.json suite:server:<work>/server/rep1/grade.json ...
```

Planned next: baselines without AIOrc, see `../BASELINES.md`.
