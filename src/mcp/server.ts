import { Router, Request, Response } from 'express';
import db from '../db/client';
import { requireProjectKey, ProjectKeyRequest } from '../middleware/projectKey';
import { compileFlow } from '../orchestrator';
import { startRun, nextStep } from '../orchestrator/engine';
import { recordReportedUsage } from '../lib/usage';
import { gateExecution } from '../lib/controlPlane';
import { externalToolName, parseExternalTool, sanitizeServerName } from '../lib/mcpServers';
import { canAcceptReport } from '../lib/controlPlane';
import { v4 as uuidv4 } from 'uuid';

// ── External MCP proxy (single-connection principle) ────────────────────────
// The client keeps ONE MCP connection: AIOrc. Tools of external servers
// registered in the project appear namespaced (`<server>__<tool>`) in
// tools/list and their calls are forwarded server-side with logging.
interface McpServerRow { id: string; project_id: string; name: string; url: string; description: string }

async function callExternal(url: string, method: string, params?: unknown, timeoutMs = 5000): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    });
    return await r.json() as { result?: unknown; error?: { code: number; message: string } };
  } finally {
    clearTimeout(t);
  }
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

// MCP tools exposed per project
const WORKFLOW_TOOL = {
  name: 'workflow',
  description: [
    'Execute the project\'s agent workflow.',
    'Returns step-by-step instructions that you MUST follow exactly in sequence.',
    'Do not answer the user request directly — call this tool first and follow the returned workflow.',
    'When the workflow ends you MUST call workflow.report with the runId and the execution path.'
  ].join(' '),
  inputSchema: {
    type: 'object',
    required: ['request'],
    properties: {
      request: {
        type: 'string',
        description: 'The task, request, or prompt to process through the workflow'
      },
      context: {
        type: 'string',
        description: 'Additional context about the codebase or environment (optional)'
      }
    }
  }
};

// Stepped (server-verified) mode: the engine dispatches one step at a time and
// validates every transition against the flow graph. Preferred over `workflow`
// because execution is recorded as ground truth instead of self-declared.
const START_TOOL = {
  name: 'workflow.start',
  description: [
    'PREFERRED: start the project\'s agent workflow in server-verified stepped mode.',
    'Returns the project context plus ONLY the first agent(s) to execute.',
    'Execute them, then call workflow.next with your output and the matching transition.',
    'Do not execute any other workflow agent on your own — the server hands you each step.'
  ].join(' '),
  inputSchema: {
    type: 'object',
    required: ['request'],
    properties: {
      request: { type: 'string', description: 'The task, request, or prompt to process through the workflow' },
      context: { type: 'string', description: 'Additional context about the codebase or environment (optional)' },
      evalCase: { type: 'string', description: 'Eval case id (from workflow.eval). The case input replaces `request` and the run is auto-graded on completion.' }
    }
  }
};

const EVAL_TOOL = {
  name: 'workflow.eval',
  description: [
    'List the project\'s eval suite (test cases for the workflow).',
    'To run the suite: for EACH case, call workflow.start with {"evalCase": "<case id>"} and drive the run to completion with workflow.next.',
    'The server grades each run automatically against the case\'s acceptance criteria using the verified execution path.',
  ].join(' '),
  inputSchema: { type: 'object', properties: {} }
};

const NEXT_TOOL = {
  name: 'workflow.next',
  description: [
    'Advance a stepped workflow run: hand back the finished step\'s output and the transition to take.',
    'The server validates the transition against the flow, enforces invocation caps, and returns the next agent(s) to execute.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    required: ['runId'],
    properties: {
      runId: { type: 'string', description: 'The runId returned by workflow.start' },
      output: { type: 'string', description: 'Concise summary of the output of the agent(s) just executed' },
      next: { type: 'string', description: 'Target agent name, end outcome, or the edge condition that matched. Pass "none" if no condition matched.' }
    }
  }
};

const REPORT_TOOL = {
  name: 'workflow.report',
  description: [
    'REQUIRED: after the workflow ends (success, failure or early stop), post a structured execution report.',
    'The workflow is NOT complete until this is called.',
    'Include the agent execution path, invocation counts per agent, which branches were taken, and the final outcome.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    required: ['runId', 'report'],
    properties: {
      runId: {
        type: 'string',
        description: 'The runId returned in the workflow response _meta'
      },
      report: {
        type: 'object',
        description: 'Free-form JSON with branches_taken, loop_iterations, verdicts, final_summary'
      }
    }
  }
};

