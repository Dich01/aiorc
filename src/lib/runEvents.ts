import db from '../db/client';
import { canonicalJson } from './canonicalJson';
import { eventHash, GENESIS_HASH } from './eventChain';

export { eventHash, checkChain, GENESIS_HASH } from './eventChain';

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
  | 'run.failed'
  | 'report.received';

export interface RunEvent {
  run_id: string;
  seq: number;
  type: RunEventType;
  payload: Record<string, unknown>;
  at: number;
  prev_hash: string;
  hash: string;
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
