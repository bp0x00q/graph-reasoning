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
    this.executions = [];
    this.runs = [];
  }
  async ensureSchema() {}
  async execute(statements) {
    this.executions.push(statements);
    return this.executeHandler
      ? this.executeHandler(statements, this.executions.length)
      : statements.map(() => ({ columns: [], rows: [] }));
  }
  async run(statement, parameters = {}) {
    this.runs.push({ statement, parameters });
    return this.runHandler
      ? this.runHandler(statement, parameters, this.runs.length)
      : { columns: [], rows: [] };
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

function service(client) {
  return new ReasoningGraphService({
    client,
    idFactory: deterministicIds(),
    now: () => '2026-08-21T13:00:00.000Z',
  });
}

function projection(activeBranch = null) {
  return [
    { columns: ['run'], rows: [[{
      id: 'RUN-1', goal: 'Diagnose', task_type: 'debugging', status: 'active',
      active_state: { id: 'STATE-1', sequence: 3, reason: 'backtrack' },
      active_branch: activeBranch,
    }]] },
    { columns: ['nodes'], rows: [[[]]] },
    { columns: ['nodes'], rows: [[[]]] },
    { columns: ['branches'], rows: [[[]]] },
    { columns: ['branches'], rows: [[[]]] },
    { columns: ['nodes'], rows: [[[]]] },
  ];
}

test('backtrack closes the failed branch, preserves evidence kinds, invalidates derived claims, and enters a sibling', async () => {
  const client = new RecordingClient({
    runHandler(statement) {
      if (statement.includes('/* backtrack:context */')) {
        assert.match(
          statement,
          /path=\(from\)-\[:CHILD_OF\*0\.\.\]->\(branchPointBranch:Branch\)<-\[:HAS_BRANCH\]-\(bp\)/,
        );
        return { columns: ['context'], rows: [[{
          valid: true,
          from_branch: {
            id: 'BR-FAILED',
            branchpoint_id: 'BP-1',
            parent_branch_id: null,
            primary_hypothesis_id: 'HYP-FAILED',
          },
          departing_branch: { id: 'BR-FAILED', primary_hypothesis_id: 'HYP-FAILED' },
          path_branch_ids: ['BR-FAILED'],
          branchpoint: { id: 'BP-1', root_state_id: 'STATE-ROOT', parent_branch_id: null },
          siblings: [
            { id: 'BR-FAILED', status: 'exploring' },
            { id: 'BR-NEXT', status: 'unexplored' },
          ],
        }]] };
      }
      if (statement.includes('/* backtrack:validate_targets */')) {
        return { columns: ['valid_ids'], rows: [[['EVID-1', 'CONTRA-1', 'HYP-FAILED']]] };
      }
      throw new Error(`Unexpected query: ${statement}`);
    },
    executeHandler(statements) {
      if (statements[0].statement.includes('/* backtrack:transition */')) {
        return statements.map((statement, index) => {
          if (index === 0) return { columns: ['transition'], rows: [[{ state_id: 'STATE-1' }]] };
          if (statement.statement.includes('/* backtrack:invalidate */')) {
            return { columns: ['invalidated'], rows: [[['HYP-FAILED', 'ASM-1', 'INF-1', 'CONC-1']]] };
          }
          return { columns: [], rows: [] };
        });
      }
      if (statements[0].statement.includes('/* inspect:run */')) {
        return projection({ id: 'BR-NEXT', label: 'Sibling', hypothesis: 'Try sibling', status: 'exploring' });
      }
      throw new Error(`Unexpected transaction: ${statements[0].statement}`);
    },
  });

  const result = await service(client).backtrack({
    run_id: 'RUN-1',
    from_branch_id: 'BR-FAILED',
    target_branchpoint_id: 'BP-1',
    disposition: 'refuted',
    basis: {
      reason: 'Observed behavior contradicts the central assumption',
      evidence_ids: ['EVID-1'],
      contradiction_ids: ['CONTRA-1'],
      refutes_node_ids: ['HYP-FAILED'],
    },
    next: { mode: 'first_unexplored' },
  });

  assert.equal(result.closed_branch_id, 'BR-FAILED');
  assert.equal(result.next_branch_id, 'BR-NEXT');
  assert.equal(result.active_state_id, 'STATE-1');
  assert.deepEqual(result.invalidated_node_ids, ['HYP-FAILED', 'ASM-1', 'INF-1', 'CONC-1']);
  assert.deepEqual(result.retained_kinds, ['observation', 'evidence', 'contradiction']);

  const statements = client.executions[0];
  assert.match(statements[0].statement, /BACKTRACKED_TO/);
  assert.match(statements[0].statement, /dispositionReason/);
  const invalidation = statements.find((item) => item.statement.includes('/* backtrack:invalidate */'));
  assert.deepEqual(invalidation.parameters.invalidatableKinds, [
    'hypothesis', 'assumption', 'inference', 'conclusion', 'question', 'uncertainty',
  ]);
  assert.ok(!invalidation.parameters.invalidatableKinds.includes('observation'));
  assert.ok(!invalidation.parameters.invalidatableKinds.includes('evidence'));
  assert.ok(statements.some((item) => item.statement.includes('/* backtrack:basis-links */')));
  assert.ok(statements.some((item) => item.statement.includes('ACTIVE_BRANCH')));
});

test('suspending a branch preserves its branch-local reasoning for later resumption', async () => {
  const client = new RecordingClient({
    runHandler(statement) {
      if (statement.includes('/* backtrack:context */')) {
        return { columns: ['context'], rows: [[{
          valid: true,
          from_branch: {
            id: 'BR-PAUSED',
            branchpoint_id: 'BP-1',
            parent_branch_id: null,
            primary_hypothesis_id: 'HYP-PAUSED',
          },
          departing_branch: { id: 'BR-PAUSED', primary_hypothesis_id: 'HYP-PAUSED' },
          path_branch_ids: ['BR-PAUSED'],
          branchpoint: { id: 'BP-1', root_state_id: 'STATE-ROOT', parent_branch_id: null },
          siblings: [
            { id: 'BR-PAUSED', status: 'exploring' },
            { id: 'BR-NEXT', status: 'unexplored' },
          ],
        }]] };
      }
      if (statement.includes('/* backtrack:validate_targets */')) {
        return { columns: ['valid_ids'], rows: [[['EVID-1']]] };
      }
      throw new Error(`Unexpected query: ${statement}`);
    },
    executeHandler(statements) {
      if (statements[0].statement.includes('/* backtrack:transition */')) {
        assert.ok(!statements.some((item) => item.statement.includes('/* backtrack:invalidate */')));
        return statements.map((_statement, index) => index === 0
          ? { columns: ['transition'], rows: [[{ state_id: 'STATE-1' }]] }
          : { columns: [], rows: [] });
      }
      if (statements[0].statement.includes('/* inspect:run */')) {
        return projection({ id: 'BR-NEXT', label: 'Sibling', hypothesis: 'Try sibling', status: 'exploring' });
      }
      throw new Error(`Unexpected transaction: ${statements[0].statement}`);
    },
  });

  const result = await service(client).backtrack({
    run_id: 'RUN-1',
    from_branch_id: 'BR-PAUSED',
    target_branchpoint_id: 'BP-1',
    disposition: 'suspended',
    basis: {
      reason: 'Collected useful evidence; testing the sibling now',
      evidence_ids: ['EVID-1'],
    },
    next: { mode: 'first_unexplored' },
  });

  assert.equal(result.disposition, 'suspended');
  assert.deepEqual(result.invalidated_node_ids, []);
  assert.equal(result.next_branch_id, 'BR-NEXT');
});

test('backtrack rejects a branchpoint outside the current lineage', async () => {
  const client = new RecordingClient({
    runHandler: async () => ({ columns: ['context'], rows: [[{ valid: false }]] }),
  });

  await assert.rejects(
    service(client).backtrack({
      run_id: 'RUN-1',
      from_branch_id: 'BR-1',
      target_branchpoint_id: 'BP-OTHER',
      disposition: 'refuted',
      basis: { reason: 'Contradicted' },
      next: { mode: 'none' },
    }),
    (error) => error instanceof GraphReasoningError && error.code === 'INVALID_BACKTRACK_TARGET',
  );
  assert.equal(client.executions.length, 0);
});

test('deep backtrack closes and invalidates the entire abandoned path to the target branchpoint', async () => {
  const client = new RecordingClient({
    runHandler(statement) {
      if (statement.includes('/* backtrack:context */')) {
        return { columns: ['context'], rows: [[{
          valid: true,
          from_branch: {
            id: 'BR-A1',
            branchpoint_id: 'BP-NESTED',
            parent_branch_id: 'BR-A',
            primary_hypothesis_id: 'HYP-A1',
          },
          departing_branch: { id: 'BR-A', primary_hypothesis_id: 'HYP-A' },
          path_branch_ids: ['BR-A1', 'BR-A'],
          branchpoint: { id: 'BP-ROOT', root_state_id: 'STATE-ROOT', parent_branch_id: null },
          siblings: [
            { id: 'BR-A', status: 'exploring' },
            { id: 'BR-B', status: 'unexplored' },
          ],
        }]] };
      }
      if (statement.includes('/* backtrack:validate_targets */')) {
        return { columns: ['valid_ids'], rows: [[['EVID-ROOT', 'HYP-A']]] };
      }
      throw new Error(`Unexpected query: ${statement}`);
    },
    executeHandler(statements) {
      if (statements[0].statement.includes('/* backtrack:transition */')) {
        const pathStatus = statements.find((item) => item.statement.includes('/* backtrack:path-status */'));
        const invalidation = statements.find((item) => item.statement.includes('/* backtrack:invalidate */'));
        assert.deepEqual(pathStatus.parameters.pathBranchIds, ['BR-A1', 'BR-A']);
        assert.equal(pathStatus.parameters.departingBranchId, 'BR-A');
        assert.deepEqual(invalidation.parameters.pathBranchIds, ['BR-A1', 'BR-A']);
        return statements.map((statement, index) => {
          if (index === 0) return { columns: ['transition'], rows: [[{ state_id: 'STATE-1' }]] };
          if (statement.statement.includes('/* backtrack:invalidate */')) {
            return { columns: ['invalidated'], rows: [[['HYP-A', 'HYP-A1', 'INF-A1']]] };
          }
          return { columns: [], rows: [] };
        });
      }
      if (statements[0].statement.includes('/* inspect:run */')) {
        return projection({ id: 'BR-B', label: 'Root sibling', hypothesis: 'Alternative B', status: 'exploring' });
      }
      throw new Error(`Unexpected transaction: ${statements[0].statement}`);
    },
  });

  const result = await service(client).backtrack({
    run_id: 'RUN-1',
    from_branch_id: 'BR-A1',
    target_branchpoint_id: 'BP-ROOT',
    disposition: 'refuted',
    basis: { reason: 'The root alternative is contradicted', evidence_ids: ['EVID-ROOT'] },
    next: { mode: 'first_unexplored' },
  });

  assert.equal(result.source_branch_id, 'BR-A1');
  assert.equal(result.closed_branch_id, 'BR-A');
  assert.deepEqual(result.abandoned_path_branch_ids, ['BR-A1', 'BR-A']);
  assert.equal(result.next_branch_id, 'BR-B');
});

test('backtrack rejects missing evidence references before mutating the graph', async () => {
  const client = new RecordingClient({
    runHandler(statement) {
      if (statement.includes('/* backtrack:context */')) {
        return { columns: ['context'], rows: [[{
          valid: true,
          from_branch: {
            id: 'BR-FAILED',
            branchpoint_id: 'BP-1',
            parent_branch_id: null,
            primary_hypothesis_id: 'HYP-FAILED',
          },
          departing_branch: { id: 'BR-FAILED', primary_hypothesis_id: 'HYP-FAILED' },
          path_branch_ids: ['BR-FAILED'],
          branchpoint: { id: 'BP-1', root_state_id: 'STATE-ROOT', parent_branch_id: null },
          siblings: [{ id: 'BR-FAILED', status: 'exploring' }],
        }]] };
      }
      if (statement.includes('/* backtrack:validate_targets */')) {
        return { columns: ['valid_ids'], rows: [[['HYP-FAILED']]] };
      }
      throw new Error(`Unexpected query: ${statement}`);
    },
    executeHandler() {
      throw new Error('Backtrack must not mutate Neo4j when evidence is missing');
    },
  });

  await assert.rejects(
    service(client).backtrack({
      run_id: 'RUN-1',
      from_branch_id: 'BR-FAILED',
      target_branchpoint_id: 'BP-1',
      disposition: 'refuted',
      basis: { reason: 'Contradicted', evidence_ids: ['EVID-MISSING'] },
      next: { mode: 'none' },
    }),
    (error) => error instanceof GraphReasoningError
      && error.code === 'INVALID_REFERENCE'
      && error.details.missing_node_ids[0] === 'EVID-MISSING',
  );
  assert.equal(client.executions.length, 0);
});

test('integrate requires active support nodes and creates a global synthesized conclusion', async () => {
  const client = new RecordingClient({
    runHandler(statement) {
      if (statement.includes('/* integrate:validate */')) {
        assert.match(statement, /n\.status IN \['active', 'supported'\]/);
        return { columns: ['validation'], rows: [[{
          valid_branch_ids: ['BR-1', 'BR-2'],
          valid_node_ids: ['EVID-1', 'INF-2'],
          invalid_node_ids: [],
        }]] };
      }
      throw new Error(`Unexpected query: ${statement}`);
    },
    executeHandler(statements) {
      if (statements[0].statement.includes('/* integrate:create */')) {
        return statements.map((_statement, index) => index === 0
          ? { columns: ['created'], rows: [[{ conclusion_id: 'NODE-1', state_id: 'STATE-1' }]] }
          : { columns: [], rows: [] });
      }
      if (statements[0].statement.includes('/* inspect:run */')) return projection();
      throw new Error(`Unexpected transaction: ${statements[0].statement}`);
    },
  });

  const result = await service(client).integrate({
    run_id: 'RUN-1',
    source_branch_ids: ['BR-1', 'BR-2'],
    conclusion: 'Both malformed input and a fail-open fallback are required',
    supporting_node_ids: ['EVID-1', 'INF-2'],
  });

  assert.equal(result.conclusion_id, 'NODE-1');
  const statements = client.executions[0];
  assert.match(statements[0].statement, /scope: 'global'/);
  assert.match(statements[0].statement, /status: 'supported'/);
  assert.match(statements[0].statement, /OPTIONAL MATCH \(r\)-\[activeBranchRel:ACTIVE_BRANCH\]->\(:Branch\)/);
  assert.match(statements[0].statement, /DELETE activeBranchRel/);
  assert.ok(statements.some((item) => item.statement.includes('SYNTHESIZED_FROM')));
  assert.ok(statements.some((item) => item.statement.includes('DEPENDS_ON')));
  const branchWrite = statements.find((item) => item.statement.includes('/* integrate:branches */'));
  assert.match(branchWrite.statement, /CASE[\s\S]*WHEN branch\.status IN \['exploring', 'supported', 'suspended'\][\s\S]*ELSE branch\.status/);
});

test('integrate rejects invalidated support instead of laundering it into a conclusion', async () => {
  const client = new RecordingClient({
    runHandler: async () => ({ columns: ['validation'], rows: [[{
      valid_branch_ids: ['BR-1', 'BR-2'],
      valid_node_ids: ['EVID-1'],
      invalid_node_ids: ['INF-DEAD'],
    }]] }),
  });

  await assert.rejects(
    service(client).integrate({
      run_id: 'RUN-1',
      source_branch_ids: ['BR-1', 'BR-2'],
      conclusion: 'Unsupported synthesis',
      supporting_node_ids: ['EVID-1', 'INF-DEAD'],
    }),
    (error) => error.code === 'INVALID_SUPPORT' && error.details.invalid_node_ids[0] === 'INF-DEAD',
  );
});

test('audit reports invalid dependency paths, unsupported conclusions, graph hygiene findings, and open alternatives', async () => {
  const client = new RecordingClient({
    executeHandler(statements) {
      assert.match(statements[0].statement, /audit:invalid_dependencies/);
      assert.match(statements[1].statement, /audit:unsupported_dependencies/);
      assert.match(statements[2].statement, /audit:unsupported_conclusions/);
      return [
        { columns: ['findings'], rows: [[[
          { node_id: 'CONC-1', dependency_id: 'ASM-DEAD', dependency_status: 'refuted' },
        ]]] },
        { columns: ['findings'], rows: [[[
          { node_id: 'CONC-UNSUPPORTED', dependency_id: 'ASM-UNSUPPORTED', dependency_status: 'unsupported' },
        ]]] },
        { columns: ['findings'], rows: [[[
          { node_id: 'CONC-2', content: 'No support path' },
        ]]] },
        { columns: ['findings'], rows: [[[
          { node_id: 'CONTRA-1', content: 'Unattached contradiction' },
        ]]] },
        { columns: ['findings'], rows: [[[
          { branch_id: 'BR-REFUTED', label: 'Refuted without basis' },
        ]]] },
        { columns: ['findings'], rows: [[[
          { branch_id: 'BR-OPEN', label: 'Still open' },
        ]]] },
      ];
    },
  });

  const result = await service(client).audit({ run_id: 'RUN-1' });

  assert.equal(result.status, 'failed');
  assert.equal(result.summary.high, 3);
  assert.equal(result.summary.medium, 2);
  assert.equal(result.summary.info, 1);
  assert.deepEqual(result.findings.map((finding) => finding.type), [
    'invalidated_dependency',
    'unsupported_dependency',
    'unsupported_conclusion',
    'unattached_contradiction',
    'refuted_branch_without_basis',
    'unexplored_branch',
  ]);
});

test('finish blocks high-severity audit failures unless force is explicitly set', async () => {
  const client = new RecordingClient({
    executeHandler(statements) {
      if (statements[0].statement.includes('audit:invalid_dependencies')) {
        return [
          { columns: ['findings'], rows: [[[{ node_id: 'CONC-1', dependency_id: 'ASM-1', dependency_status: 'invalidated' }]]] },
          { columns: ['findings'], rows: [[[]]] },
          { columns: ['findings'], rows: [[[]]] },
          { columns: ['findings'], rows: [[[]]] },
          { columns: ['findings'], rows: [[[]]] },
          { columns: ['findings'], rows: [[[]]] },
        ];
      }
      throw new Error('Finalization write must not run while blocked');
    },
  });

  const result = await service(client).finish({ run_id: 'RUN-1' });

  assert.equal(result.status, 'blocked');
  assert.equal(result.audit.summary.high, 1);
  assert.equal(client.executions.length, 1);
});

test('finish finalizes and returns graph-derived conclusions, rejected paths, unresolved items, and coverage', async () => {
  let auditCount = 0;
  const client = new RecordingClient({
    executeHandler(statements) {
      if (statements[0].statement.includes('audit:invalid_dependencies')) {
        auditCount += 1;
        return statements.map((_statement, index) => ({ columns: ['findings'], rows: [[index === 5
          ? [{ branch_id: 'BR-OPEN', label: 'Open alternative' }]
          : []]] }));
      }
      if (statements[0].statement.includes('/* finish:run */')) {
        assert.match(
          statements[0].statement,
          /SET r\.status[\s\S]*WITH r[\s\S]*OPTIONAL MATCH/,
          'finish query must introduce WITH before reading after SET',
        );
        return [
          { columns: ['run'], rows: [[{ id: 'RUN-1', status: 'completed' }]] },
          { columns: ['conclusions'], rows: [[[{ id: 'CONC-1', content: 'Root cause found' }]]] },
          { columns: ['branches'], rows: [[[{ id: 'BR-1', status: 'refuted', reason: 'Contradicted' }]]] },
          { columns: ['nodes'], rows: [[[{ id: 'Q-1', content: 'Secondary path remains' }]]] },
          { columns: ['coverage'], rows: [[{ total: 3, explored: 2, unexplored: 1 }]] },
        ];
      }
      throw new Error(`Unexpected transaction: ${statements[0].statement}`);
    },
  });

  const result = await service(client).finish({ run_id: 'RUN-1' });

  assert.equal(auditCount, 1);
  assert.equal(result.status, 'completed');
  assert.equal(result.supported_conclusions[0].content, 'Root cause found');
  assert.equal(result.rejected_branches[0].id, 'BR-1');
  assert.equal(result.unresolved[0].id, 'Q-1');
  assert.deepEqual(result.branch_coverage, { total: 3, explored: 2, unexplored: 1 });
  assert.equal(result.audit.status, 'passed_with_findings');
});
