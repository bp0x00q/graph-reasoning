import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MCP_PROTOCOL_LEGACY,
  MCP_PROTOCOL_MODERN,
  TOOL_DEFINITIONS,
  createMcpRuntime,
} from '../server/index.mjs';

const TOOL_NAMES = [
  'reasoning_start',
  'reasoning_inspect',
  'reasoning_advance',
  'reasoning_branch',
  'reasoning_backtrack',
  'reasoning_integrate',
  'reasoning_finish',
];

function createServiceStub() {
  const calls = [];
  const service = {};
  for (const name of TOOL_NAMES) {
    service[name.replace('reasoning_', '')] = async (args) => {
      calls.push({ name, args });
      return { tool: name, args };
    };
  }
  return { service, calls };
}

test('exports exactly the seven approved reasoning tools', () => {
  assert.deepEqual(TOOL_DEFINITIONS.map((tool) => tool.name), TOOL_NAMES);
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 20);
  }
});

test('legacy initialize negotiates a legacy protocol and exposes tools capability', async () => {
  const { service } = createServiceStub();
  const runtime = createMcpRuntime({ service });

  const response = await runtime.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_LEGACY,
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    },
  });

  assert.equal(response.result.protocolVersion, MCP_PROTOCOL_LEGACY);
  assert.deepEqual(response.result.capabilities, { tools: { listChanged: false } });
  assert.equal(response.result.serverInfo.name, 'graph-reasoning');
  assert.match(response.result.instructions, /Neo4j/i);
  assert.equal(runtime.protocolEra, 'legacy');
});

test('modern server discovery advertises the modern protocol and server instructions', async () => {
  const { service } = createServiceStub();
  const runtime = createMcpRuntime({ service });

  const response = await runtime.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'server/discover',
    params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_MODERN } },
  });

  assert.equal(response.result.resultType, 'complete');
  assert.deepEqual(response.result.supportedVersions, [MCP_PROTOCOL_MODERN]);
  assert.deepEqual(response.result.capabilities, { tools: { listChanged: false } });
  assert.equal(response.result.ttlMs, 0);
  assert.equal(response.result.cacheScope, 'private');
  assert.deepEqual(response.result._meta['io.modelcontextprotocol/serverInfo'], {
    name: 'graph-reasoning',
    version: '0.2.1',
  });
  assert.equal(response.result.serverInfo, undefined);
  assert.match(response.result.instructions, /concise/i);
  assert.equal(runtime.protocolEra, 'modern');
});

test('tools/list uses legacy response shape after initialize', async () => {
  const { service } = createServiceStub();
  const runtime = createMcpRuntime({ service });
  await runtime.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

  const response = await runtime.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

  assert.equal(response.result.resultType, undefined);
  assert.deepEqual(response.result.tools.map((tool) => tool.name), TOOL_NAMES);
});

test('tools/list uses modern complete response shape after discovery', async () => {
  const { service } = createServiceStub();
  const runtime = createMcpRuntime({ service });
  await runtime.handle({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} });

  const response = await runtime.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

  assert.equal(response.result.resultType, 'complete');
  assert.equal(response.result.ttlMs, 0);
  assert.equal(response.result.cacheScope, 'private');
  assert.deepEqual(response.result._meta['io.modelcontextprotocol/serverInfo'], {
    name: 'graph-reasoning',
    version: '0.2.1',
  });
  assert.deepEqual(response.result.tools.map((tool) => tool.name), TOOL_NAMES);
});

test('tools/call dispatches structured arguments and returns text plus structured content', async () => {
  const { service, calls } = createServiceStub();
  const runtime = createMcpRuntime({ service });
  await runtime.handle({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} });

  const response = await runtime.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'reasoning_inspect',
      arguments: { run_id: 'RUN-1', view: 'frontier' },
    },
  });

  assert.deepEqual(calls, [{
    name: 'reasoning_inspect',
    args: { run_id: 'RUN-1', view: 'frontier' },
  }]);
  assert.equal(response.result.resultType, 'complete');
  assert.deepEqual(response.result._meta['io.modelcontextprotocol/serverInfo'], {
    name: 'graph-reasoning',
    version: '0.2.1',
  });
  assert.equal(response.result.isError, false);
  assert.deepEqual(response.result.structuredContent, {
    tool: 'reasoning_inspect',
    args: { run_id: 'RUN-1', view: 'frontier' },
  });
  assert.equal(response.result.content[0].type, 'text');
  assert.deepEqual(JSON.parse(response.result.content[0].text), response.result.structuredContent);
});

test('modern protocol rejects the legacy ping method', async () => {
  const { service } = createServiceStub();
  const runtime = createMcpRuntime({ service });
  await runtime.handle({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} });

  const response = await runtime.handle({ jsonrpc: '2.0', id: 2, method: 'ping', params: {} });

  assert.equal(response.error.code, -32601);
});

test('notifications produce no JSON-RPC response', async () => {
  const { service } = createServiceStub();
  const runtime = createMcpRuntime({ service });

  assert.equal(await runtime.handle({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {},
  }), null);
});

test('unknown methods return JSON-RPC method-not-found', async () => {
  const { service } = createServiceStub();
  const runtime = createMcpRuntime({ service });

  const response = await runtime.handle({ jsonrpc: '2.0', id: 8, method: 'unknown/method' });

  assert.equal(response.error.code, -32601);
  assert.match(response.error.message, /unknown\/method/);
});

test('invalid requests return JSON-RPC invalid-request', async () => {
  const { service } = createServiceStub();
  const runtime = createMcpRuntime({ service });

  const response = await runtime.handle({ id: 9, method: 'tools/list' });

  assert.equal(response.error.code, -32600);
});
