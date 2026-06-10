import { Router, Request, Response } from 'express';
import db from '../db/client';
import { requireProjectKey, ProjectKeyRequest } from '../middleware/projectKey';
import { compileFlow } from '../orchestrator';
import { startRun, nextStep } from '../orchestrator/engine';
import { recordReportedUsage } from '../lib/usage';

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

    res.json(rpcResult(id, { tools: [START_TOOL, NEXT_TOOL, WORKFLOW_TOOL, REPORT_TOOL, EVAL_TOOL] }));
    return;
  }

  // tools/call
  if (method === 'tools/call') {
    const toolName = (params as { name?: string; arguments?: Record<string, unknown> })?.name;
    const toolArgs = (params as { name?: string; arguments?: Record<string, unknown> })?.arguments || {};

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
        ? 'Este proyecto no tiene eval cases definidos. Crealos en la página de Usage analytics.'
        : [
            `# Eval suite — ${cases.length} caso(s)`,
            '',
            'Para correr la suite: por CADA caso llamá `workflow.start` con `{"evalCase": "<id>"}` y llevá el run hasta el final con `workflow.next`. El servidor califica automáticamente al completar.',
            '',
            ...cases.map(c => [
              `## ${c.name}`,
              `- id: \`${c.id}\``,
              `- input: ${c.input}`,
              c.expected_outcome ? `- outcome esperado: ${c.expected_outcome}` : '- outcome esperado: (cualquier finalización limpia)',
              c.must_run_agents ? `- agentes obligatorios: ${c.must_run_agents}` : '',
              ''
            ].filter(Boolean).join('\n')),
          ].join('\n');
      res.json(rpcResult(id, { content: [{ type: 'text', text }], _meta: { cases: cases.length } }));
      return;
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
        'SELECT id, project_id, flow_json, engine_state, mode, eval_case_id FROM runs WHERE id = ? AND project_id = ?'
      ).get(runId, project.id) as { id: string; project_id: string; flow_json: string; engine_state: string; mode: string; eval_case_id: string } | undefined;
      if (!runRow) {
        res.json(rpcError(id, -32602, `Unknown runId "${runId}" for this project.`));
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

      const run = db.prepare('SELECT id FROM runs WHERE id = ? AND project_id = ?').get(runId, project.id);
      if (!run) {
        res.json(rpcError(id, -32602, `Unknown runId "${runId}" for this project.`));
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
