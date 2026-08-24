#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMcpServerConfig } from './setup-core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mcpConfig = JSON.parse(await readFile(resolve(root, '.mcp.json'), 'utf8'));
const serverConfig = resolveMcpServerConfig(mcpConfig);
assert.ok(serverConfig, 'missing graph-reasoning entry in .mcp.json');
const child = spawn(serverConfig.command, serverConfig.args ?? [], {
  cwd: resolve(root, serverConfig.cwd ?? '.'),
  env: { ...process.env, ...(serverConfig.env ?? {}) },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

const responses = [];
const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
reader.on('line', (line) => {
  if (line.trim()) responses.push(JSON.parse(line));
});

const requests = [
  { jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'ping', params: {} },
];
for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
child.stdin.end();

let timeout;
const exitCode = await Promise.race([
  new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', resolveExit);
  }),
  new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error('MCP protocol smoke timed out')), 90000);
  }),
]).finally(() => clearTimeout(timeout));

assert.equal(exitCode, 0, `server exited ${exitCode}: ${stderr}`);
assert.equal(responses.length, 3, `expected 3 responses, got ${responses.length}: ${stderr}`);
assert.equal(responses[0].result.resultType, 'complete');
assert.equal(
  responses[0].result._meta?.['io.modelcontextprotocol/serverInfo']?.name,
  'graph-reasoning',
);
assert.equal(responses[1].result.tools.length, 7);
assert.equal(responses[2].error?.code, -32601);

console.log(JSON.stringify({
  status: 'passed',
  protocol: responses[0].result.supportedVersions[0],
  tools: responses[1].result.tools.map((tool) => tool.name),
}, null, 2));
