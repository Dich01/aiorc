import { createHmac, timingSafeEqual, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

// Dedicated audit signing key, independent from the auth JWT secret: sharing it
// to let a third party verify an export must NOT hand out the ability to mint
// session tokens, and rotating the auth secret must NOT invalidate past exports.
let auditKey = '';
export function auditSigningKey(): string {
  if (auditKey) return auditKey;
  if (process.env.AUDIT_SIGNING_KEY) { auditKey = process.env.AUDIT_SIGNING_KEY; return auditKey; }
  const file = path.join(process.cwd(), '.audit-secret');
  try { const k = fs.readFileSync(file, 'utf8').trim(); if (k) { auditKey = k; return auditKey; } } catch { /* none yet */ }
  auditKey = randomBytes(32).toString('hex');
  try { fs.writeFileSync(file, auditKey + '\n', { mode: 0o600 }); } catch { /* ephemeral fallback */ }
  return auditKey;
}

// ── Control plane primitives — pure, unit-tested ────────────────────────────
//
// Pause semantics are SURGICAL by design:
//   - Pausing a project blocks NEW runs only. Anyone mid-execution finishes
//     their run undisturbed — a pause never yanks the rug from a teammate.
//   - To stop a specific in-flight run there is per-run cancel, which affects
//     that run and nothing else.

export interface ExecutionGate {
  allowed: boolean;
  reason: string;
}

export function gateExecution(opts: {
  action: 'start' | 'step';
  projectPaused: boolean;
  runStatus: string | null;   // 'running' | 'completed' | 'cancelled' | null (no run yet)
}): ExecutionGate {
  if (opts.runStatus === 'cancelled') {
    return { allowed: false, reason: 'Este run fue cancelado por su dueño o un admin. No se ejecutan más pasos.' };
  }
  if (opts.action === 'start' && opts.projectPaused) {
    return { allowed: false, reason: 'El proyecto está pausado por su dueño — no se aceptan runs nuevos. Los runs en curso pueden terminar.' };
  }
  return { allowed: true, reason: '' };
}

// A stepped run with no activity for longer than the threshold is considered
// abandoned (the LLM went away — MCP has no heartbeat). Abandoned is SOFT:
// if the client comes back with workflow.next, the run resumes.
export const ABANDON_THRESHOLD_MS = 2 * 3600 * 1000;

export function isAbandoned(lastActivityAt: number, now: number, thresholdMs: number = ABANDON_THRESHOLD_MS): boolean {
  return now - lastActivityAt > thresholdMs;
}

// A run stops accepting self-declared reports once it was cancelled or marked
// abandoned — otherwise a cancel wouldn't actually freeze the audit trail.
export function canAcceptReport(status: string): boolean {
  return status !== 'cancelled' && status !== 'abandoned';
}

// A run counts toward "verified" trust metrics only if it ran in stepped mode
// AND wasn't cancelled or abandoned mid-flight (those didn't complete a
// trustworthy path, so counting them inflates the verified rate dishonestly).
export function countsAsVerified(mode: string, status: string): boolean {
  return mode === 'stepped' && status !== 'cancelled' && status !== 'abandoned';
}

// ── Signed audit exports ─────────────────────────────────────────────────────
// HMAC-SHA256 over the exact serialized payload. Anyone holding the secret can
// re-verify that an exported audit trail was not altered after export.

export function signAudit(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

export function verifyAudit(payload: string, signature: string, secret: string): boolean {
  const expected = signAudit(payload, secret);
  if (expected.length !== signature.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}
