#!/usr/bin/env node
/**
 * AIOrc MCP stdio bridge
 * Reads JSON-RPC from stdin, forwards to AIOrc HTTP server, writes response to stdout.
 * Usage: AIORC_PROJECT_KEY=alpha-key-2024 node mcp-bridge.js
 */

const http = require('http');
const readline = require('readline');

const PROJECT_KEY = process.env.AIORC_PROJECT_KEY;
const PROJECT_ID = process.env.AIORC_PROJECT_ID;
const USER_EMAIL = process.env.AIORC_USER_EMAIL; // optional: attributes runs to this person in usage analytics
const AIORC_URL = process.env.AIORC_URL || 'http://localhost:3000/mcp';

if (!PROJECT_KEY && !PROJECT_ID) {
  process.stderr.write('AIOrc bridge: set AIORC_PROJECT_KEY (private) or AIORC_PROJECT_ID (public).\n');
  process.exit(1);
}

const url = new URL(AIORC_URL);

function sendToAIOrc(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (PROJECT_KEY) headers['x-project-key'] = PROJECT_KEY;
    if (PROJECT_ID) headers['x-project-id'] = PROJECT_ID;
    if (USER_EMAIL) headers['x-user-email'] = USER_EMAIL;
    const options = {
      hostname: url.hostname,
      port: url.port || 3000,
      path: url.pathname,
      method: 'POST',
      headers
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // Notification responses (202 empty) — no output needed
        if (res.statusCode === 202 || !data.trim()) {
          resolve(null);
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
