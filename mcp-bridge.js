#!/usr/bin/env node
/**
 * AIOrc MCP stdio bridge
 * Reads JSON-RPC from stdin, forwards it to an AIOrc server over HTTP or
 * HTTPS, writes the response to stdout. For clients that only speak stdio;
 * Claude Code can also connect to AIORC_URL directly as an HTTP MCP server.
 *
 * Usage: AIORC_URL=https://aiorc.example.com/mcp AIORC_PROJECT_KEY=aiorc_pk_... node mcp-bridge.js
 *   AIORC_TOKEN       optional personal access token (aiorc_pat_...): the run's
 *                     caller becomes a verified identity
 *   AIORC_USER_EMAIL  optional, recorded only as a declared (unverified) caller
 */

const http = require('http');
const https = require('https');
const readline = require('readline');

const PROJECT_KEY = process.env.AIORC_PROJECT_KEY;
const PROJECT_ID = process.env.AIORC_PROJECT_ID;
const TOKEN = process.env.AIORC_TOKEN;
const USER_EMAIL = process.env.AIORC_USER_EMAIL;
const AIORC_URL = process.env.AIORC_URL || 'http://localhost:3001/mcp';

if (!PROJECT_KEY && !PROJECT_ID) {
  process.stderr.write('AIOrc bridge: set AIORC_PROJECT_KEY (private) or AIORC_PROJECT_ID (public).\n');
  process.exit(1);
}

const url = new URL(AIORC_URL);
if (url.protocol !== 'http:' && url.protocol !== 'https:') {
  process.stderr.write('AIOrc bridge: AIORC_URL must be http(s).\n');
  process.exit(1);
}
const client = url.protocol === 'https:' ? https : http;

function sendToAIOrc(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (PROJECT_KEY) headers['x-project-key'] = PROJECT_KEY;
    if (PROJECT_ID) headers['x-project-id'] = PROJECT_ID;
    if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
    if (USER_EMAIL) headers['x-user-email'] = USER_EMAIL;
    const options = {
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers
    };

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // Notification responses (202 empty) — no output needed
        if (res.statusCode === 202 || !data.trim()) {
          resolve(null);
          return;
        }
        if (res.statusCode === 401) {
          reject(new Error(`AIOrc rejected the credentials (401): ${data.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Invalid JSON from server: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let body;
  try {
    body = JSON.parse(line);
  } catch {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: null,
      error: { code: -32700, message: 'Parse error' }
    }) + '\n');
    return;
  }

  try {
    const response = await sendToAIOrc(body);
    if (response !== null) {
      process.stdout.write(JSON.stringify(response) + '\n');
    }
  } catch (err) {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: body?.id ?? null,
      error: { code: -32603, message: err.message }
    }) + '\n');
  }
});
