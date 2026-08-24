import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Neo4jHttpClient,
  SCHEMA_STATEMENTS,
} from '../server/index.mjs';

function response({ ok = true, status = 200, body }) {
  return {
    ok,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

test('posts statements to the configured Neo4j transactional HTTP endpoint and decodes rows', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return response({
      body: {
        results: [{
          columns: ['answer'],
          data: [{ row: [42] }, { row: [43] }],
        }],
        errors: [],
      },
    });
  };
  const client = new Neo4jHttpClient({
    baseUrl: 'http://127.0.0.1:7474/',
    database: 'neo4j',
    fetchImpl,
  });

  const results = await client.execute([
    { statement: 'RETURN $value AS answer', parameters: { value: 42 } },
  ]);

  assert.deepEqual(results, [{ columns: ['answer'], rows: [[42], [43]] }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:7474/db/neo4j/tx/commit');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    statements: [{
      statement: 'RETURN $value AS answer',
      parameters: { value: 42 },
      resultDataContents: ['row'],
    }],
  });
});

test('run returns the single statement result', async () => {
  const client = new Neo4jHttpClient({
    fetchImpl: async () => response({
      body: {
        results: [{ columns: ['id'], data: [{ row: ['RUN-1'] }] }],
        errors: [],
      },
    }),
  });

  assert.deepEqual(await client.run('RETURN $id AS id', { id: 'RUN-1' }), {
    columns: ['id'],
    rows: [['RUN-1']],
  });
});

test('Neo4j query errors are surfaced with stable error code and details', async () => {
  const client = new Neo4jHttpClient({
    fetchImpl: async () => response({
      body: {
        results: [],
        errors: [{
          code: 'Neo.ClientError.Statement.SyntaxError',
          message: 'Invalid input',
        }],
      },
    }),
  });

  await assert.rejects(
    client.run('BROKEN CYPHER'),
    (error) => {
      assert.equal(error.code, 'NEO4J_QUERY_ERROR');
      assert.match(error.message, /Invalid input/);
      assert.equal(error.details[0].code, 'Neo.ClientError.Statement.SyntaxError');
      return true;
    },
  );
});

test('HTTP failures are surfaced without pretending they are graph results', async () => {
  const client = new Neo4jHttpClient({
    fetchImpl: async () => response({
      ok: false,
      status: 503,
      body: { message: 'Unavailable' },
    }),
  });

  await assert.rejects(
    client.run('RETURN 1'),
    (error) => {
      assert.equal(error.code, 'NEO4J_HTTP_ERROR');
      assert.match(error.message, /503/);
      return true;
    },
  );
});

test('invalid JSON responses are reported clearly', async () => {
  const client = new Neo4jHttpClient({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() { return '<html>not json</html>'; },
    }),
  });

  await assert.rejects(
    client.run('RETURN 1'),
    (error) => error.code === 'NEO4J_INVALID_RESPONSE',
  );
});

test('schema initialization is idempotent per client and includes every core label', async () => {
  const calls = [];
  const client = new Neo4jHttpClient({
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return response({
        body: {
          results: JSON.parse(init.body).statements.map(() => ({ columns: [], data: [] })),
          errors: [],
        },
      });
    },
  });

  await client.ensureSchema();
  await client.ensureSchema();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].statements.length, SCHEMA_STATEMENTS.length);
  const schemaText = SCHEMA_STATEMENTS.join('\n');
  for (const label of ['Run', 'State', 'BranchPoint', 'Branch', 'ReasoningNode']) {
    assert.match(schemaText, new RegExp(`:${label}\\)`));
  }
});
