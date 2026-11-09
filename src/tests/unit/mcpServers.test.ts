import assert from 'assert';
import { section, test } from '../harness';
import { isSafeOutboundUrl, validateMcpServer, externalToolName, parseExternalTool } from '../../lib/mcpServers';

section('SSRF guard');


test('rejects URLs pointing at internal or private hosts', () => {
  assert.strictEqual(isSafeOutboundUrl('http://localhost:3001'), false);
  assert.strictEqual(isSafeOutboundUrl('http://127.0.0.1/x'), false);
  assert.strictEqual(isSafeOutboundUrl('http://169.254.169.254/latest'), false);
  assert.strictEqual(isSafeOutboundUrl('http://10.0.0.5/x'), false);
  assert.strictEqual(isSafeOutboundUrl('http://192.168.1.1/x'), false);
  assert.strictEqual(isSafeOutboundUrl('https://mcp.example.com/jira'), true);
});

section('mcpServers (B1)');


test('accepts a valid MCP server', () => {
  const v = validateMcpServer({ name: 'jira', url: 'https://mcp.example.com/jira', description: 'tickets' });
  assert.strictEqual(v.ok, true);
});

test('rejects a URL that is not http or https', () => {
  assert.strictEqual(validateMcpServer({ name: 'x', url: 'ftp://malo' }).ok, false);
  assert.strictEqual(validateMcpServer({ name: 'x', url: 'javascript:alert(1)' }).ok, false);
  assert.strictEqual(validateMcpServer({ name: 'x', url: 'not-a-url' }).ok, false);
});

test('rejects an empty or overly long name', () => {
  assert.strictEqual(validateMcpServer({ name: '', url: 'https://ok.com' }).ok, false);
  assert.strictEqual(validateMcpServer({ name: 'x'.repeat(80), url: 'https://ok.com' }).ok, false);
});

section('gateway B2 (single connection)');


test('external tools are namespaced as server__tool', () => {
  assert.strictEqual(externalToolName('jira', 'create_issue'), 'jira__create_issue');
});

test('a namespaced name parses back', () => {
  const p = parseExternalTool('jira__create_issue');
  assert.deepStrictEqual(p, { server: 'jira', tool: 'create_issue' });
});

test("AIOrc's own tools are not mistaken for external ones", () => {
  assert.strictEqual(parseExternalTool('workflow.start'), null);
  assert.strictEqual(parseExternalTool('workflow'), null);
});

test('server names are sanitized to the MCP charset', () => {
  assert.strictEqual(externalToolName('My Server!', 'tool'), 'my-server__tool');
});

test('a tool with a double underscore in its name is preserved', () => {
  const p = parseExternalTool('jira__sub__tool');
  assert.deepStrictEqual(p, { server: 'jira', tool: 'sub__tool' });
});
