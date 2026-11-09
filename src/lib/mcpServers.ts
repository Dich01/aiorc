import net from 'net';
import { allowPrivateTargets, isBlockedAddress } from './outbound';

// MCP server registry (Phase B1): inventory of the external MCP servers each
// project's agents rely on. Pure validation here — unit-tested; CRUD lives in
// routes. Phase B2 (proxying calls through AIOrc with per-agent allowlists)
// builds on this inventory later.

export interface McpServerInput {
  name?: unknown;
  url?: unknown;
  description?: unknown;
}

export interface McpServerValidation {
  ok: boolean;
  error?: string;
  name?: string;
  url?: string;
  description?: string;
}

// ── Single-connection principle ──────────────────────────────────────────────
// Clients configure ONE MCP connection (AIOrc). External servers registered in
// the project are exposed THROUGH that connection: their tools appear in
// AIOrc's tools/list namespaced as `<server>__<tool>`, and calls are proxied
// server-side (logged, and later policy-gated). Nobody configures a second MCP.

// Sanitize a server name to the MCP tool-name charset (letters/digits/_/-).
export function sanitizeServerName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

export function externalToolName(server: string, tool: string): string {
  return `${sanitizeServerName(server)}__${tool}`;
}

// Returns { server, tool } for namespaced external tools, null for AIOrc's own.
// Split on the FIRST double underscore so tools containing `__` survive.
export function parseExternalTool(name: string): { server: string; tool: string } | null {
  const i = name.indexOf('__');
  if (i <= 0) return null;
  return { server: name.slice(0, i), tool: name.slice(i + 2) };
}

// Synchronous pre-check on the literal URL, used when a server is registered.
// It rejects obvious internal targets (localhost names, IP literals in blocked
// ranges, including bracketed and IPv4-mapped IPv6 forms). It does NOT resolve
// DNS: assertSafeOutbound() in lib/outbound.ts does that, at registration and
// again on every call.
export function isSafeOutboundUrl(url: string): boolean {
  let h: string;
  try { h = new URL(url).hostname.toLowerCase(); } catch { return false; }
  h = h.replace(/^\[|\]$/g, '');
  if (allowPrivateTargets()) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (net.isIP(h)) return !isBlockedAddress(h);
  // Single-label names ("aiorc", "db") only resolve inside a private network
  // (Docker service names, search domains): never a public MCP server.
  if (!h.includes('.')) return false;
  return true;
}

export function validateMcpServer(input: McpServerInput): McpServerValidation {
  const name = String(input.name ?? '').trim();
  const url = String(input.url ?? '').trim();
  const description = String(input.description ?? '').trim().slice(0, 300);

  if (!name || name.length > 60) {
    return { ok: false, error: 'name is required (max 60 chars)' };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'url must be a valid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'url must use http or https' };
  }
  if (!isSafeOutboundUrl(url)) {
    return { ok: false, error: 'url cannot point to localhost or a private network address' };
  }
  return { ok: true, name, url, description };
}

// ── Per-agent tool allowlist (Phase B2) ────────────────────────────────────
// An agent lists the external tools it may call: "server__tool" for one tool
// or "server__*" for every tool of a server. Calls are only proxied inside an
// active run, for a tool the dispatched agent is allowed to use.

export const TOOL_PATTERN_RE = /^[a-z0-9_-]{1,40}__([A-Za-z0-9_.\-]{1,100}|\*)$/;

export function normalizeToolList(raw: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'allowed_tools must be an array of "server__tool" or "server__*" strings' };
  const out = new Set<string>();
  for (const t of raw) {
    if (typeof t !== 'string' || !TOOL_PATTERN_RE.test(t)) return { ok: false, error: `invalid allowed_tools entry ${JSON.stringify(t)}: use "server__tool" or "server__*"` };
    out.add(t);
  }
  if (out.size > 100) return { ok: false, error: 'at most 100 allowed_tools entries' };
  return { ok: true, value: [...out] };
}

export function toolAllowed(allowed: string[], namespacedTool: string): boolean {
  const ext = parseExternalTool(namespacedTool);
  if (!ext) return false;
  return allowed.includes(namespacedTool) || allowed.includes(`${ext.server}__*`);
}
