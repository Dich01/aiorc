// Integration helpers: mount the real Express app on an ephemeral port against
// the throwaway database set up by tests/env.ts, and talk to it over HTTP the
// same way a browser or an MCP client would.
import http from 'http';
import { AddressInfo } from 'net';
import bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import db from '../../db/client';
import app from '../../app';

let server: http.Server | null = null;
let baseUrl = '';

export async function startServer(): Promise<string> {
  if (server) return baseUrl;
  server = http.createServer(app);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return baseUrl;
}

export async function stopServer(): Promise<void> {
  if (!server) return;
  await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
  raw?: string; // send this exact body instead of JSON.stringify(body)
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export async function api<T = any>(path: string, opts: ApiOptions = {}): Promise<ApiResponse<T>> {
  const url = (await startServer()) + path;
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: string | undefined;
  if (opts.raw !== undefined) { body = opts.raw; headers['Content-Type'] ??= 'application/json'; }
  else if (opts.body !== undefined) { body = JSON.stringify(opts.body); headers['Content-Type'] = 'application/json'; }
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const r = await fetch(url, { method: opts.method ?? (body !== undefined ? 'POST' : 'GET'), headers, body });
  const text = await r.text();
  let parsed: unknown = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { status: r.status, body: parsed as T, headers: r.headers };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

export const TEST_PASSWORD = 'correct-horse-battery';

export async function createUser(opts: { email?: string; role?: 'admin' | 'user' } = {}): Promise<{ id: string; email: string; token: string }> {
  const id = randomUUID();
  const email = opts.email ?? `u-${id.slice(0, 8)}@test.local`;
  const nickname = `u${id.slice(0, 8)}`;
  db.prepare(
    "INSERT INTO users (id, email, password_hash, name, nickname, bio, role, created_at) VALUES (?, ?, ?, ?, ?, '', ?, ?)"
  ).run(id, email, await bcrypt.hash(TEST_PASSWORD, 4), nickname, nickname, opts.role ?? 'user', Date.now());
  const login = await api('/auth/login', { body: { email, password: TEST_PASSWORD } });
  if (login.status !== 200) throw new Error(`login failed: ${JSON.stringify(login.body)}`);
  return { id, email, token: login.body.token };
}

export async function createProject(token: string, name = `p-${randomUUID().slice(0, 6)}`): Promise<{ id: string; api_key: string }> {
  const r = await api('/projects', { body: { name }, token });
  if (r.status !== 201) throw new Error(`create project failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export async function createAgent(token: string, projectId: string, name: string, extra: Record<string, unknown> = {}): Promise<{ id: string; name: string }> {
  const r = await api('/agents', {
    token,
    body: { name, description: `${name} agent`, content: `You are ${name}.`, project_ids: [projectId], ...extra },
  });
  if (r.status !== 201) throw new Error(`create agent failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export async function putFlow(token: string, projectId: string, flow: { nodes: unknown[]; edges: unknown[] }): Promise<ApiResponse> {
  return api(`/projects/${projectId}/flow`, { method: 'PUT', token, body: flow });
}

// ── MCP ─────────────────────────────────────────────────────────────────────

let rpcId = 0;

export async function rpc(method: string, params: unknown, headers: Record<string, string>): Promise<ApiResponse> {
  return api('/mcp', { headers, body: { jsonrpc: '2.0', id: ++rpcId, method, params } });
}

// Call an MCP tool. Returns the JSON-RPC envelope plus the text content and
// _meta of a successful result, for terse assertions.
export async function mcp(projectKey: string, tool: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<{
  status: number;
  error?: { code: number; message: string };
  text: string;
  meta: Record<string, any>;
  result: any;
}> {
  const r = await rpc('tools/call', { name: tool, arguments: args }, { 'x-project-key': projectKey, ...headers });
  const result = r.body?.result;
  return {
    status: r.status,
    error: r.body?.error,
    text: result?.content?.[0]?.text ?? '',
    meta: result?._meta ?? {},
    result,
  };
}
