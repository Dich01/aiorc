import db from '../db/client';
import { Run } from '../db/schema';
import { canonicalJson, sha256 } from './canonicalJson';
import { auditKey, signBytes } from './auditKeys';
import { EXPORT_FORMAT, ExportPayload, reviewBinding, SignedExport } from './auditExport';
import { loadEvents, GENESIS_HASH } from './runEvents';
import { snapshotHashes } from '../orchestrator/snapshot';
import { ENGINE_VERSION } from '../orchestrator/engine';

// Builds the signed export of one run from the append-only event chain, the
// frozen snapshots and the stored outputs. The signature is Ed25519 over the
// canonical JSON of the payload.
export function buildSignedExport(runId: string): SignedExport | null {
  const run = db.prepare('SELECT r.*, p.name AS project_name FROM runs r JOIN projects p ON p.id = r.project_id WHERE r.id = ?')
    .get(runId) as (Run & { project_name: string }) | undefined;
  if (!run) return null;

  let input: unknown = null;
  try { input = JSON.parse(run.input); } catch { input = run.input; }
  const hashes = snapshotHashes(runId);
  const events = loadEvents(runId);
  const steps = (db.prepare('SELECT step, node_id, agent_name, output_json, sha256 FROM run_step_outputs WHERE run_id = ? ORDER BY step, node_id').all(runId) as { step: number; node_id: string; agent_name: string; output_json: string; sha256: string }[])
    .map(o => ({ step: o.step, node: o.node_id, agent: o.agent_name, sha256: o.sha256, output: JSON.parse(o.output_json) as unknown }));

  const payload: ExportPayload = {
    format: EXPORT_FORMAT,
    engine_version: ENGINE_VERSION,
    run: {
      id: run.id, project_id: run.project_id, project_name: run.project_name,
      status: run.status, outcome: run.outcome || null, end_node: run.end_node || null, created_at: run.created_at,
    },
    identity: {
      verified: run.caller_user_id ? { user_id: run.caller_user_id, email: run.caller_email } : null,
      declared: run.declared_caller || null,
      declared_is_verified: false,
    },
    review: reviewBinding(input),
    input,
    input_sha256: sha256(canonicalJson(input)),
    manifest: {
      flow_sha256: hashes.find(h => h.kind === 'flow')?.sha256 ?? '',
      entities: hashes.filter(h => h.kind !== 'flow').map(h => ({ kind: h.kind, id: h.entity_id, name: h.name, sha256: h.sha256 })),
    },
    steps,
    events,
    chain_head: events.length ? events[events.length - 1]!.hash : GENESIS_HASH,
    eval: run.eval_case_id ? { case_id: run.eval_case_id, verdict: run.eval_verdict, reasons: run.eval_reasons ? JSON.parse(run.eval_reasons) : null } : null,
    exported_at: new Date().toISOString(),
  };
  const key = auditKey();
  return { payload, signature: { alg: 'Ed25519', kid: key.kid, value: signBytes(canonicalJson(payload), key) } };
}
