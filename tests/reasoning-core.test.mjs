import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GraphReasoningError,
  ReasoningGraphService,
} from '../server/index.mjs';

class RecordingClient {
  constructor({ executeHandler, runHandler } = {}) {
    this.executeHandler = executeHandler;
    this.runHandler = runHandler;
    this.schemaCalls = 0;
    this.executions = [];
    this.runs = [];
  }

  async ensureSchema() {
    this.schemaCalls += 1;
  }

  async execute(statements) {
    this.executions.push(statements);
    if (this.executeHandler) return this.executeHandler(statements, this.executions.length);
    return statements.map(() => ({ columns: [], rows: [] }));
  }

  async run(statement, parameters = {}) {
    this.runs.push({ statement, parameters });
    if (this.runHandler) return this.runHandler(statement, parameters, this.runs.length);
    return { columns: [], rows: [] };
  }
}

function deterministicIds() {
  const counts = new Map();
  return (prefix) => {
    const next = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, next);
    return `${prefix}-${next}`;
  };
}

function projectionResults({ activeBranch = null } = {}) {
  return [
    { columns: ['run'], rows: [[{
      id: 'RUN-1',
      goal: 'Find the failure',
      task_type: 'debugging',
      status: 'active',
      active_state: { id: 'STATE-1', sequence: 0, reason: 'run_started' },
      active_branch: activeBranch,
    }]] },
    { columns: ['nodes'], rows: [[[
      { id: 'NODE-1', kind: 'observation', content: 'Failure is intermittent', status: 'active' },
    ]]] },
    { columns: ['nodes'], rows: [[activeBranch ? [
      { id: 'NODE-2', kind: 'hypothesis', content: activeBranch.hypothesis, status: 'unsupported' },
    ] : []]] },
    { columns: ['branches'], rows: [[[]]] },
    { columns: ['branches'], rows: [[[]]] },
    { columns: ['nodes'], rows: [[[]]] },
  ];
}

function serviceWithClient(client) {
  return new ReasoningGraphService({
    client,
    idFactory: deterministicIds(),
    now: () => '2026-08-21T12:00:00.000Z',
  });
}

