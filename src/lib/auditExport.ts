import { KeyObject } from 'crypto';
import { canonicalJson, sha256 } from './canonicalJson';
import { checkChain, GENESIS_HASH } from './eventChain';
import type { RunEvent } from './runEvents';
import { verifyBytes } from './auditKeys';

// Signed audit export (format aiorc.audit.v2) and its verification.
// v2 adds run.mode and self_declared_report: a compiled (model-orchestrated mode) run
// exports no verified steps, only the report the model posted, whose hash is
// checked against the report.received event. The format bump makes an old
// verifier (or runner) fail closed instead of treating such a run as reviewed. The
// verifier is pure: it needs only the export and a public key, so it runs
// the same way in the server (POST /audit/verify) and offline
// (npm run audit:verify).

export const EXPORT_FORMAT = 'aiorc.audit.v2';

export interface ExportPayload {
  format: string;
  engine_version: string;
  run: { id: string; project_id: string; project_name: string; mode: string; status: string; outcome: string | null; end_node: string | null; created_at: number };
  identity: { verified: { user_id: string; email: string } | null; declared: string | null; declared_is_verified: false };
  review: { repo: string | null; base_sha: string | null; head_sha: string | null; pr_number: number | null; diff_sha256: string | null };
  input: unknown;
  input_sha256: string;
  manifest: { flow_sha256: string; entities: { kind: string; id: string; name: string; sha256: string }[] };
  steps: { step: number; node: string; agent: string; sha256: string; output: unknown }[];
  self_declared_report: unknown;   // compiled runs only: the model's own report, NOT verified; null otherwise
  events: RunEvent[];
  chain_head: string;
  eval: { case_id: string; verdict: string; reasons: unknown } | null;
  exported_at: string;
}

export interface SignedExport {
  payload: ExportPayload;
  signature: { alg: 'Ed25519'; kid: string; value: string };
}

export interface VerifyResult {
  ok: boolean;
  errors: string[];
  kid?: string;
  mode?: string;   // 'stepped' (server-orchestrated) | 'compiled' (self-declared report)
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

// What ties a run to the code it reviewed, taken from the run input.
export function reviewBinding(input: unknown): ExportPayload['review'] {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const pr = i.pr_number;
  return {
    repo: str(i.repo),
    base_sha: str(i.base_sha),
    head_sha: str(i.head_sha),
    pr_number: typeof pr === 'number' && Number.isInteger(pr) ? pr : null,
    diff_sha256: str(i.diff_sha256),
  };
}

export function verifyExport(doc: unknown, keys: Map<string, KeyObject>): VerifyResult {
  const errors: string[] = [];
  const d = doc as Partial<SignedExport> | null;
  if (!d || typeof d !== 'object' || !d.payload || !d.signature) return { ok: false, errors: ['not an AIOrc audit export: payload or signature missing'] };
  const p = d.payload;
  if (p.format !== EXPORT_FORMAT) errors.push(`unknown export format "${String(p.format)}"`);

  // 1. Signature over the canonical payload.
  const key = keys.get(d.signature.kid);
  if (d.signature.alg !== 'Ed25519') errors.push(`unsupported signature algorithm "${String(d.signature.alg)}"`);
  if (!key) errors.push(`no public key for kid "${String(d.signature.kid)}"`);
  else if (!verifyBytes(canonicalJson(p), d.signature.value, key)) errors.push('signature does not match the payload: the export was altered or signed by another key');

  // 2. The event chain, recomputed from scratch.
  const events = Array.isArray(p.events) ? p.events : [];
  if (events.length === 0) errors.push('the export contains no events');
  errors.push(...checkChain(p.run?.id ?? '', events));
  const head = events.length ? events[events.length - 1]!.hash : GENESIS_HASH;
  if (p.chain_head !== head) errors.push('chain_head does not match the last event');

  // 3. Everything else must agree with what the chain recorded.
  const started = events.find(e => e.type === 'run.started');
  const mode = String((started?.payload as { mode?: unknown } | undefined)?.mode ?? 'stepped');
  if (!started) errors.push('the chain has no run.started event');
  else {
    if (p.run?.mode !== mode) errors.push(`run.mode "${String(p.run?.mode)}" differs from the mode recorded at run.started ("${mode}")`);
    const sp = started.payload as { input_sha256?: string; flow_sha256?: string; entities?: { kind: string; id: string; sha256: string }[] };
    if (sha256(canonicalJson(p.input)) !== p.input_sha256) errors.push('input_sha256 does not match the input');
    if (sp.input_sha256 !== p.input_sha256) errors.push('the input differs from the one recorded at run.started');
    if (sp.flow_sha256 !== p.manifest?.flow_sha256) errors.push('the flow hash differs from the one recorded at run.started');
    const recorded = new Map((sp.entities ?? []).map(e => [`${e.kind}:${e.id}`, e.sha256]));
    for (const e of p.manifest?.entities ?? []) {
      if (recorded.get(`${e.kind}:${e.id}`) !== e.sha256) errors.push(`manifest entry ${e.kind} "${e.name}" differs from the one recorded at run.started`);
    }
    if ((p.manifest?.entities ?? []).length !== recorded.size) errors.push('the manifest lists a different set of entities than run.started');
  }

  const completed = new Map<string, string>();
  for (const e of events.filter(x => x.type === 'step.completed')) {
    const ep = e.payload as { step: number; outputs: { node: string; sha256: string }[] };
    for (const o of ep.outputs ?? []) completed.set(`${ep.step}:${o.node}`, o.sha256);
  }
  for (const s of p.steps ?? []) {
    const h = sha256(canonicalJson(s.output));
    if (h !== s.sha256) errors.push(`the output of step ${s.step} (${s.node}) was altered`);
    if (completed.get(`${s.step}:${s.node}`) !== s.sha256) errors.push(`the output of step ${s.step} (${s.node}) is not the one recorded in the chain`);
  }
  if ((p.steps ?? []).length !== completed.size) errors.push('the export lists a different set of step outputs than the chain');

  // A self-declared report must be the one whose hash the chain recorded.
  const received = events.find(e => e.type === 'report.received');
  if (mode === 'compiled') {
    if ((p.steps ?? []).length > 0) errors.push('a compiled run cannot carry verified step outputs');
    if (received) {
      const want = (received.payload as { report_sha256?: string }).report_sha256;
      if (sha256(canonicalJson(p.self_declared_report ?? null)) !== want) errors.push('self_declared_report is not the report recorded in the chain');
    } else if (p.self_declared_report !== null && p.self_declared_report !== undefined) {
      errors.push('self_declared_report is present but the chain recorded no report');
    }
  } else if (received || (p.self_declared_report !== null && p.self_declared_report !== undefined)) {
    errors.push('a server-orchestrated run cannot carry a self-declared report');
  }

  return { ok: errors.length === 0, errors, kid: d.signature.kid, mode };
}