router.post('/', requireProjectKey, async (req: ProjectKeyRequest & Request, res: Response): Promise<void> => {
  const project = req.project!;
  const body = req.body as JsonRpcRequest;

  if (!body || body.jsonrpc !== '2.0' || !body.method) {
    res.status(400).json(rpcError(body?.id ?? null, -32600, 'Invalid Request'));
    return;
  }

  const { id, method, params } = body;

  // Notifications (no id) — acknowledge immediately
  if (id === undefined && method?.startsWith('notifications/')) {
    res.status(202).end();
    return;
  }

  // initialize
  if (method === 'initialize') {
    res.json(rpcResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'AIOrc', version: '1.0.0' }
    }));
    return;
  }

  // tools/list — always one tool: the workflow executor
  if (method === 'tools/list') {
    // Check if project has a flow configured
    const hasFlow = db.prepare(
      'SELECT 1 FROM project_flows WHERE project_id = ?'
    ).get(project.id);

    if (!hasFlow) {
      res.json(rpcResult(id, { tools: [] }));
      return;
    }

    const externalTools = await listExternalTools(project.id);
    res.json(rpcResult(id, { tools: [START_TOOL, NEXT_TOOL, WORKFLOW_TOOL, REPORT_TOOL, EVAL_TOOL, ...externalTools] }));
    return;
  }

  // tools/call
  if (method === 'tools/call') {
    const toolName = (params as { name?: string; arguments?: Record<string, unknown> })?.name;
    const toolArgs = (params as { name?: string; arguments?: Record<string, unknown> })?.arguments || {};

    // External tool? Proxy it through the single AIOrc connection, with logging.
    const ext = toolName ? parseExternalTool(toolName) : null;
    if (ext) {
      const servers = db.prepare('SELECT * FROM mcp_servers WHERE project_id = ?').all(project.id) as McpServerRow[];
      const server = servers.find(s => sanitizeServerName(s.name) === ext.server);
      if (!server) {
        res.json(rpcError(id, -32602, `Unknown external server "${ext.server}". Register it in the project's Connect tab.`));
        return;
      }
      const started = Date.now();
      const callerEmail = String(req.headers['x-user-email'] ?? '').trim().slice(0, 254);
      let ok = 0;
      try {
        const resp = await callExternal(server.url, 'tools/call', { name: ext.tool, arguments: toolArgs });
        ok = resp && !resp.error ? 1 : 0;
        res.json(resp.error ? { jsonrpc: '2.0', id, error: resp.error } : rpcResult(id, resp.result));
      } catch (err) {
        res.json(rpcError(id, -32603, `External server "${server.name}" unreachable: ${(err as Error).message}`));
      } finally {
        db.prepare(
          'INSERT INTO mcp_tool_calls (id, project_id, server_id, server_name, tool, caller_email, ok, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(uuidv4(), project.id, server.id, server.name, ext.tool, callerEmail, ok, Date.now() - started, Date.now());
      }
      return;
    }

    const KNOWN_TOOLS = ['workflow', 'workflow.start', 'workflow.next', 'workflow.report', 'workflow.eval'];
    if (!toolName || !KNOWN_TOOLS.includes(toolName)) {
      res.json(rpcError(id, -32602, `Unknown tool: ${toolName}. Available: ${KNOWN_TOOLS.map(t => `"${t}"`).join(', ')}.`));
      return;
    }

    // workflow.eval — list the eval suite
    if (toolName === 'workflow.eval') {
      const cases = db.prepare(
        'SELECT id, name, input, expected_outcome, must_run_agents FROM eval_cases WHERE project_id = ? ORDER BY created_at ASC'
      ).all(project.id) as { id: string; name: string; input: string; expected_outcome: string; must_run_agents: string }[];
      const text = cases.length === 0
        ? 'This project has no eval cases defined. Create them on the Usage analytics page, then call workflow.eval again.'
        : [
            `# Eval suite — ${cases.length} case(s)`,
            '',
            'To run the suite: for EACH case, call `workflow.start` with `{"evalCase": "<id>"}` and drive the run to completion with `workflow.next`. The server grades each run automatically once it completes.',
            '',
            ...cases.map(c => [
              `## ${c.name}`,
              `- id: \`${c.id}\``,
              `- input: ${c.input}`,
              c.expected_outcome ? `- expected outcome: ${c.expected_outcome}` : '- expected outcome: (any clean completion)',
              c.must_run_agents ? `- required agents: ${c.must_run_agents}` : '',
              ''
            ].filter(Boolean).join('\n')),
          ].join('\n');
      res.json(rpcResult(id, { content: [{ type: 'text', text }], _meta: { cases: cases.length } }));
      return;
    }

    // Kill switch: a paused project accepts no NEW runs. In-flight stepped
    // runs are gated per-step below (cancel affects a single run only).
    if (toolName === 'workflow' || toolName === 'workflow.start') {
      const gate = gateExecution({ action: 'start', projectPaused: !!project.paused, runStatus: null });
      if (!gate.allowed) {
        res.json(rpcResult(id, { content: [{ type: 'text', text: gate.reason }], _meta: { blocked: 'paused' } }));
        return;
      }
    }

    // workflow.start — stepped, server-verified execution
    if (toolName === 'workflow.start') {
      const evalCaseId = String(toolArgs['evalCase'] ?? '').trim();
      if (evalCaseId) {
        const evalCase = db.prepare('SELECT * FROM eval_cases WHERE id = ? AND project_id = ?')
          .get(evalCaseId, project.id) as { input: string; name: string } | undefined;
        if (!evalCase) {
          res.json(rpcError(id, -32602, `Unknown eval case "${evalCaseId}" for this project. Call workflow.eval to list the suite.`));
          return;
        }
        // The case's stored input replaces the request so the eval is reproducible.
        toolArgs['request'] = evalCase.input;
      }
      if (!toolArgs['request'] || String(toolArgs['request']).trim() === '') {
        res.json(rpcError(id, -32602, 'Missing required field: request'));
        return;
      }
      const callerEmail = String(req.headers['x-user-email'] ?? '').trim().slice(0, 254);
      const result = startRun(project.id, toolArgs as Record<string, unknown>, callerEmail, evalCaseId);
      if (result.error && ['no_flow', 'empty_flow', 'invalid_flow'].includes(result.error)) {
        res.json(rpcError(id, -32603, result.text));
        return;
      }
      res.json(rpcResult(id, {
        content: [{ type: 'text', text: result.text }],
        _meta: { runId: result.runId, mode: 'stepped', done: result.done }
      }));
      return;
    }

    // workflow.next — advance a stepped run
    if (toolName === 'workflow.next') {
      const runId = String(toolArgs['runId'] ?? '').trim();
      if (!runId) {
        res.json(rpcError(id, -32602, 'Missing required field: runId'));
        return;
      }
      const runRow = db.prepare(
        'SELECT id, project_id, flow_json, engine_state, mode, eval_case_id, status FROM runs WHERE id = ? AND project_id = ?'
      ).get(runId, project.id) as { id: string; project_id: string; flow_json: string; engine_state: string; mode: string; eval_case_id: string; status: string } | undefined;
      if (!runRow) {
        res.json(rpcError(id, -32602, `Unknown runId "${runId}" for this project.`));
        return;
      }
      // Soft-abandoned runs resurrect when the client comes back.
      if (runRow.status === 'abandoned') {
        db.prepare(`UPDATE runs SET status = 'running', last_activity_at = ? WHERE id = ?`).run(Date.now(), runRow.id);
        runRow.status = 'running';
      }
      const stepGate = gateExecution({ action: 'step', projectPaused: !!project.paused, runStatus: runRow.status });
      if (!stepGate.allowed) {
        res.json(rpcResult(id, { content: [{ type: 'text', text: stepGate.reason }], _meta: { blocked: runRow.status } }));
        return;
      }
      const result = nextStep(runRow, String(toolArgs['output'] ?? ''), String(toolArgs['next'] ?? ''));
      res.json(rpcResult(id, {
        content: [{ type: 'text', text: result.text }],
        _meta: { runId: result.runId, mode: 'stepped', done: result.done, ...(result.error ? { error: result.error } : {}) }
      }));
      return;
    }

    // workflow.report — voluntary post-run audit
    if (toolName === 'workflow.report') {
      const runId = String(toolArgs['runId'] ?? '').trim();
      const report = toolArgs['report'];

      if (!runId) {
        res.json(rpcError(id, -32602, 'Missing required field: runId'));
        return;
      }

      const run = db.prepare('SELECT id, status FROM runs WHERE id = ? AND project_id = ?').get(runId, project.id) as { id: string; status: string } | undefined;
      if (!run) {
        res.json(rpcError(id, -32602, `Unknown runId "${runId}" for this project.`));
        return;
      }
      if (!canAcceptReport(run.status)) {
        res.json(rpcError(id, -32602, `Run "${runId}" is ${run.status}; it no longer accepts reports.`));
        return;
      }

      try {
        db.prepare('UPDATE runs SET execution_report = ? WHERE id = ?').run(JSON.stringify(report ?? {}), runId);
        recordReportedUsage(runId, project.id, report);
      } catch (err) {
        console.error('[AIOrc] workflow.report storage error:', err);
      }

      res.json(rpcResult(id, { content: [{ type: 'text', text: 'Report stored.' }] }));
      return;
    }

    // workflow — main flow executor
    if (!toolArgs['request'] || String(toolArgs['request']).trim() === '') {
      res.json(rpcError(id, -32602, 'Missing required field: request'));
      return;
    }

    // Compile the flow into deterministic instructions for the calling LLM.
    // x-user-email (optional, set via AIORC_USER_EMAIL in the bridge) attributes
    // the run to the actual person behind the shared project key.
    const callerEmail = String(req.headers['x-user-email'] ?? '').trim().slice(0, 254);
    const result = compileFlow(project.id, toolArgs as Record<string, unknown>, callerEmail);

    if (result.error === 'no_flow' || result.error === 'empty_flow') {
      res.json(rpcError(id, -32603, result.workflow));
      return;
    }

    if (result.error === 'invalid_flow') {
      res.json(rpcError(id, -32603, result.workflow));
      return;
    }

    res.json(rpcResult(id, {
      content: [
        {
          type: 'text',
          text: result.workflow
        }
      ],
      _meta: {
        runId: result.runId,
        nodeCount: result.nodeCount,
        agents: result.agentNames
      }
    }));
    return;
  }

  res.json(rpcError(id, -32601, `Method not found: ${method}`));
});

export default router;
