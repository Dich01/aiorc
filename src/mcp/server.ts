import { Router, Request, Response } from 'express';
import { ValidateFunction } from 'ajv';
import db from '../db/client';
import { requireProjectKey, ProjectKeyRequest } from '../middleware/projectKey';
import { asyncHandler } from '../lib/asyncHandler';
import { assertSafeOutbound, postJsonPinned, OutboundError } from '../lib/outbound';
import { ajv, formatAjvErrors, validateEnvelope, validateToolCallParams } from './validation';
import { startRun, nextStep, StepResult } from '../orchestrator/engine';
import { gateExecution } from '../lib/controlPlane';
import { externalToolName, parseExternalTool, sanitizeServerName, toolAllowed } from '../lib/mcpServers';
import { loadSnapshot } from '../orchestrator/snapshot';
import { appendEvent } from '../lib/runEvents';
import { hashJson } from '../lib/canonicalJson';
import { EngineState } from '../orchestrator/engine';
import { parseStoredSchema } from '../lib/outputSchema';
import { v4 as uuidv4 } from 'uuid';

// ── External MCP proxy (single-connection principle) ────────────────────────
// The client keeps ONE MCP connection: AIOrc. Tools of external servers
// registered in the project appear namespaced (`<server>__<tool>`) in
// tools/list and their calls are forwarded server-side with logging.
interface McpServerRow { id: string; project_id: string; name: string; url: string; description: string }

// Every call re-validates the registered URL (DNS included) and pins the
// connection to the validated address: see lib/outbound.ts.
async function callExternal(url: string, method: string, params?: unknown, timeoutMs = 5000): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const target = await assertSafeOutbound(url);
  const resp = await postJsonPinned(target, { jsonrpc: '2.0', id: 1, method, params }, timeoutMs);
  const body = resp.body as { result?: unknown; error?: { code: number; message: string } } | null;
  if (!body || typeof body !== 'object') throw new OutboundError('the server answered with an empty or non-object body');
  return body;
}

// Short-TTL cache so the MCP handshake (tools/list) never blocks on a dead
// external server, and repeated handshakes don't re-fetch every time.
const extToolsCache = new Map<string, { at: number; tools: unknown[] }>();
const EXT_TOOLS_TTL = 30_000;

async function listExternalTools(projectId: string): Promise<unknown[]> {
  const cached = extToolsCache.get(projectId);
  if (cached && Date.now() - cached.at < EXT_TOOLS_TTL) return cached.tools;
  const servers = db.prepare('SELECT * FROM mcp_servers WHERE project_id = ?').all(projectId) as McpServerRow[];
  const out: unknown[] = [];
  await Promise.all(servers.map(async s => {
    try {
      const resp = await callExternal(s.url, 'tools/list', undefined, 2500);
      const tools = (resp.result as { tools?: { name: string; description?: string }[] } | undefined)?.tools ?? [];
      for (const t of tools) {
        out.push({ ...t, name: externalToolName(s.name, t.name), description: `[${s.name}] ${t.description ?? ''}`.trim() });
      }
    } catch { /* unreachable server: skip its tools, AIOrc's own tools still work */ }
  }));
  extToolsCache.set(projectId, { at: Date.now(), tools: out });
  return out;
}

const router = Router();

interface JsonRpcRequest {
  jsonrpc: string;
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// ── MCP contract v2 ─────────────────────────────────────────────────────────
// Three tools. There is no compiled "whole prompt" mode and no self-reported
// execution: the server drives every step and records what it accepted.

const START_TOOL = {
  name: 'workflow.start',
  description: [
    'Start the project\'s agent workflow. The server validates the flow, freezes the instructions of every agent it uses,',
    'and returns ONLY the first step to execute, with the JSON Schema each output must satisfy.',
    'Execute it, then call workflow.next. Do not execute any other workflow agent on your own.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      request: { type: 'string', maxLength: 20000, description: 'The task to process through the workflow.' },
      context: { type: 'string', maxLength: 20000, description: 'Additional context about the environment (optional).' },
      input: { type: 'object', description: 'Structured run input. Validated against the project\'s input schema when it defines one.' },
      evalCase: { type: 'string', maxLength: 100, description: 'Eval case id (from workflow.eval). Its stored input replaces request/input and the run is graded on completion.' },
    },
    additionalProperties: false,
  },
};