test('start creates a run, root state, and global initial context before projecting Neo4j state', async () => {
  const client = new RecordingClient({
    executeHandler(statements) {
      if (statements[0].statement.includes('/* start:create */')) {
        return [{ columns: ['created'], rows: [[{ run_id: 'RUN-1', state_id: 'STATE-1' }]] }];
      }
      if (statements[0].statement.includes('/* inspect:run */')) return projectionResults();
      throw new Error(`Unexpected statement: ${statements[0].statement}`);
    },
  });
  const service = serviceWithClient(client);

  const result = await service.start({
    mode: 'create',
    goal: 'Find the failure',
    task_type: 'debugging',
    initial_context: {
      observations: ['Failure is intermittent'],
      constraints: ['Do not modify production data'],
      questions: ['Which layer fails first?'],
    },
  });

  assert.equal(client.schemaCalls, 1);
  assert.equal(result.run_id, 'RUN-1');
  assert.equal(result.root_state_id, 'STATE-1');
  assert.equal(result.active_projection.goal, 'Find the failure');

  const write = client.executions[0][0];
  assert.match(write.statement, /CREATE \(r:Run/);
  assert.match(write.statement, /CREATE \(s:State/);
  assert.match(write.statement, /ACTIVE_STATE/);
  assert.match(write.statement, /CONTAINS/);
  assert.equal(write.parameters.nodes.length, 3);
  assert.deepEqual(write.parameters.nodes.map((node) => node.kind), [
    'observation', 'constraint', 'question',
  ]);
  assert.ok(write.parameters.nodes.every((node) => node.scope === 'global'));
});

test('resume reads the authoritative graph without creating a parallel run', async () => {
  const client = new RecordingClient({
    executeHandler(statements) {
      if (statements[0].statement.includes('/* inspect:run */')) return projectionResults();
      throw new Error('Resume must not mutate the graph');
    },
  });
  const service = serviceWithClient(client);

  const result = await service.start({ mode: 'resume', run_id: 'RUN-1' });

  assert.equal(result.run_id, 'RUN-1');
  assert.equal(result.resumed, true);
  assert.equal(client.executions.length, 1);
  assert.match(client.executions[0][0].statement, /inspect:run/);
});

test('active context projects branch-local nodes from the active branch and its ancestors', async () => {
  const client = new RecordingClient({
    executeHandler(statements) {
      const branchProjection = statements.find((item) => item.statement.includes('/* inspect:branch_nodes */'));
      assert.match(
        branchProjection.statement,
        /\(activeBranch\)-\[:CHILD_OF\*0\.\.\]->\(contextBranch:Branch\)/,
      );
      return projectionResults({
        activeBranch: { id: 'BR-CHILD', label: 'Nested path', hypothesis: 'Nested hypothesis', status: 'exploring' },
      });
    },
  });

  const result = await serviceWithClient(client).inspect({ run_id: 'RUN-1', view: 'active_context' });

  assert.equal(result.active_branch.id, 'BR-CHILD');
  assert.equal(result.branch_nodes.length, 1);
});

test('advance creates a new state, typed nodes, dependency links, and refutation invalidation', async () => {
  const client = new RecordingClient({
    runHandler(statement) {
      if (statement.includes('/* lookup:branch */')) {
        return { columns: ['branch'], rows: [[{ id: 'BR-1', status: 'exploring' }]] };
      }
      if (statement.includes('/* advance:validate_targets */')) {
        return { columns: ['valid_ids'], rows: [[['ASM-OLD', 'NODE-1']]] };
      }
      throw new Error(`Unexpected lookup: ${statement}`);
    },
    executeHandler(statements) {
      if (statements[0].statement.includes('/* advance:state */')) {
        return statements.map((_statement, index) => index === 0
          ? { columns: ['state'], rows: [[{ id: 'STATE-1', sequence: 2 }]] }
          : { columns: [], rows: [] });
      }
      if (statements[0].statement.includes('/* inspect:run */')) {
        return projectionResults({
          activeBranch: { id: 'BR-1', label: 'Parser', hypothesis: 'Parser rejects input', status: 'exploring' },
        });
      }
      throw new Error(`Unexpected execute: ${statements[0].statement}`);
    },
  });
  const service = serviceWithClient(client);

  const result = await service.advance({
    run_id: 'RUN-1',
    branch_id: 'BR-1',
    operations: [
      {
        type: 'evidence',
        content: 'Default configuration reproduces the failure',
        scope: 'branch',
        refutes: ['ASM-OLD'],
      },
      {
        type: 'inference',
        content: 'Configuration shape is not causal',
        scope: 'branch',
        depends_on: ['NODE-1'],
      },
    ],
  });

  assert.equal(result.active_state_id, 'STATE-1');
  assert.equal(result.committed.length, 2);
  const statements = client.executions[0];
  assert.match(statements[0].statement, /PREVIOUS_STATE/);
  assert.ok(statements.some((item) => item.statement.includes('CREATE (source)-[:DEPENDS_ON]->(target)')));
  assert.ok(statements.some((item) => item.statement.includes('CREATE (source)-[:REFUTES]->(target)')));
  assert.ok(statements.some((item) => item.statement.includes('DEPENDS_ON*1..')));
  assert.ok(statements.some((item) => item.statement.includes('/* advance:focus */')));
  const nodeWrite = statements.find((item) => item.statement.includes('/* advance:nodes */'));
  assert.equal(nodeWrite.parameters.nodes.length, 2);
  assert.ok(nodeWrite.parameters.nodes.every((node) => node.branchId === 'BR-1'));
});

test('advance rejects branch-local operations when no valid branch exists', async () => {
  const client = new RecordingClient({
    runHandler: async () => ({ columns: ['branch'], rows: [] }),
  });
  const service = serviceWithClient(client);

  await assert.rejects(
    service.advance({
      run_id: 'RUN-1',
      branch_id: 'MISSING',
      operations: [{ type: 'assumption', content: 'Something', scope: 'branch' }],
    }),
    (error) => error instanceof GraphReasoningError && error.code === 'BRANCH_NOT_FOUND',
  );
  assert.equal(client.executions.length, 0);
});

test('advance rejects writes into a closed reasoning branch', async () => {
  const client = new RecordingClient({
    runHandler: async () => ({
      columns: ['branch'],
      rows: [[{ id: 'BR-DEAD', status: 'refuted', label: 'Dead path' }]],
    }),
  });

  await assert.rejects(
    serviceWithClient(client).advance({
      run_id: 'RUN-1',
      branch_id: 'BR-DEAD',
      operations: [{ type: 'observation', content: 'Late mutation', scope: 'branch' }],
    }),
    (error) => error instanceof GraphReasoningError && error.code === 'BRANCH_CLOSED',
  );
  assert.equal(client.executions.length, 0);
});

test('advance rejects missing graph references before mutating the run', async () => {
  const client = new RecordingClient({
    runHandler(statement) {
      if (statement.includes('/* lookup:branch */')) {
        return { columns: ['branch'], rows: [[{ id: 'BR-1', status: 'exploring' }]] };
      }
      if (statement.includes('/* advance:validate_targets */')) {
        return { columns: ['valid_ids'], rows: [[['NODE-1']]] };
      }
      throw new Error(`Unexpected lookup: ${statement}`);
    },
    executeHandler() {
      throw new Error('Advance must not mutate Neo4j when a dependency ID is missing');
    },
  });

  await assert.rejects(
    serviceWithClient(client).advance({
      run_id: 'RUN-1',
      branch_id: 'BR-1',
      operations: [{
        type: 'inference',
        content: 'Derived claim',
        scope: 'branch',
        depends_on: ['NODE-1', 'NODE-MISSING'],
      }],
    }),
    (error) => error instanceof GraphReasoningError
      && error.code === 'INVALID_REFERENCE'
      && error.details.missing_node_ids[0] === 'NODE-MISSING',
  );
  assert.equal(client.executions.length, 0);
});

test('branch creates a graph branch point, primary hypotheses, lineage, and selected focus', async () => {
  const client = new RecordingClient({
    runHandler(statement) {
      if (statement.includes('/* lookup:state */')) {
        return { columns: ['context'], rows: [[{
          state_id: 'STATE-1',
          branch_id: 'BR-PARENT',
        }]] };
      }
      throw new Error(`Unexpected lookup: ${statement}`);
    },
    executeHandler(statements) {
      if (statements[0].statement.includes('/* branch:create */')) {
        return statements.map((_statement, index) => index === 0
          ? { columns: ['created'], rows: [[{ branchpoint_id: 'BP-1', state_id: 'STATE-2' }]] }
          : { columns: [], rows: [] });
      }
      if (statements[0].statement.includes('/* inspect:run */')) {
        return projectionResults({
          activeBranch: { id: 'BRANCH-2', label: 'Permissions', hypothesis: 'Access is denied', status: 'exploring' },
        });
      }
      throw new Error(`Unexpected execute: ${statements[0].statement}`);
    },
  });
  const service = serviceWithClient(client);

  const result = await service.branch({
    run_id: 'RUN-1',
    from_state_id: 'STATE-1',
    question: 'Which subsystem is failing?',
    alternatives: [
      { label: 'Parser', hypothesis: 'Input parsing fails', distinguishing_test: 'Run parser fixture' },
      { label: 'Permissions', hypothesis: 'Access is denied', distinguishing_test: 'Test service account access' },
    ],
    focus_index: 1,
  });

  assert.equal(result.branchpoint_id, 'BRANCHPOINT-1');
  assert.equal(result.active_state_id, 'STATE-1');
  assert.equal(result.focused_branch_id, 'BRANCH-2');
  assert.deepEqual(result.created_branches.map((branch) => branch.id), ['BRANCH-1', 'BRANCH-2']);

  const statements = client.executions[0];
  const create = statements[0];
  assert.match(create.statement, /BranchPoint/);
  assert.match(create.statement, /HAS_BRANCH/);
  assert.match(create.statement, /ROOTED_AT/);
  assert.match(create.statement, /PRIMARY_HYPOTHESIS/);
  assert.equal(create.parameters.branches.length, 2);
  assert.ok(statements.some((item) => item.statement.includes('CHILD_OF')));
  assert.ok(statements.some((item) => item.statement.includes('ACTIVE_BRANCH')));
});

test('branching from an explicit root state does not inherit the currently active branch', async () => {
  const client = new RecordingClient({
    runHandler(statement) {
      if (statement.includes('/* lookup:state */')) {
        const leaksActiveBranch = statement.includes('coalesce(s.branchId, activeBranch.id)');
        return { columns: ['context'], rows: [[{
          state_id: 'STATE-ROOT',
          branch_id: leaksActiveBranch ? 'BR-ACTIVE' : null,
        }]] };
      }
      throw new Error(`Unexpected lookup: ${statement}`);
    },
    executeHandler(statements) {
      if (statements[0].statement.includes('/* branch:create */')) {
        return statements.map((_statement, index) => index === 0
          ? { columns: ['created'], rows: [[{ branchpoint_id: 'BP-ROOT', state_id: 'STATE-NEXT' }]] }
          : { columns: [], rows: [] });
      }
      if (statements[0].statement.includes('/* inspect:run */')) return projectionResults();
      throw new Error(`Unexpected execute: ${statements[0].statement}`);
    },
  });

  await serviceWithClient(client).branch({
    run_id: 'RUN-1',
    from_state_id: 'STATE-ROOT',
    question: 'Which root-level explanation is correct?',
    alternatives: [
      { label: 'A', hypothesis: 'Root alternative A' },
      { label: 'B', hypothesis: 'Root alternative B' },
    ],
    focus_index: null,
  });

  const statements = client.executions[0];
  assert.equal(statements[0].parameters.parentBranchId, null);
  assert.ok(!statements.some((item) => item.statement.includes('/* branch:lineage */')));
});

test('branch rejects duplicate alternatives instead of making cosmetic branches', async () => {
  const client = new RecordingClient();
  const service = serviceWithClient(client);

  await assert.rejects(
    service.branch({
      run_id: 'RUN-1',
      question: 'What failed?',
      alternatives: [
        { label: 'Parser', hypothesis: 'Input parsing fails' },
        { label: 'parser', hypothesis: 'Input parsing fails' },
      ],
    }),
    (error) => error.code === 'DUPLICATE_ALTERNATIVE',
  );
});
