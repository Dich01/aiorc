#!/usr/bin/env node
// Stand-in for the Claude Code CLI in runner tests. It reads the --mcp-config
// the runner wrote, takes the workflow.start argument from the prompt and
// drives the code-review-pre-pr flow over MCP with canned outputs, the way
// the real client would. It records its own argv so tests can check the flags.
const fs = require('fs');
const argv = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_ARGV) fs.writeFileSync(process.env.FAKE_CLAUDE_ARGV, JSON.stringify(argv));
const cfg = JSON.parse(fs.readFileSync(argv[argv.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.aiorc;
const prompt = argv[argv.indexOf('-p') + 1];
const startArg = JSON.parse(prompt.match(/argument: (\{.*\})$/m)[1]);

let id = 0;
async function call(name, args) {
  const r = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...cfg.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
  const body = await r.json();
  if (body.error) throw new Error(body.error.message);
  return body.result._meta;
}

(async () => {
  const risk = process.env.FAKE_RISK || 'trivial';
  let meta = await call('workflow.start', startArg);
  const canned = {
    scope: { risk, areas: [], reasons: 'fake' },
    'security-review': { findings: [] }, 'correctness-review': { findings: [] },
    verifier: { findings: [], discarded: [] }, report: { blocking: false, summary: 'fake review', findings: [] },
  };
  while (!meta.done) {
    meta = await call('workflow.next', { runId: meta.runId, step: meta.step, outputs: meta.dispatched.map(d => ({ node: d.node, output: canned[d.node] ?? {} })) });
  }
  process.stdout.write(JSON.stringify({ type: 'result', result: 'DONE' }));
})().catch(err => { console.error(err.message); process.exit(1); });