const NEXT_TOOL = {
  name: 'workflow.next',
  description: [
    'Hand back the outputs of the step you were given and advance the run.',
    'Send one output per dispatched node; each must validate against that agent\'s output schema.',
    'Send `transition` (an edge id) only when the step lists choices. A rejected call consumes nothing; resending the same call returns the same answer.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    required: ['runId', 'step', 'outputs'],
    properties: {
      runId: { type: 'string', minLength: 1, maxLength: 100 },
      step: { type: 'integer', minimum: 1, description: 'The step number the server gave you.' },
      outputs: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: {
          type: 'object',
          required: ['node', 'output'],
          properties: {
            node: { type: 'string', minLength: 1, maxLength: 200, description: 'Node id of a dispatched agent.' },
            output: { description: 'That agent\'s output, as JSON.' },
          },
          additionalProperties: false,
        },
      },
      transition: { type: 'string', minLength: 1, maxLength: 200, description: 'Edge id, only when the step lists choices.' },
    },
    additionalProperties: false,
  },
};

const EVAL_TOOL = {
  name: 'workflow.eval',
  description: [
    'List the project\'s eval suite (test cases for the workflow).',
    'To run it: for each case, call workflow.start with {"evalCase": "<case id>"} and drive the run to the end with workflow.next.',
    'The server grades each run itself from what it recorded.',
  ].join(' '),
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

const OWN_TOOLS = [START_TOOL, NEXT_TOOL, EVAL_TOOL];
const argValidators = new Map<string, ValidateFunction>(OWN_TOOLS.map(t => [t.name, ajv.compile(t.inputSchema)]));
// Tools that read nothing private and start nothing: allowed with x-project-id on a public project.
const READ_ONLY_TOOLS = new Set(['workflow.eval']);

// Same 1 MB budget for an entire tool call's outputs as for the request body.
const MAX_OUTPUTS_BYTES = 1024 * 1024;

function stepReply(id: string | number | null, r: StepResult) {
  return rpcResult(id, { content: [{ type: 'text', text: r.text }], _meta: r.meta, ...(r.error ? { isError: true } : {}) });
}

router.post('/', requireProjectKey, asyncHandler<ProjectKeyRequest & Request>(async (req, res: Response): Promise<void> => {
  const project = req.project!;
  const body = req.body as JsonRpcRequest;

  if (!validateEnvelope(body)) {
    const rawId = (body as { id?: unknown } | null)?.id;
    const safeId = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;
    res.status(400).json(rpcError(safeId, -32600, `Invalid Request: ${formatAjvErrors(validateEnvelope.errors)}`));
    return;
  }

  const { id, method, params } = body;
  const caller = req.caller ?? null;
  const declaredCaller = req.declaredCaller ?? '';

  // Notifications (no id): acknowledge.
  if (id === undefined && method.startsWith('notifications/')) {
    res.status(202).end();
    return;
  }

  if (method === 'initialize') {
    res.json(rpcResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'AIOrc', version: '2.0.0' },
    }));
    return;
  }

  if (method === 'ping') { res.json(rpcResult(id, {})); return; }

  if (method === 'tools/list') {
    const hasFlow = db.prepare('SELECT 1 FROM project_flows WHERE project_id = ?').get(project.id);
    if (!hasFlow) { res.json(rpcResult(id, { tools: [] })); return; }
    const externalTools = req.projectAuth === 'key' ? await listExternalTools(project.id) : [];
    const own = req.projectAuth === 'key' ? OWN_TOOLS : OWN_TOOLS.filter(t => READ_ONLY_TOOLS.has(t.name));
    res.json(rpcResult(id, { tools: [...own, ...externalTools] }));
    return;
  }

  if (method !== 'tools/call') {
    res.json(rpcError(id, -32601, `Method not found: ${method}`));
    return;
  }

  if (!validateToolCallParams(params)) {
    res.json(rpcError(id, -32602, `Invalid params: ${formatAjvErrors(validateToolCallParams.errors)}`));
    return;
  }
  const toolName = (params as { name: string }).name;
  const toolArgs = { ...((params as { arguments?: Record<string, unknown> }).arguments ?? {}) };

  if (req.projectAuth !== 'key' && !READ_ONLY_TOOLS.has(toolName)) {
    res.json(rpcError(id, -32001, `Tool "${toolName}" needs access to the project: your personal token (Authorization: Bearer aiorc_pat_...) as a member, or the project key. Without them x-project-id only allows read-only tools.`));
    return;
  }

  // External tool: proxy it through the single AIOrc connection, with logging.
  const ext = parseExternalTool(toolName);
  if (ext) {
    const servers = db.prepare('SELECT * FROM mcp_servers WHERE project_id = ?').all(project.id) as McpServerRow[];
    const server = servers.find(s => sanitizeServerName(s.name) === ext.server);
    if (!server) {
      res.json(rpcError(id, -32602, `Unknown external server "${ext.server}". Register it in the project's Connect tab.`));
      return;
    }
    // Only inside an active run, and only for a tool the dispatched agent is
    // allowed to call. The client names the run in params._meta.runId.
    const metaArg = ((params as { _meta?: Record<string, unknown> })._meta ?? {}) as Record<string, unknown>;
    const runId = typeof metaArg['runId'] === 'string' ? metaArg['runId'] : '';
    const wantNode = typeof metaArg['node'] === 'string' ? metaArg['node'] : '';
    if (!runId) {
      res.json(rpcError(id, -32001, `External tools can only be called inside a run: pass the runId in params._meta.runId.`));
      return;
    }
    const runRow = db.prepare('SELECT engine_state, status FROM runs WHERE id = ? AND project_id = ?').get(runId, project.id) as { engine_state: string; status: string } | undefined;
    const state = runRow?.engine_state ? JSON.parse(runRow.engine_state) as EngineState : null;
    if (!runRow || !state || state.status !== 'active' || !['running', 'abandoned'].includes(runRow.status)) {
      res.json(rpcError(id, -32001, `Run "${runId}" is not active in this project; external tools can only be called during an active run.`));
      return;
    }
    const snap = loadSnapshot(runId);
    const candidates = state.current.filter(n => !wantNode || n === wantNode);
    const node = candidates.find(n => {
      const agentId = snap?.flow.nodes.find(x => x.id === n)?.agent_id;
      return !!agentId && toolAllowed(snap!.agents.get(agentId)?.allowed_tools ?? [], toolName);
    });
    if (!node) {
      res.json(rpcError(id, -32001, `Tool "${toolName}" is not in the allowed_tools of the agent dispatched at step ${state.step}.`));
      return;
    }

    const started = Date.now();
    let ok = 0;
    try {
      const resp = await callExternal(server.url, 'tools/call', { name: ext.tool, arguments: toolArgs });
      ok = resp && !resp.error ? 1 : 0;
      res.json(resp.error ? { jsonrpc: '2.0', id, error: resp.error } : rpcResult(id, resp.result));
    } catch (err) {
      const reason = err instanceof OutboundError ? `blocked: ${err.message}` : `unreachable: ${(err as Error).message}`;
      res.json(rpcError(id, -32603, `External server "${server.name}" ${reason}`));
    } finally {
      const duration = Date.now() - started;
      db.transaction(() => {
        db.prepare(
          'INSERT INTO mcp_tool_calls (id, project_id, server_id, server_name, tool, run_id, node_id, caller_user_id, caller_email, declared_caller, ok, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(uuidv4(), project.id, server.id, server.name, ext.tool, runId, node, caller?.userId ?? '', caller?.email ?? '', declaredCaller, ok, duration, Date.now());
        appendEvent(runId, 'tool.called', { step: state.step, node, tool: toolName, server_id: server.id, ok: !!ok, duration_ms: duration, arguments_sha256: hashJson(toolArgs) });
      })();
    }
    return;
  }

  const validateArgs = argValidators.get(toolName);
  if (!validateArgs) {
    res.json(rpcError(id, -32602, `Unknown tool: ${toolName}. Available: ${OWN_TOOLS.map(t => `"${t.name}"`).join(', ')}.`));
    return;
  }
  if (!validateArgs(toolArgs)) {
    res.json(rpcError(id, -32602, `Invalid arguments for ${toolName}: ${formatAjvErrors(validateArgs.errors)}`));
    return;
  }

  if (toolName === 'workflow.eval') {
    const cases = db.prepare(
      'SELECT id, name, expected_outcome, must_complete_agents FROM eval_cases WHERE project_id = ? ORDER BY created_at ASC'
    ).all(project.id) as { id: string; name: string; expected_outcome: string; must_complete_agents: string }[];
    const text = cases.length === 0
      ? 'This project has no eval cases defined.'
      : [
          `# Eval suite: ${cases.length} case(s)`,
          '',
          'For each case, call `workflow.start` with `{"evalCase": "<id>"}` and drive the run to the end with `workflow.next`. The server grades each run when it finishes.',
          '',
          ...cases.map(c => [
            `## ${c.name}`,
            `- id: \`${c.id}\``,
            c.expected_outcome ? `- expected outcome: ${c.expected_outcome}` : '- expected outcome: (any End)',
            c.must_complete_agents !== '[]' ? `- agents that must complete: ${(JSON.parse(c.must_complete_agents) as string[]).join(', ')}` : '',
            '',
          ].filter(Boolean).join('\n')),
        ].join('\n');
    res.json(rpcResult(id, { content: [{ type: 'text', text }], _meta: { cases: cases.map(c => ({ id: c.id, name: c.name })) } }));
    return;
  }

  if (toolName === 'workflow.start') {
    const gate = gateExecution({ action: 'start', projectPaused: !!project.paused, runStatus: null });
    if (!gate.allowed) {
      res.json(rpcResult(id, { content: [{ type: 'text', text: gate.reason }], _meta: { blocked: 'paused' }, isError: true }));
      return;
    }

    let input: Record<string, unknown> = {};
    const evalCaseId = typeof toolArgs['evalCase'] === 'string' ? toolArgs['evalCase'].trim() : '';
    if (evalCaseId) {
      const evalCase = db.prepare('SELECT input FROM eval_cases WHERE id = ? AND project_id = ?').get(evalCaseId, project.id) as { input: string } | undefined;
      if (!evalCase) {
        res.json(rpcError(id, -32602, `Unknown eval case "${evalCaseId}" for this project. Call workflow.eval to list the suite.`));
        return;
      }
      // The stored input replaces whatever the client sent, so evals are reproducible.
      try {
        const parsed = JSON.parse(evalCase.input);
        input = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { request: evalCase.input };
      } catch { input = { request: evalCase.input }; }
    } else {
      if (toolArgs['input'] !== undefined) input = { ...(toolArgs['input'] as Record<string, unknown>) };
      if (typeof toolArgs['request'] === 'string' && toolArgs['request'].trim()) input.request = toolArgs['request'];
      if (typeof toolArgs['context'] === 'string' && toolArgs['context'].trim()) input.context = toolArgs['context'];
    }

    const inputSchema = parseStoredSchema(project.input_schema);
    if (inputSchema) {
      const check = ajv.compile(inputSchema);
      if (!check(input)) {
        res.json(rpcError(id, -32602, `The run input does not match this project's input schema: ${formatAjvErrors(check.errors)}`));
        return;
      }
    } else if (Object.keys(input).length === 0) {
      res.json(rpcError(id, -32602, 'Send `request` (text) or `input` (object).'));
      return;
    }

    const result = startRun(project.id, input, { caller, declaredCaller }, evalCaseId);
    if (result.error && ['no_flow', 'empty_flow', 'invalid_flow'].includes(result.error)) {
      res.json(rpcError(id, -32603, result.text));
      return;
    }
    res.json(stepReply(id, result));
    return;
  }

  // workflow.next
  const runId = String(toolArgs['runId']);
  const outputs = toolArgs['outputs'] as { node: string; output: unknown }[];
  if (Buffer.byteLength(JSON.stringify(outputs), 'utf8') > MAX_OUTPUTS_BYTES) {
    res.json(rpcError(id, -32602, `outputs exceed ${MAX_OUTPUTS_BYTES} bytes.`));
    return;
  }
  const runRow = db.prepare('SELECT id, status FROM runs WHERE id = ? AND project_id = ?').get(runId, project.id) as { id: string; status: string } | undefined;
  if (!runRow) {
    res.json(rpcError(id, -32602, `Unknown runId "${runId}" for this project.`));
    return;
  }
  // Soft-abandoned runs resume when the client comes back.
  if (runRow.status === 'abandoned') {
    db.prepare(`UPDATE runs SET status = 'running', last_activity_at = ? WHERE id = ?`).run(Date.now(), runRow.id);
    runRow.status = 'running';
  }
  const stepGate = gateExecution({ action: 'step', projectPaused: !!project.paused, runStatus: runRow.status });
  if (!stepGate.allowed) {
    res.json(rpcResult(id, { content: [{ type: 'text', text: stepGate.reason }], _meta: { blocked: runRow.status }, isError: true }));
    return;
  }
  const result = nextStep(runId, {
    step: toolArgs['step'] as number,
    outputs,
    transition: typeof toolArgs['transition'] === 'string' ? toolArgs['transition'] : undefined,
  });
  res.json(stepReply(id, result));
}));

export default router;
