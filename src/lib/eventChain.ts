// Pure hash-chain primitives (no database), shared by the server and by the
// offline verifier (npm run audit:verify), which must run without a database.
import { canonicalJson, sha256 } from './canonicalJson';

export const GENESIS_HASH = '0'.repeat(64);

// The exact bytes an event's hash covers.
export function eventHash(prevHash: string, e: { run_id: string; seq: number; type: string; payload: unknown; at: number }): string {
  return sha256(prevHash + canonicalJson({ run_id: e.run_id, seq: e.seq, type: e.type, payload: e.payload, at: e.at }));
}

// Recompute a chain. Returns the problems found (empty when intact).
export function checkChain(runId: string, events: { run_id: string; seq: number; type: string; payload: unknown; at: number; prev_hash: string; hash: string }[]): string[] {
  const errors: string[] = [];
  let prev = GENESIS_HASH;
  events.forEach((e, i) => {
    if (e.run_id !== runId) errors.push(`event ${i + 1} belongs to another run`);
    if (e.seq !== i + 1) errors.push(`event ${i + 1} has seq ${e.seq}: events are missing or reordered`);
    if (e.prev_hash !== prev) errors.push(`event ${e.seq} does not link to the previous event`);
    const expected = eventHash(prev, e);
    if (e.hash !== expected) errors.push(`event ${e.seq} (${e.type}) was altered: its hash does not match its content`);
    prev = e.hash;
  });
  return errors;
}
