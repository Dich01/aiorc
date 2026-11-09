// Deterministic eval grading: pure, no DB. Graded only from facts the server
// recorded itself (the run_events chain and the outputs it accepted). No
// model judges its own work and nothing is compared by substring.

export const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type Severity = typeof SEVERITIES[number];

export interface FindingMatcher {
  min_severity?: Severity;
  [field: string]: unknown;   // every other key must equal the finding's field exactly
}

export interface EvalCriteria {
  expected_outcome: string;            // exact End outcome; '' = any End
  must_complete_agents: string[];      // agent names that must have a COMPLETED step
  expected_findings: FindingMatcher[]; // each must match a distinct finding of the final output
  max_extra_findings: number | null;   // findings beyond the matched ones; null = no limit
}

export interface EvalRunFacts {
  status: 'completed' | 'capped' | 'cancelled' | 'failed' | 'active';
  outcome: string;
  completedAgents: Set<string>;
  findings: unknown[];                 // findings[] of the final step's output(s)
}

export interface EvalVerdict {
  pass: boolean;
  reasons: string[];
  matched?: number;
  extra?: number;
}

export function severityRank(s: unknown): number {
  return typeof s === 'string' ? SEVERITIES.indexOf(s.toLowerCase() as Severity) : -1;
}

export function matchesFinding(m: FindingMatcher, f: unknown): boolean {
  if (!f || typeof f !== 'object') return false;
  const finding = f as Record<string, unknown>;
  for (const [k, v] of Object.entries(m)) {
    if (k === 'min_severity') {
      const want = severityRank(v);
      if (want < 0 || severityRank(finding.severity) < want) return false;
      continue;
    }
    if (JSON.stringify(finding[k]) !== JSON.stringify(v)) return false;
  }
  return true;
}

// Assign each matcher a distinct finding. Maximum bipartite matching (small
// inputs), so the result never depends on the order findings arrived in.
export function matchFindings(matchers: FindingMatcher[], findings: unknown[]): { matched: number; unmatched: FindingMatcher[] } {
  const owner = new Array<number>(findings.length).fill(-1);
  const tryAssign = (mi: number, seen: boolean[]): boolean => {
    for (let fi = 0; fi < findings.length; fi++) {
      if (seen[fi] || !matchesFinding(matchers[mi]!, findings[fi])) continue;
      seen[fi] = true;
      if (owner[fi] === -1 || tryAssign(owner[fi]!, seen)) { owner[fi] = mi; return true; }
    }
    return false;
  };
  const unmatched: FindingMatcher[] = [];
  let matched = 0;
  matchers.forEach((_, mi) => { if (tryAssign(mi, new Array(findings.length).fill(false))) matched++; else unmatched.push(matchers[mi]!); });
  return { matched, unmatched };
}

export function gradeEval(c: EvalCriteria, f: EvalRunFacts): EvalVerdict {
  const reasons: string[] = [];
  if (f.status !== 'completed') {
    reasons.push(`the run did not reach an End (status ${f.status}${f.outcome ? `: ${f.outcome}` : ''})`);
  } else if (c.expected_outcome && f.outcome !== c.expected_outcome) {
    reasons.push(`expected End "${c.expected_outcome}" but the run ended at "${f.outcome}"`);
  }

  const missing = c.must_complete_agents.filter(a => !f.completedAgents.has(a));
  if (missing.length) reasons.push(`agents that never completed a step: ${missing.join(', ')}`);

  const { matched, unmatched } = matchFindings(c.expected_findings, f.findings);
  for (const m of unmatched) reasons.push(`expected finding not reported: ${JSON.stringify(m)}`);
  const extra = f.findings.length - matched;
  if (c.max_extra_findings !== null && extra > c.max_extra_findings) {
    reasons.push(`${extra} finding(s) beyond the expected ones (at most ${c.max_extra_findings} allowed)`);
  }
  return { pass: reasons.length === 0, reasons, matched, extra };
}

// ── Stored criteria ────────────────────────────────────────────────────────

export function parseCriteria(row: { expected_outcome: string; must_complete_agents: string; expected_findings: string; max_extra_findings: number | null }): EvalCriteria {
  const arr = (s: string) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
  return {
    expected_outcome: row.expected_outcome,
    must_complete_agents: arr(row.must_complete_agents).filter((x: unknown): x is string => typeof x === 'string'),
    expected_findings: arr(row.expected_findings),
    max_extra_findings: row.max_extra_findings,
  };
}

// Validate criteria coming from the API or a harness file.
export function checkCriteria(input: { must_complete_agents?: unknown; expected_findings?: unknown; max_extra_findings?: unknown }): string | null {
  const a = input.must_complete_agents;
  if (a !== undefined && (!Array.isArray(a) || a.some(x => typeof x !== 'string'))) return 'must_complete_agents must be an array of agent names';
  const f = input.expected_findings;
  if (f !== undefined) {
    if (!Array.isArray(f)) return 'expected_findings must be an array';
    for (const m of f) {
      if (!m || typeof m !== 'object' || Array.isArray(m)) return 'each expected finding must be an object';
      const ms = (m as Record<string, unknown>).min_severity;
      if (ms !== undefined && severityRank(ms) < 0) return `min_severity must be one of ${SEVERITIES.join(', ')}`;
    }
  }
  const x = input.max_extra_findings;
  if (x !== undefined && x !== null && (typeof x !== 'number' || !Number.isInteger(x) || x < 0)) return 'max_extra_findings must be a non-negative integer or null';
  return null;
}
