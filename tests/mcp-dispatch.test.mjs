import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';

import {
  GraphReasoningError,
  ReasoningGraphService,
  createDefaultService,
  createMcpRuntime,
  runStdioServer,
} from '../server/index.mjs';

const TOOL_METHODS = {
  reasoning_start: 'start',
  reasoning_inspect: 'inspect',
  reasoning_advance: 'advance',
  reasoning_branch: 'branch',
  reasoning_backtrack: 'backtrack',
  reasoning_integrate: 'integrate',
  reasoning_finish: 'finish',
};

test('every MCP tool dispatches to its corresponding reasoning service method', async () => {
  const calls = [];
  const service = {};
  for (const [tool, method] of Object.entries(TOOL_METHODS)) {
    service[method] = async (args) => {
      calls.push({ tool, method, args });
      return { handled_by: method };
    };
  }
  const runtime = createMcpRuntime({ service });
  await runtime.handle({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} });

  for (const tool of Object.keys(TOOL_METHODS)) {
    const response = await runtime.handle({
      jsonrpc: '2.0',
      id: tool,
      method: 'tools/call',
      params: { name: tool, arguments: { marker: tool } },
    });
    assert.equal(response.result.isError, false);
    assert.equal(response.result.structuredContent.handled_by, TOOL_METHODS[tool]);
  }

  assert.equal(calls.length, 7);
});

test('unknown tools return a structured tool error rather than crashing the MCP process', async () => {
  const runtime = createMcpRuntime({ service: {} });
  const response = await runtime.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'reasoning_delete_everything', arguments: {} },
  });

  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.error_code, 'UNKNOWN_TOOL');
});

test('service validation and Neo4j failures become structured isError tool results', async () => {
  const service = {
    start: async () => {
      throw new GraphReasoningError('goal is required', {
        code: 'INVALID_ARGUMENT',
        details: { field: 'goal' },
      });
    },
  };
  const runtime = createMcpRuntime({ service });

  const response = await runtime.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'reasoning_start', arguments: {} },
  });

  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.error_code, 'INVALID_ARGUMENT');
  assert.deepEqual(response.result.structuredContent.details, { field: 'goal' });
});

test('the default service is a graph service backed by the supplied Neo4j client', () => {
  const fakeClient = {
    ensureSchema: async () => {},
    execute: async () => [],
    run: async () => ({ columns: [], rows: [] }),
  };
  const service = createDefaultService({ client: fakeClient });

  assert.ok(service instanceof ReasoningGraphService);
  assert.equal(service.client, fakeClient);
});

test('STDIO server emits parse errors and continues processing later requests', async () => {
  const input = Readable.from([
    '{not-json}\n',
    '{"jsonrpc":"2.0","id":1,"method":"ping"}\n',
  ]);
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => { text += chunk.toString(); });

  await runStdioServer({
    service: {},
    input,
    output,
    errorOutput: new PassThrough(),
  });

  const messages = text.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(messages[0].error.code, -32700);
  assert.deepEqual(messages[1], { jsonrpc: '2.0', id: 1, result: {} });
});
