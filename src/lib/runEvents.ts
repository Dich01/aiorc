import db from '../db/client';
import { canonicalJson, sha256 } from './canonicalJson';

// Hash-chained run events. Must be called inside the same transaction as the
// state change it records, so the log and the state can never disagree.

export type RunEventType =
  | 'run.started'
  | 'step.dispatched'
  | 'step.completed'
  | 'transition.taken'
  | 'tool.called'
  | 'run.completed'
  | 'run.capped'
  | 'run.cancelled'
  | 'run.failed';

export interface RunEvent {
  run_id: string;
  seq: number;
  type: RunEventType;
  payload: Record<string, unknown>;
  at: number;
  prev_hash: string;
  hash: string;
}

export const GENESIS_HASH = '0'.repeat(64);

// The exact bytes an event's hash covers.
export function eventHash(prevHash: string, e: { run_id: string; seq: number; type: string; payload: unknown; at: number }): string {
  return sha256(prevHash + canonicalJson({ run_id: e.run_id, seq: e.seq, type: e.type, payload: e.payload, at: e.at }));
}

export function appendEvent(runId: string, type: RunEventType, payload: Record<string, unknown>, at = Date.now()): RunEvent {
  const last = db.prepare('SELECT seq, hash FROM run_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1').get(runId) as { seq: number; hash: string } | undefined;
  const seq = (last?.seq ?? 0) + 1;
  const prev = last?.hash ?? GENESIS_HASH;
  const hash = eventHash(prev, { run_id: runId, seq, type, payload, at });
  db.prepare('INSERT INTO run_events (run_id, seq, type, payload_json, at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(runId, seq, type, canonicalJson(payload), at, prev, hash);
  return { run_id: runId, seq, type, payload, at, prev_hash: prev, hash };
}

export function loadEvents(runId: string): RunEvent[] {
  return (db.prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY seq ASC').all(runId) as { run_id: string; seq: number; type: RunEventType; payload_json: string; at: number; prev_hash: string; hash: string }[])
    .map(r => ({ run_id: r.run_id, seq: r.seq, type: r.type, payload: JSON.parse(r.payload_json), at: r.at, prev_hash: r.prev_hash, hash: r.hash }));
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
