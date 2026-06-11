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

// Block outbound requests to loopback, link-local and private ranges so a
// registered "MCP server" can't be used to SSRF the host's internal network.
export function isSafeOutboundUrl(url: string): boolean {
  let h: string;
  try { h = new URL(url).hostname.toLowerCase(); } catch { return false; }
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || h === '::1' || h === '[::1]') return false;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0) return false;                 // loopback / private / this-host
    if (a === 169 && b === 254) return false;                           // link-local (cloud metadata)
    if (a === 192 && b === 168) return false;                           // private
    if (a === 172 && b >= 16 && b <= 31) return false;                  // private
  }
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
