// In-memory login throttling. Enough for a single node; a multi-node
// deployment would need a shared store.
//
// Failures are counted per email and per client IP inside a sliding window.
// Once either counter reaches its limit, further attempts are refused until
// the window has passed — even with the right password, so guessing gains
// nothing. A successful login clears the email counter.

export const WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILURES_PER_EMAIL = 10;
export const MAX_FAILURES_PER_IP = 20;

interface Bucket { failures: number[] }

const byEmail = new Map<string, Bucket>();
const byIp = new Map<string, Bucket>();

function recent(b: Bucket | undefined, now: number): number[] {
  if (!b) return [];
  b.failures = b.failures.filter(t => now - t < WINDOW_MS);
  return b.failures;
}

// Milliseconds until the caller may try again, or 0 when allowed now.
export function loginBlockedFor(email: string, ip: string, now = Date.now()): number {
  const e = recent(byEmail.get(email), now);
  const i = recent(byIp.get(ip), now);
  let wait = 0;
  if (e.length >= MAX_FAILURES_PER_EMAIL) wait = Math.max(wait, e[0]! + WINDOW_MS - now);
  if (i.length >= MAX_FAILURES_PER_IP) wait = Math.max(wait, i[0]! + WINDOW_MS - now);
  return wait;
}

export function recordLoginFailure(email: string, ip: string, now = Date.now()): void {
  for (const [map, key] of [[byEmail, email], [byIp, ip]] as [Map<string, Bucket>, string][]) {
    const b = map.get(key) ?? { failures: [] };
    recent(b, now);
    b.failures.push(now);
    map.set(key, b);
  }
  // Keep memory bounded under a spray of distinct emails/IPs.
  for (const map of [byEmail, byIp]) {
    if (map.size > 50_000) {
      for (const [k, b] of map) if (recent(b, now).length === 0) map.delete(k);
    }
  }
}

export function recordLoginSuccess(email: string): void {
  byEmail.delete(email);
}

export function resetLoginThrottle(): void {
  byEmail.clear();
  byIp.clear();
}
