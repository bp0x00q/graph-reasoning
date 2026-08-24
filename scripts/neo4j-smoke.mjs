#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  Neo4jHttpClient,
  ReasoningGraphService,
} from '../server/index.mjs';

const client = new Neo4jHttpClient();
const service = new ReasoningGraphService({ client });
let runId;
let succeeded = false;

try {
  const started = await service.start({
    mode: 'create',
    goal: 'Exercise graph-native branching, backtracking, synthesis, and finalization',
    task_type: 'smoke_test',
    initial_context: {
      observations: ['The smoke test has two plausible explanations to explore'],
      constraints: ['Do not use external services'],
    },
  });
  runId = started.run_id;

  const branched = await service.branch({
    run_id: runId,
    from_state_id: started.root_state_id,
    question: 'Which explanation best accounts for the synthetic observation?',
    alternatives: [
      {
        label: 'Input-path explanation',
        hypothesis: 'The input path determines the observed behavior',
        distinguishing_test: 'Record direct evidence about the input path',
      },
      {
        label: 'Fallback-path explanation',
        hypothesis: 'The fallback path also contributes to the observed behavior',
        distinguishing_test: 'Record direct evidence about fallback execution',
      },
    ],
    focus_index: 0,
  });

  const firstBranch = branched.created_branches[0];
  const secondBranch = branched.created_branches[1];

  const firstAdvance = await service.advance({
    run_id: runId,
    branch_id: firstBranch.id,
    operations: [{
      type: 'evidence',
      content: 'Synthetic fixture confirms the input path contributes to the outcome',
      scope: 'branch',
      supports: [firstBranch.primary_hypothesis_id],
    }],
  });
  const firstEvidenceId = firstAdvance.committed[0].id;

  const backtracked = await service.backtrack({
    run_id: runId,
    from_branch_id: firstBranch.id,
    target_branchpoint_id: branched.branchpoint_id,
    disposition: 'suspended',
    basis: {
      reason: 'The first branch has useful evidence; switch to its sibling before synthesizing',
      evidence_ids: [firstEvidenceId],
    },
    next: { mode: 'first_unexplored' },
  });
  assert.equal(backtracked.next_branch_id, secondBranch.id);
  assert.deepEqual(backtracked.invalidated_node_ids, []);

  const secondAdvance = await service.advance({
    run_id: runId,
    branch_id: secondBranch.id,
    operations: [{
      type: 'evidence',
      content: 'Synthetic fixture confirms the fallback path also contributes',
      scope: 'branch',
      supports: [secondBranch.primary_hypothesis_id],
    }],
  });
  const secondEvidenceId = secondAdvance.committed[0].id;

  const integrated = await service.integrate({
    run_id: runId,
    source_branch_ids: [firstBranch.id, secondBranch.id],
    conclusion: 'The synthetic behavior requires contributions from both the input path and the fallback path',
    supporting_node_ids: [firstEvidenceId, secondEvidenceId],
  });

  const finished = await service.finish({ run_id: runId });
  assert.equal(finished.status, 'completed');
  assert.equal(finished.audit.summary.high, 0);
  assert.ok(finished.supported_conclusions.some((item) => item.id === integrated.conclusion_id));

  succeeded = true;
  console.log(JSON.stringify({
    status: 'passed',
    run_id: runId,
    branchpoint_id: branched.branchpoint_id,
    branch_ids: [firstBranch.id, secondBranch.id],
    conclusion_id: integrated.conclusion_id,
    audit: finished.audit.summary,
  }, null, 2));
} catch (error) {
  console.error(`Neo4j smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
  if (error && typeof error === 'object' && 'details' in error && error.details) {
    console.error(JSON.stringify(error.details, null, 2));
  }
  console.error('Start the local Neo4j database, then rerun `node scripts/neo4j-smoke.mjs`.');
  process.exitCode = 1;
} finally {
  if (succeeded && runId && process.env.GRAPH_REASONING_SMOKE_KEEP !== '1') {
    await client.run('MATCH (n) WHERE n.runId = $runId DETACH DELETE n', { runId });
    await client.run('MATCH (r:Run {id: $runId}) DETACH DELETE r', { runId });
  }
}
