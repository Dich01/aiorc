// Grade the benchmark: for each seeded case, verify its signed export, take
// the final findings and compare them with what was seeded.
//
// Works for both execution modes:
// - verified (stepped): findings of the last completed step, the End reached
//   is the server's outcome, completed agents come from the verified steps.
// - compiled (megaprompt): there are no verified steps; findings, the End and
//   the path come from the model's SELF-DECLARED report (checked against its
//   hash in the chain, never against what actually ran).
//
// usage: ts-node --transpile-only benchmarks/code-review/grade.ts <out dir> <public key pem>
//        BENCH_CASES=<cases file> (required; case files with real code stay outside this repository)
//        <out dir> holds exports/ and logs/ (run.sh's BENCH_OUT, or the work dir)
import fs from 'fs';
import path from 'path';
import { verifyExport } from '../../src/lib/auditExport';
import { keyId, publicKeyFromPem } from '../../src/lib/auditKeys';
import { gradeEval, matchFindings, severityRank, FindingMatcher } from '../../src/lib/evalGrading';

interface Case { id: string; kind: 'defect' | 'clean'; summary: string; expected: FindingMatcher[] }
interface Finding { severity: string; file: string; category: string; title: string }
const [work, pemFile] = process.argv.slice(2);
if (!process.env.BENCH_CASES) { console.error('set BENCH_CASES to the cases file (kept outside this repository)'); process.exit(2); }
const casesFile = path.resolve(process.env.BENCH_CASES);
const spec = JSON.parse(fs.readFileSync(casesFile, 'utf8')) as { cases: Case[]; max_extra_findings: Record<string, number> };
const pub = publicKeyFromPem(fs.readFileSync(pemFile!, 'utf8'));
const keys = new Map([[keyId(pub), pub]]);

const readIf = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');

// "End: changes-requested", "End \"changes-requested\"", "changes-requested" → changes-requested
function endOf(text: unknown): string {
  return String(text ?? '').replace(/^\s*End\s*:?\s*/i, '').replace(/^["'*]+|["'*.\s]+$/g, '').trim();
}

const rows: Record<string, any>[] = [];
for (const c of spec.cases) {
  const file = path.join(work!, 'exports', `${c.id}.json`);
  const seconds = Number(readIf(path.join(work!, 'logs', `${c.id}.seconds`)) || 0);
  let cost: number | null = null, turns: number | null = null, outTokens: number | null = null, inTokens: number | null = null;
  try {
    const cj = JSON.parse(readIf(path.join(work!, 'logs', `${c.id}.claude.json`)));
    cost = typeof cj.total_cost_usd === 'number' ? cj.total_cost_usd : null;
    turns = typeof cj.num_turns === 'number' ? cj.num_turns : null;
    const u = cj.usage ?? {};
    inTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) || null;
    outTokens = u.output_tokens ?? null;
  } catch { /* no Claude JSON kept for this case */ }
  if (!fs.existsSync(file)) { rows.push({ id: c.id, kind: c.kind, verdict: 'NO RUN', seconds, cost, turns }); continue; }

  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const v = verifyExport(doc, keys);
  const p = doc.payload;
  const mode: string = v.mode ?? p.run.mode ?? 'stepped';
  let findings: Finding[];
  let agents: Set<string>;
  let status: string;
  let outcome: string;
  if (mode === 'compiled') {
    const rep = (p.self_declared_report ?? {}) as { findings?: unknown; path?: unknown; ended_at?: unknown };
    findings = (Array.isArray(rep.findings) ? rep.findings : []) as Finding[];
    agents = new Set(Array.isArray(rep.path) ? rep.path.filter((x): x is string => typeof x === 'string') : []);
    // The grader treats a reported run as finished so findings can be compared;
    // the verdict column says "self-declared" so nobody mistakes it for verified.
    status = p.run.status === 'reported' ? 'completed' : p.run.status;
    outcome = endOf(rep.ended_at);
  } else {
    const last = Math.max(0, ...p.steps.map((s: { step: number }) => s.step));
    findings = p.steps.filter((s: { step: number }) => s.step === last).flatMap((s: { output: { findings?: unknown[] } }) => s.output?.findings ?? []) as Finding[];
    agents = new Set<string>(p.steps.map((s: { agent: string }) => s.agent));
    status = p.run.status;
    outcome = p.run.outcome ?? '';
  }
  const verdict = gradeEval(
    { expected_outcome: '', must_complete_agents: [], expected_findings: c.expected, max_extra_findings: spec.max_extra_findings[c.kind] ?? null },
    { status: status as any, outcome, completedAgents: agents, findings }
  );
  const detected = matchFindings(c.expected, findings).matched;
  const serious = findings.filter(f => severityRank(f.severity) >= severityRank('medium')).length;
  rows.push({
    id: c.id, kind: c.kind, mode,
    verdict: v.ok ? (verdict.pass ? 'PASS' : 'FAIL') : 'BAD EXPORT',
    status: p.run.status, outcome, detected: `${detected}/${c.expected.length}`, findings: findings.length, serious,
    agents_on_path: agents.size,
    verified_steps: p.steps.length,
    seconds, cost, turns, in_tokens: inTokens, out_tokens: outTokens,
    reasons: [...v.errors, ...verdict.reasons].join('; '),
    top: findings.slice(0, 3).map(f => `${f.severity}/${f.category} ${f.file}: ${f.title}`).join(' | '),
  });
}

const defects = rows.filter(r => r.kind === 'defect');
const clean = rows.filter(r => r.kind === 'clean');
const ran = rows.filter(r => r.verdict !== 'NO RUN');
// A defect case is caught when every seeded defect in it was matched ("2/2", not "1/2").
const caught = defects.filter(r => typeof r.detected === 'string' && r.detected.split('/')[0] === r.detected.split('/')[1]).length;
const sum = (k: string) => ran.reduce((n, r) => n + (typeof r[k] === 'number' ? r[k] : 0), 0);
const median = (xs: number[]) => { const s = xs.filter(x => x > 0).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

console.log(JSON.stringify({
  rows,
  summary: {
    mode: ran[0]?.mode ?? null,
    runs: ran.length,
    pass: rows.filter(r => r.verdict === 'PASS').length,
    bad_exports: rows.filter(r => r.verdict === 'BAD EXPORT').length,
    defects: defects.length, caught,
    blockedDefects: defects.filter(r => r.outcome === 'changes-requested').length,
    clean: clean.length,
    cleanBlocked: clean.filter(r => r.outcome === 'changes-requested').length,
    cleanSeriousFindings: clean.reduce((n, r) => n + Number(r.serious ?? 0), 0),
    seconds_total: sum('seconds'), seconds_median: median(ran.map(r => r.seconds)),
    cost_usd_total: Math.round(sum('cost') * 100) / 100,
    turns_median: median(ran.map(r => r.turns ?? 0)),
    verified_steps_total: sum('verified_steps'),
  },
}, null, 2));
