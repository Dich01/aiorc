# Planned: baselines without AIOrc

Status: **not run yet.** Saved on 2026-11-09 as the next step after the
first execution-mode benchmark (public summary: `public/benchmarks.html`).

## Why

The first benchmark compared AIOrc's two execution modes on the same review
harness: 198 graded runs over 33 changes with seeded defects in a private
production codebase. Both modes found almost every defect (87/87 vs 86/87),
blocked almost the same changes (94.7 % vs 93.3 %) and raised no false
positives; model-orchestrated was about 27 % faster and 5.5 % cheaper;
server-orchestrated was the only one with evidence (990 validated, chained
outputs vs 0).

Both modes ran **through AIOrc with the same harness** (agents, domain
contexts, per-reviewer rules). So the benchmark cannot say how much of the
detection rate comes from AIOrc and how much from the model itself. These two
baselines answer that.

## The two baselines

| | What runs | Question it answers |
|---|---|---|
| **A. Model alone** | Claude Code with a plain prompt ("review this diff, list defects in this JSON format"). No AIOrc, no agents, no contexts. | How much does the whole harness add over just asking? |
| **B. Same content, no AIOrc** | The harness's agent instructions and contexts concatenated into one `CLAUDE.md` (or one prompt), no MCP server. | Is the value in the harness *content* or in the *orchestration*? |

Expected (to be confirmed, not assumed): A misses more of the complex suite
(defects that need domain rules or reading several files); B lands close to
the two AIOrc modes. If so, the honest message is: the content drives
detection; AIOrc makes that content reusable, shared, versioned and
verifiable.

## Keep everything else identical

- Same cases and seeded clones: `seed.py` with the same `BENCH_BASE`.
- Same client and model: Claude Code headless, read-only tools
  (`Read, Grep, Glob, Bash(git diff|log|show *)`), same model, same parallelism
  (3), 3 repetitions per case.
- Same grading: findings matched by file, category and minimum severity;
  same `max_extra_findings`. Use the harness finding schema as the required
  output format for both baselines, so the grader and `schemacheck.js` apply
  unchanged, and report the off-schema rate too.
- Same metrics: defects found, defect changes blocked, clean changes blocked,
  findings, off-schema findings, seconds, `total_cost_usd`, tokens, turns.
  "Blocked" for a baseline = the model's own final verdict field
  (`blocking: true`), since there is no release gate.

## What has to be built

1. **A baseline runner** (e.g. `benchmarks/<suite>/baseline.sh`): for each
   seeded clone, run Claude Code with the prompt (A) or the generated
   `CLAUDE.md` (B), no `--mcp-config`, `--output-format json`, and save:
   - the model's final JSON (`{blocking, findings[]}`) as `exports/<id>.json`,
   - Claude Code's JSON result as `logs/<id>.claude.json`,
   - wall-clock seconds as `logs/<id>.seconds`.
2. **Prompt / CLAUDE.md generator** for B: concatenate, in flow order, each
   agent's `AGENT.md`, its skills and the project contexts from the harness
   directory, plus a short "run these reviewers, then a verifier, then decide"
   instruction and the output schema. Generated from the harness so it cannot
   drift from what AIOrc runs.
3. **Grader input for baselines**: `grade.ts` reads signed exports today. Add
   a third input shape (`mode: 'baseline'`) that reads the plain JSON above:
   findings from `findings[]`, blocked from `blocking`, no signature check.
   The page and `aggregate.py` treat it as a third series.
4. **Page**: add the baselines as a third and fourth series in
   `public/benchmarks.html` (bars, comparison table, time and cost charts) and
   regenerate the anonymised data file (`public/benchmarks/*.json`). Keep the
   anonymisation rule: no codebase name, paths, commits or seeded-change
   details on public pages or public data.

## Cost and time

About 33 cases × 3 repetitions × 2 baselines = 198 runs: roughly $35–40 and
40 minutes with 3 in parallel per baseline (estimate from the first
benchmark's ~$0.47–0.50 per run; baseline A is likely cheaper).

## Open questions to settle before running

- Baseline A prompt: one fixed generic prompt for every case, written once and
  stored with the results, so nobody tunes it per case.
- Whether B should be allowed to use Claude Code sub-agents (closer to how a
  team would really run a multi-reviewer setup without AIOrc) or must stay a
  single context. Possibly run both and report them separately.
- Add a second model (e.g. a smaller/cheaper one) to see whether orchestration
  matters more when the model is weaker. This is where server-orchestrated
  step validation is most likely to show a quality difference, not only an
  evidence one.
