// Deterministic eval grading — pure, no DB, unit-testable.
//
// Eval runs execute through the stepped engine, so everything graded here is
// server-verified ground truth: the outcome reached and the agents actually
// dispatched. No LLM judges its own work.

export interface EvalCriteria {
  expected_outcome: string;   // substring matched against the outcome ('' = any completion passes)
  must_run_agents: string;    // comma-separated agent names that must have executed
}

export interface EvalRunFacts {
  completed: boolean;         // the run reached an End (not cut by a cap, not still active)
  outcome: string;            // EngineState.outcome
  executedAgents: Set<string>;
}

export interface EvalVerdict {
  pass: boolean;
  reasons: string[];          // empty when pass
}

const norm = (s: string) => s.trim().toLowerCase();

export function parseMustRun(raw: string): string[] {
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

export function gradeEval(criteria: EvalCriteria, facts: EvalRunFacts): EvalVerdict {
  const reasons: string[] = [];

  if (!facts.completed) {
    reasons.push(`the run did not complete (${facts.outcome || 'no outcome recorded'})`);
  }

  if (facts.completed && criteria.expected_outcome.trim()) {
    const expected = norm(criteria.expected_outcome);
    const got = norm(facts.outcome);
    if (!got.includes(expected) && !expected.includes(got)) {
      reasons.push(`expected outcome "${criteria.expected_outcome}" but the run ended in "${facts.outcome || '(empty)'}"`);
    }
  }

  const executed = new Set([...facts.executedAgents].map(norm));
  const missing = parseMustRun(criteria.must_run_agents).filter(a => !executed.has(norm(a)));
  if (missing.length > 0) {
    reasons.push(`required agents never executed: ${missing.join(', ')}`);
  }

  return { pass: reasons.length === 0, reasons };
}
