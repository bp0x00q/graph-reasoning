#!/usr/bin/env node

import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const MCP_PROTOCOL_LEGACY = '2025-11-25';
export const MCP_PROTOCOL_MODERN = '2026-07-28';
export const SERVER_NAME = 'graph-reasoning';
export const SERVER_VERSION = '0.2.0';
const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';


export class GraphReasoningError extends Error {
  constructor(message, { code = 'GRAPH_REASONING_ERROR', details } = {}) {
    super(message);
    this.name = 'GraphReasoningError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const SCHEMA_STATEMENTS = [
  'CREATE CONSTRAINT run_id IF NOT EXISTS FOR (n:Run) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT state_id IF NOT EXISTS FOR (n:State) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT branchpoint_id IF NOT EXISTS FOR (n:BranchPoint) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT branch_id IF NOT EXISTS FOR (n:Branch) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT reasoning_node_id IF NOT EXISTS FOR (n:ReasoningNode) REQUIRE n.id IS UNIQUE',
  'CREATE INDEX run_status IF NOT EXISTS FOR (n:Run) ON (n.status)',
  'CREATE INDEX branch_run_status IF NOT EXISTS FOR (n:Branch) ON (n.runId, n.status)',
  'CREATE INDEX reasoning_node_run_kind IF NOT EXISTS FOR (n:ReasoningNode) ON (n.runId, n.kind)',
  'CREATE INDEX reasoning_node_run_status IF NOT EXISTS FOR (n:ReasoningNode) ON (n.runId, n.status)',
];

export class Neo4jHttpClient {
  constructor({
    baseUrl = process.env.NEO4J_HTTP_URL ?? 'http://127.0.0.1:7474',
    database = process.env.NEO4J_DATABASE ?? 'neo4j',
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('Neo4jHttpClient requires a fetch implementation');
    }
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.database = String(database);
    this.fetchImpl = fetchImpl;
    this._schemaPromise = null;
  }

  get endpoint() {
    return `${this.baseUrl}/db/${encodeURIComponent(this.database)}/tx/commit`;
  }

  async execute(statements) {
    if (!Array.isArray(statements) || statements.length === 0) {
      throw new TypeError('Neo4j execute requires at least one statement');
    }

    const normalized = statements.map((entry) => {
      const statement = typeof entry === 'string' ? entry : entry?.statement;
      const parameters = typeof entry === 'string' ? {} : entry?.parameters ?? {};
      if (typeof statement !== 'string' || !statement.trim()) {
        throw new TypeError('Each Neo4j statement must be a non-empty string');
      }
      return { statement, parameters, resultDataContents: ['row'] };
    });

    let httpResponse;
    try {
      httpResponse = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ statements: normalized }),
      });
    } catch (error) {
      throw new GraphReasoningError(
        `Unable to connect to Neo4j at ${this.endpoint}: ${error instanceof Error ? error.message : String(error)}`,
        { code: 'NEO4J_CONNECTION_ERROR', details: error },
      );
    }

    const raw = await httpResponse.text();
    let payload;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      throw new GraphReasoningError('Neo4j returned an invalid JSON response', {
        code: 'NEO4J_INVALID_RESPONSE',
        details: { status: httpResponse.status, body: raw.slice(0, 1000) },
      });
    }

    if (!httpResponse.ok) {
      throw new GraphReasoningError(`Neo4j HTTP request failed with status ${httpResponse.status}`, {
        code: 'NEO4J_HTTP_ERROR',
        details: payload,
      });
    }

    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      const first = payload.errors[0];
      throw new GraphReasoningError(`Neo4j query failed: ${first.message ?? first.code ?? 'unknown error'}`, {
        code: 'NEO4J_QUERY_ERROR',
        details: payload.errors,
      });
    }

    if (!Array.isArray(payload.results)) {
      throw new GraphReasoningError('Neo4j response did not contain a results array', {
        code: 'NEO4J_INVALID_RESPONSE',
        details: payload,
      });
    }

    return payload.results.map((result) => ({
      columns: Array.isArray(result.columns) ? result.columns : [],
      rows: Array.isArray(result.data) ? result.data.map((item) => item.row ?? []) : [],
    }));
  }

  async run(statement, parameters = {}) {
    const [result] = await this.execute([{ statement, parameters }]);
    return result;
  }

  async ensureSchema() {
    if (!this._schemaPromise) {
      this._schemaPromise = this.execute(SCHEMA_STATEMENTS.map((statement) => ({ statement, parameters: {} })))
        .catch((error) => {
          this._schemaPromise = null;
          throw error;
        });
    }
    await this._schemaPromise;
  }
}


const VALID_REASONING_KINDS = new Set([
  'observation',
  'question',
  'hypothesis',
  'assumption',
  'constraint',
  'experiment',
  'evidence',
  'inference',
  'contradiction',
  'conclusion',
  'uncertainty',
]);

const VALID_NODE_STATUSES = new Set(['active', 'unsupported', 'supported']);
const ACTIVE_NODE_STATUSES = ['active', 'unsupported', 'supported'];

function defaultIdFactory(prefix) {
  return `${prefix}-${randomUUID()}`;
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GraphReasoningError(`${name} must be an object`, { code: 'INVALID_ARGUMENT' });
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GraphReasoningError(`${name} must be a non-empty string`, { code: 'INVALID_ARGUMENT' });
  }
  return value.trim();
}

function optionalString(value, name) {
  return value === undefined || value === null ? null : requireString(value, name);
}

function stringArray(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new GraphReasoningError(`${name} must be an array`, { code: 'INVALID_ARGUMENT' });
  }
  const result = value.map((item, index) => requireString(item, `${name}[${index}]`));
  if (new Set(result).size !== result.length) {
    throw new GraphReasoningError(`${name} must not contain duplicate IDs`, { code: 'INVALID_ARGUMENT' });
  }
  return result;
}

function firstCell(result, fallback = null) {
  return result?.rows?.[0]?.[0] ?? fallback;
}

function mapNode(node) {
  if (!node) return null;
  return {
    id: node.id,
    kind: node.kind,
    content: node.content,
    scope: node.scope,
    status: node.status,
    branch_id: node.branch_id ?? node.branchId ?? null,
    created_at: node.created_at ?? node.createdAt ?? null,
  };
}

function normalizeAlternative(value, index) {
  const item = requireObject(value, `alternatives[${index}]`);
  return {
    label: requireString(item.label, `alternatives[${index}].label`),
    hypothesis: requireString(item.hypothesis, `alternatives[${index}].hypothesis`),
    distinguishingTest: optionalString(item.distinguishing_test, `alternatives[${index}].distinguishing_test`),
  };
}

export class ReasoningGraphService {
  constructor({
    client = new Neo4jHttpClient(),
    idFactory = defaultIdFactory,
    now = () => new Date().toISOString(),
  } = {}) {
    if (!client || typeof client.execute !== 'function' || typeof client.run !== 'function') {
      throw new TypeError('ReasoningGraphService requires a Neo4j client');
    }
    this.client = client;
    this.idFactory = idFactory;
    this.now = now;
  }

  async start(args = {}) {
    requireObject(args, 'arguments');
    await this.client.ensureSchema();
    const mode = args.mode ?? (args.run_id ? 'resume' : 'create');

    if (mode === 'resume') {
      const runId = requireString(args.run_id, 'run_id');
      const activeProjection = await this._projectActiveContext(runId);
      return { run_id: runId, resumed: true, active_projection: activeProjection };
    }

    if (mode !== 'create') {
      throw new GraphReasoningError(`Unsupported start mode: ${String(mode)}`, { code: 'INVALID_ARGUMENT' });
    }

    const goal = requireString(args.goal, 'goal');
    const taskType = optionalString(args.task_type, 'task_type') ?? 'general';
    const context = args.initial_context === undefined ? {} : requireObject(args.initial_context, 'initial_context');
    const runId = this.idFactory('RUN');
    const stateId = this.idFactory('STATE');
    const createdAt = this.now();
    const nodes = [];

    const addInitial = (kind, content, status = 'active') => {
      nodes.push({
        id: this.idFactory('NODE'),
        runId,
        branchId: null,
        kind,
        content,
        scope: 'global',
        status,
        metadataJson: '{}',
        createdAt,
        updatedAt: createdAt,
      });
    };

    for (const content of stringArray(context.observations, 'initial_context.observations')) addInitial('observation', content);
    for (const content of stringArray(context.constraints, 'initial_context.constraints')) addInitial('constraint', content);
    for (const content of stringArray(context.questions, 'initial_context.questions')) addInitial('question', content, 'unsupported');

    const [writeResult] = await this.client.execute([{
      statement: `/* start:create */
CREATE (r:Run {
  id: $runId,
  goal: $goal,
  taskType: $taskType,
  status: 'active',
  createdAt: $createdAt,
  updatedAt: $createdAt
})
CREATE (s:State {
  id: $stateId,
  runId: $runId,
  sequence: 0,
  reason: 'run_started',
  branchId: null,
  createdAt: $createdAt
})
CREATE (r)-[:ACTIVE_STATE]->(s)
FOREACH (item IN $nodes |
  CREATE (n:ReasoningNode)
  SET n = item
  CREATE (r)-[:CONTAINS]->(n)
  CREATE (s)-[:CONTAINS]->(n)
)
RETURN {run_id: r.id, state_id: s.id} AS created`,
      parameters: { runId, stateId, goal, taskType, createdAt, nodes },
    }]);

    if (!firstCell(writeResult)) {
      throw new GraphReasoningError('Neo4j did not create the reasoning run', { code: 'RUN_CREATE_FAILED' });
    }

    const activeProjection = await this._projectActiveContext(runId);
    return {
      run_id: runId,
      root_state_id: stateId,
      resumed: false,
      active_projection: activeProjection,
      next_expected_operation: 'reasoning_advance',
    };
  }

  async inspect(args = {}) {
    requireObject(args, 'arguments');
    await this.client.ensureSchema();
    const runId = requireString(args.run_id, 'run_id');
    const view = requireString(args.view, 'view');

    if (view === 'active_context') return this._projectActiveContext(runId);
    if (view === 'frontier') return this._inspectFrontier(runId);
    if (view === 'branch') return this._inspectBranch(runId, requireString(args.branch_id, 'branch_id'));
    if (view === 'history') return this._inspectHistory(runId, Number.isInteger(args.limit) ? args.limit : 100);
    if (view === 'audit') return this.audit({ run_id: runId });
    throw new GraphReasoningError(`Unsupported inspection view: ${view}`, { code: 'INVALID_ARGUMENT' });
  }

  async advance(args = {}) {
    requireObject(args, 'arguments');
    await this.client.ensureSchema();
    const runId = requireString(args.run_id, 'run_id');
    if (!Array.isArray(args.operations) || args.operations.length === 0) {
      throw new GraphReasoningError('operations must contain at least one reasoning operation', { code: 'INVALID_ARGUMENT' });
    }
    if (args.operations.length > 50) {
      throw new GraphReasoningError('operations may contain at most 50 items', { code: 'INVALID_ARGUMENT' });
    }

    const rawOperations = args.operations.map((value, index) => {
      const operation = requireObject(value, `operations[${index}]`);
      const kind = requireString(operation.type, `operations[${index}].type`);
      if (!VALID_REASONING_KINDS.has(kind)) {
        throw new GraphReasoningError(`Unsupported reasoning node type: ${kind}`, { code: 'INVALID_ARGUMENT' });
      }
      const scope = operation.scope ?? 'branch';
      if (!['global', 'branch'].includes(scope)) {
        throw new GraphReasoningError(`Unsupported scope: ${String(scope)}`, { code: 'INVALID_ARGUMENT' });
      }
      const status = operation.status ?? (['hypothesis', 'assumption', 'question', 'uncertainty', 'conclusion'].includes(kind) ? 'unsupported' : 'active');
      if (!VALID_NODE_STATUSES.has(status)) {
        throw new GraphReasoningError(`Unsupported node status: ${String(status)}`, { code: 'INVALID_ARGUMENT' });
      }
      return {
        kind,
        content: requireString(operation.content, `operations[${index}].content`),
        scope,
        status,
        dependsOn: stringArray(operation.depends_on, `operations[${index}].depends_on`),
        supports: stringArray(operation.supports, `operations[${index}].supports`),
        refutes: stringArray(operation.refutes, `operations[${index}].refutes`),
        tests: stringArray(operation.tests, `operations[${index}].tests`),
        metadata: operation.metadata && typeof operation.metadata === 'object' && !Array.isArray(operation.metadata)
          ? operation.metadata
          : {},
      };
    });

    const needsBranch = rawOperations.some((operation) => operation.scope === 'branch');
    let branchId = optionalString(args.branch_id, 'branch_id');
    if (!branchId && needsBranch) branchId = await this._lookupActiveBranchId(runId);
    if (branchId) {
      const branch = await this._lookupBranch(runId, branchId);
      if (!branch) {
        throw new GraphReasoningError(`Reasoning branch not found: ${branchId}`, {
          code: 'BRANCH_NOT_FOUND',
        });
      }
      if (['refuted', 'abandoned', 'integrated'].includes(branch.status)) {
        throw new GraphReasoningError(`Reasoning branch is closed and cannot accept new nodes: ${branchId}`, {
          code: 'BRANCH_CLOSED',
          details: { branch_id: branchId, status: branch.status },
        });
      }
    }
    if (needsBranch && !branchId) {
      throw new GraphReasoningError('Branch not found for branch-local reasoning: (none active)', {
        code: 'BRANCH_NOT_FOUND',
      });
    }

    const referencedNodeIds = [...new Set(rawOperations.flatMap((operation) => [
      ...operation.dependsOn,
      ...operation.supports,
      ...operation.refutes,
      ...operation.tests,
    ]))];
    if (referencedNodeIds.length > 0) {
      const validationResult = await this.client.run(`/* advance:validate_targets */
MATCH (r:Run {id: $runId, status: 'active'})
OPTIONAL MATCH (node:ReasoningNode {runId: $runId})
WHERE node.id IN $targetIds
RETURN collect(DISTINCT node.id) AS valid_ids`, {
        runId,
        targetIds: referencedNodeIds,
      });
      const validIds = firstCell(validationResult);
      if (!validIds) {
        throw new GraphReasoningError(`Active run not found: ${runId}`, { code: 'RUN_NOT_FOUND' });
      }
      const missingNodeIds = referencedNodeIds.filter((id) => !validIds.includes(id));
      if (missingNodeIds.length > 0) {
        throw new GraphReasoningError('One or more referenced reasoning nodes do not exist in this active run', {
          code: 'INVALID_REFERENCE',
          details: { missing_node_ids: missingNodeIds },
        });
      }
    }

    const createdAt = this.now();
    const stateId = this.idFactory('STATE');
    const nodes = rawOperations.map((operation) => ({
      id: this.idFactory('NODE'),
      runId,
      branchId: operation.scope === 'branch' ? branchId : null,
      kind: operation.kind,
      content: operation.content,
      scope: operation.scope,
      status: operation.status,
      metadataJson: JSON.stringify(operation.metadata),
      createdAt,
      updatedAt: createdAt,
      dependsOn: operation.dependsOn,
      supports: operation.supports,
      refutes: operation.refutes,
      tests: operation.tests,
    }));

    const linksByType = {
      DEPENDS_ON: [],
      SUPPORTS: [],
      REFUTES: [],
      TESTS: [],
    };
    for (const node of nodes) {
      for (const targetId of node.dependsOn) linksByType.DEPENDS_ON.push({ sourceId: node.id, targetId });
      for (const targetId of node.supports) linksByType.SUPPORTS.push({ sourceId: node.id, targetId });
      for (const targetId of node.refutes) linksByType.REFUTES.push({ sourceId: node.id, targetId });
      for (const targetId of node.tests) linksByType.TESTS.push({ sourceId: node.id, targetId });
    }

    const statements = [{
      statement: `/* advance:state */
MATCH (r:Run {id: $runId, status: 'active'})-[active:ACTIVE_STATE]->(previous:State)
CREATE (next:State {
  id: $stateId,
  runId: $runId,
  sequence: previous.sequence + 1,
  reason: 'advance',
  branchId: $branchId,
  createdAt: $createdAt
})
CREATE (next)-[:PREVIOUS_STATE]->(previous)
DELETE active
CREATE (r)-[:ACTIVE_STATE]->(next)
SET r.updatedAt = $createdAt
RETURN {id: next.id, sequence: next.sequence} AS state`,
      parameters: { runId, stateId, branchId, createdAt },
    }, {
      statement: `/* advance:nodes */
MATCH (r:Run {id: $runId})
MATCH (s:State {id: $stateId, runId: $runId})
UNWIND $nodes AS item
CREATE (n:ReasoningNode)
SET n = item
CREATE (r)-[:CONTAINS]->(n)
CREATE (s)-[:CONTAINS]->(n)
WITH n, item
OPTIONAL MATCH (b:Branch {id: item.branchId, runId: $runId})
FOREACH (_ IN CASE WHEN item.scope = 'branch' THEN [1] ELSE [] END |
  CREATE (b)-[:CONTAINS]->(n)
)
RETURN collect(n.id) AS node_ids`,
      parameters: {
        runId,
        stateId,
        nodes: nodes.map(({ dependsOn, supports, refutes, tests, ...node }) => node),
      },
    }];

    if (branchId) {
      statements.push({
        statement: `/* advance:focus */
MATCH (r:Run {id: $runId})
OPTIONAL MATCH (r)-[old:ACTIVE_BRANCH]->(:Branch)
DELETE old
WITH r
MATCH (selected:Branch {id: $branchId, runId: $runId})
MATCH (selected)-[:CHILD_OF*0..]->(lineage:Branch)
WITH r, selected, collect(DISTINCT lineage) AS lineageBranches
FOREACH (branch IN lineageBranches |
  SET branch.status = CASE WHEN branch.status IN ['unexplored', 'suspended'] THEN 'exploring' ELSE branch.status END,
      branch.updatedAt = $updatedAt
)
CREATE (r)-[:ACTIVE_BRANCH]->(selected)
RETURN selected.id AS active_branch_id`,
        parameters: { runId, branchId, updatedAt: createdAt },
      });
    }

    for (const [relationship, links] of Object.entries(linksByType)) {
      if (links.length === 0) continue;
      statements.push({
        statement: `/* advance:links:${relationship} */
UNWIND $links AS link
MATCH (source:ReasoningNode {id: link.sourceId, runId: $runId})
MATCH (target:ReasoningNode {id: link.targetId, runId: $runId})
CREATE (source)-[:${relationship}]->(target)
RETURN count(*) AS link_count`,
        parameters: { runId, links },
      });
    }

    const refutedTargetIds = [...new Set(linksByType.REFUTES.map((link) => link.targetId))];
    if (refutedTargetIds.length > 0) {
      statements.push({
        statement: `/* advance:refutation */
UNWIND $targetIds AS targetId
MATCH (target:ReasoningNode {id: targetId, runId: $runId})
SET target.status = 'refuted', target.updatedAt = $updatedAt
WITH collect(target) AS targets
UNWIND targets AS target
OPTIONAL MATCH (dependent:ReasoningNode {runId: $runId})-[:DEPENDS_ON*1..]->(target)
WITH targets, collect(DISTINCT dependent) AS dependents
FOREACH (dependent IN dependents |
  SET dependent.status = 'invalidated', dependent.updatedAt = $updatedAt
)
RETURN [target IN targets | target.id] AS refuted_ids,
       [dependent IN dependents | dependent.id] AS invalidated_ids`,
        parameters: { runId, targetIds: refutedTargetIds, updatedAt: createdAt },
      });
    }

    const results = await this.client.execute(statements);
    if (!firstCell(results[0])) {
      throw new GraphReasoningError(`Active run not found: ${runId}`, { code: 'RUN_NOT_FOUND' });
    }

    const activeProjection = await this._projectActiveContext(runId);
    return {
      run_id: runId,
      active_state_id: stateId,
      committed: nodes.map((node) => ({ id: node.id, kind: node.kind, scope: node.scope })),
      refuted_target_ids: refutedTargetIds,
      active_projection: activeProjection,
    };
  }

  async branch(args = {}) {
    requireObject(args, 'arguments');
    await this.client.ensureSchema();
    const runId = requireString(args.run_id, 'run_id');
    const question = requireString(args.question, 'question');
    if (!Array.isArray(args.alternatives) || args.alternatives.length < 2) {
      throw new GraphReasoningError('alternatives must contain at least two branches', { code: 'INVALID_ARGUMENT' });
    }
    const alternatives = args.alternatives.map(normalizeAlternative);
    const labels = alternatives.map((item) => item.label.toLocaleLowerCase());
    const hypotheses = alternatives.map((item) => item.hypothesis.toLocaleLowerCase());
    if (new Set(labels).size !== labels.length || new Set(hypotheses).size !== hypotheses.length) {
      throw new GraphReasoningError('Branch alternatives must be materially distinct, not duplicate labels or hypotheses', {
        code: 'DUPLICATE_ALTERNATIVE',
      });
    }

    const focusIndex = args.focus_index === null ? null : (args.focus_index ?? 0);
    if (focusIndex !== null && (!Number.isInteger(focusIndex) || focusIndex < 0 || focusIndex >= alternatives.length)) {
      throw new GraphReasoningError('focus_index is outside the alternatives array', { code: 'INVALID_ARGUMENT' });
    }

    const fromStateId = optionalString(args.from_state_id, 'from_state_id');
    const stateContext = await this._lookupStateContext(runId, fromStateId);
    if (!stateContext) {
      throw new GraphReasoningError(`Reasoning state not found: ${fromStateId ?? '(active state)'}`, { code: 'STATE_NOT_FOUND' });
    }

    const createdAt = this.now();
    const branchPointId = this.idFactory('BRANCHPOINT');
    const nextStateId = this.idFactory('STATE');
    const branches = alternatives.map((alternative, index) => {
      const branchId = this.idFactory('BRANCH');
      const hypothesisId = this.idFactory('NODE');
      return {
        id: branchId,
        label: alternative.label,
        hypothesis: alternative.hypothesis,
        distinguishing_test: alternative.distinguishingTest,
        status: focusIndex === index ? 'exploring' : 'unexplored',
        primary_hypothesis_id: hypothesisId,
        hypothesis_node: {
          id: hypothesisId,
          runId,
          branchId,
          kind: 'hypothesis',
          content: alternative.hypothesis,
          scope: 'branch',
          status: 'unsupported',
          metadataJson: JSON.stringify({ distinguishing_test: alternative.distinguishingTest }),
          createdAt,
          updatedAt: createdAt,
        },
      };
    });
    const focusedBranchId = focusIndex === null ? null : branches[focusIndex].id;

    const statements = [{
      statement: `/* branch:create */
MATCH (r:Run {id: $runId, status: 'active'})-[activeStateRel:ACTIVE_STATE]->(previous:State)
MATCH (root:State {id: $rootStateId, runId: $runId})
CREATE (bp:BranchPoint {
  id: $branchPointId,
  runId: $runId,
  question: $question,
  status: 'open',
  rootStateId: $rootStateId,
  parentBranchId: $parentBranchId,
  createdAt: $createdAt,
  updatedAt: $createdAt
})
CREATE (root)-[:OPENED]->(bp)
CREATE (next:State {
  id: $nextStateId,
  runId: $runId,
  sequence: previous.sequence + 1,
  reason: 'branch',
  branchId: $focusedBranchId,
  createdAt: $createdAt
})
CREATE (next)-[:PREVIOUS_STATE]->(previous)
DELETE activeStateRel
CREATE (r)-[:ACTIVE_STATE]->(next)
FOREACH (item IN $branches |
  CREATE (b:Branch)
  SET b = item.branch
  CREATE (h:ReasoningNode)
  SET h = item.hypothesis
  CREATE (bp)-[:HAS_BRANCH]->(b)
  CREATE (b)-[:ROOTED_AT]->(root)
  CREATE (b)-[:PRIMARY_HYPOTHESIS]->(h)
  CREATE (b)-[:CONTAINS]->(h)
  CREATE (r)-[:CONTAINS]->(h)
  CREATE (next)-[:CONTAINS]->(h)
)
SET r.updatedAt = $createdAt
RETURN {branchpoint_id: bp.id, state_id: next.id} AS created`,
      parameters: {
        runId,
        rootStateId: stateContext.state_id,
        parentBranchId: stateContext.branch_id,
        branchPointId,
        question,
        nextStateId,
        focusedBranchId,
        createdAt,
        branches: branches.map((branch) => ({
          branch: {
            id: branch.id,
            runId,
            branchPointId,
            parentBranchId: stateContext.branch_id,
            rootStateId: stateContext.state_id,
            label: branch.label,
            hypothesis: branch.hypothesis,
            distinguishingTest: branch.distinguishing_test,
            primaryHypothesisId: branch.primary_hypothesis_id,
            status: branch.status,
            createdAt,
            updatedAt: createdAt,
          },
          hypothesis: branch.hypothesis_node,
        })),
      },
    }];

    if (stateContext.branch_id) {
      statements.push({
        statement: `/* branch:lineage */
MATCH (parent:Branch {id: $parentBranchId, runId: $runId})
UNWIND $branchIds AS branchId
MATCH (child:Branch {id: branchId, runId: $runId})
CREATE (child)-[:CHILD_OF]->(parent)
RETURN count(child) AS linked`,
        parameters: { runId, parentBranchId: stateContext.branch_id, branchIds: branches.map((branch) => branch.id) },
      });
    }

    if (focusedBranchId) {
      statements.push({
        statement: `/* branch:focus */
MATCH (r:Run {id: $runId})
OPTIONAL MATCH (r)-[old:ACTIVE_BRANCH]->(previousBranch:Branch)
DELETE old
WITH r, previousBranch
MATCH (selected:Branch {id: $focusedBranchId, runId: $runId})
SET selected.status = 'exploring', selected.updatedAt = $updatedAt
CREATE (r)-[:ACTIVE_BRANCH]->(selected)
RETURN selected.id AS focused_branch_id`,
        parameters: { runId, focusedBranchId, updatedAt: createdAt },
      });
    } else {
      statements.push({
        statement: `/* branch:focus-clear */
MATCH (r:Run {id: $runId})
OPTIONAL MATCH (r)-[old:ACTIVE_BRANCH]->(:Branch)
DELETE old
RETURN r.id AS run_id`,
        parameters: { runId },
      });
    }

    const results = await this.client.execute(statements);
    if (!firstCell(results[0])) {
      throw new GraphReasoningError(`Unable to create branch point for run: ${runId}`, { code: 'BRANCH_CREATE_FAILED' });
    }

    const activeProjection = await this._projectActiveContext(runId);
    return {
      run_id: runId,
      branchpoint_id: branchPointId,
      active_state_id: nextStateId,
      focused_branch_id: focusedBranchId,
      created_branches: branches.map((branch) => ({
        id: branch.id,
        label: branch.label,
        hypothesis: branch.hypothesis,
        status: branch.status,
        primary_hypothesis_id: branch.primary_hypothesis_id,
      })),
      active_projection: activeProjection,
    };
  }

  async _lookupBranch(runId, branchId) {
    const result = await this.client.run(`/* lookup:branch */
MATCH (b:Branch {id: $branchId, runId: $runId})
RETURN {id: b.id, status: b.status, label: b.label, hypothesis: b.hypothesis} AS branch`, { runId, branchId });
    return firstCell(result);
  }

  async _lookupActiveBranchId(runId) {
    const result = await this.client.run(`/* lookup:active_branch */
MATCH (r:Run {id: $runId})-[:ACTIVE_BRANCH]->(b:Branch)
RETURN b.id AS branch_id`, { runId });
    return firstCell(result);
  }

  async _lookupStateContext(runId, fromStateId) {
    const statement = fromStateId
      ? `/* lookup:state */
MATCH (r:Run {id: $runId, status: 'active'})
MATCH (s:State {id: $fromStateId, runId: $runId})
RETURN {state_id: s.id, branch_id: s.branchId} AS context`
      : `/* lookup:state */
MATCH (r:Run {id: $runId, status: 'active'})-[:ACTIVE_STATE]->(s:State)
OPTIONAL MATCH (r)-[:ACTIVE_BRANCH]->(activeBranch:Branch)
RETURN {state_id: s.id, branch_id: coalesce(s.branchId, activeBranch.id)} AS context`;
    const result = await this.client.run(statement, { runId, fromStateId });
    return firstCell(result);
  }

  async _projectActiveContext(runId) {
    const results = await this.client.execute([
      {
        statement: `/* inspect:run */
MATCH (r:Run {id: $runId})
OPTIONAL MATCH (r)-[:ACTIVE_STATE]->(s:State)
OPTIONAL MATCH (r)-[:ACTIVE_BRANCH]->(b:Branch)
RETURN {
  id: r.id,
  goal: r.goal,
  task_type: r.taskType,
  status: r.status,
  active_state: CASE WHEN s IS NULL THEN null ELSE {id: s.id, sequence: s.sequence, reason: s.reason, branch_id: s.branchId} END,
  active_branch: CASE WHEN b IS NULL THEN null ELSE {id: b.id, label: b.label, hypothesis: b.hypothesis, status: b.status} END
} AS run`,
        parameters: { runId },
      },
      {
        statement: `/* inspect:global */
MATCH (r:Run {id: $runId})-[:CONTAINS]->(n:ReasoningNode)
WHERE n.scope = 'global' AND n.status IN $statuses
RETURN collect({id: n.id, kind: n.kind, content: n.content, scope: n.scope, status: n.status, created_at: n.createdAt}) AS nodes`,
        parameters: { runId, statuses: ACTIVE_NODE_STATUSES },
      },
      {
        statement: `/* inspect:branch_nodes */
MATCH (r:Run {id: $runId})
OPTIONAL MATCH (r)-[:ACTIVE_BRANCH]->(activeBranch:Branch)
OPTIONAL MATCH (activeBranch)-[:CHILD_OF*0..]->(contextBranch:Branch)
OPTIONAL MATCH (contextBranch)-[:CONTAINS]->(n:ReasoningNode)
WHERE n IS NULL OR n.status IN $statuses
RETURN collect(DISTINCT CASE WHEN n IS NULL THEN null ELSE {id: n.id, kind: n.kind, content: n.content, scope: n.scope, status: n.status, branch_id: n.branchId, created_at: n.createdAt} END) AS nodes`,
        parameters: { runId, statuses: ACTIVE_NODE_STATUSES },
      },
      {
        statement: `/* inspect:frontier */
MATCH (r:Run {id: $runId})
OPTIONAL MATCH (bp:BranchPoint {runId: $runId})-[:HAS_BRANCH]->(b:Branch)
WHERE b IS NULL OR b.status IN ['unexplored', 'exploring', 'suspended', 'supported']
RETURN collect(CASE WHEN b IS NULL THEN null ELSE {id: b.id, branchpoint_id: bp.id, label: b.label, hypothesis: b.hypothesis, status: b.status, parent_branch_id: b.parentBranchId} END) AS branches`,
        parameters: { runId },
      },
      {
        statement: `/* inspect:rejected */
MATCH (r:Run {id: $runId})
OPTIONAL MATCH (b:Branch {runId: $runId})
WHERE b IS NULL OR b.status IN ['refuted', 'abandoned']
WITH b ORDER BY b.updatedAt DESC
RETURN collect(CASE WHEN b IS NULL THEN null ELSE {id: b.id, label: b.label, hypothesis: b.hypothesis, status: b.status, reason: b.dispositionReason} END)[0..10] AS branches`,
        parameters: { runId },
      },
      {
        statement: `/* inspect:unresolved */
MATCH (r:Run {id: $runId})
OPTIONAL MATCH (n:ReasoningNode {runId: $runId})
WHERE n IS NULL OR (n.kind IN ['question', 'uncertainty'] AND n.status IN ['active', 'unsupported'])
RETURN collect(CASE WHEN n IS NULL THEN null ELSE {id: n.id, kind: n.kind, content: n.content, scope: n.scope, status: n.status, branch_id: n.branchId} END) AS nodes`,
        parameters: { runId },
      },
    ]);

    const run = firstCell(results[0]);
    if (!run) {
      throw new GraphReasoningError(`Reasoning run not found: ${runId}`, { code: 'RUN_NOT_FOUND' });
    }
    const globalNodes = (firstCell(results[1], []) ?? []).filter(Boolean).map(mapNode);
    const branchNodes = (firstCell(results[2], []) ?? []).filter(Boolean).map(mapNode);
    const frontier = (firstCell(results[3], []) ?? []).filter(Boolean);
    const rejected = (firstCell(results[4], []) ?? []).filter(Boolean);
    const unresolved = (firstCell(results[5], []) ?? []).filter(Boolean).map(mapNode);

    return {
      run_id: run.id,
      goal: run.goal,
      task_type: run.task_type,
      status: run.status,
      active_state: run.active_state ?? null,
      active_branch: run.active_branch ?? null,
      global_nodes: globalNodes,
      branch_nodes: branchNodes,
      frontier,
      rejected_branches: rejected,
      unresolved,
    };
  }

  async _inspectFrontier(runId) {
    const result = await this.client.run(`/* inspect:view:frontier */
MATCH (bp:BranchPoint {runId: $runId})-[:HAS_BRANCH]->(b:Branch)
RETURN collect({id: b.id, branchpoint_id: bp.id, label: b.label, hypothesis: b.hypothesis, status: b.status, parent_branch_id: b.parentBranchId}) AS branches`, { runId });
    return { run_id: runId, branches: (firstCell(result, []) ?? []).filter(Boolean) };
  }

  async _inspectBranch(runId, branchId) {
    const result = await this.client.run(`/* inspect:view:branch */
MATCH (b:Branch {id: $branchId, runId: $runId})
OPTIONAL MATCH (b)-[:CONTAINS]->(n:ReasoningNode)
RETURN {
  id: b.id,
  label: b.label,
  hypothesis: b.hypothesis,
  status: b.status,
  parent_branch_id: b.parentBranchId,
  branchpoint_id: b.branchPointId,
  nodes: collect(CASE WHEN n IS NULL THEN null ELSE {id: n.id, kind: n.kind, content: n.content, status: n.status, created_at: n.createdAt} END)
} AS branch`, { runId, branchId });
    const branch = firstCell(result);
    if (!branch) throw new GraphReasoningError(`Branch not found: ${branchId}`, { code: 'BRANCH_NOT_FOUND' });
    branch.nodes = (branch.nodes ?? []).filter(Boolean);
    return { run_id: runId, branch };
  }

  async _inspectHistory(runId, limit) {
    const result = await this.client.run(`/* inspect:view:history */
MATCH (s:State {runId: $runId})
WITH s ORDER BY s.sequence DESC LIMIT $limit
RETURN collect({id: s.id, sequence: s.sequence, reason: s.reason, branch_id: s.branchId, created_at: s.createdAt}) AS states`, {
      runId,
      limit: Math.max(1, Math.min(500, limit)),
    });
    return { run_id: runId, states: firstCell(result, []) ?? [] };
  }

  async backtrack(args = {}) {
    requireObject(args, 'arguments');
    await this.client.ensureSchema();
    const runId = requireString(args.run_id, 'run_id');
    let fromBranchId = optionalString(args.from_branch_id, 'from_branch_id');
    if (!fromBranchId) fromBranchId = await this._lookupActiveBranchId(runId);
    if (!fromBranchId) {
      throw new GraphReasoningError('Backtracking requires an active or explicit source branch', { code: 'BRANCH_NOT_FOUND' });
    }
    const targetBranchPointId = requireString(args.target_branchpoint_id, 'target_branchpoint_id');
    const disposition = requireString(args.disposition, 'disposition');
    if (!['refuted', 'suspended', 'abandoned'].includes(disposition)) {
      throw new GraphReasoningError(`Unsupported backtrack disposition: ${disposition}`, { code: 'INVALID_ARGUMENT' });
    }
    const basis = requireObject(args.basis, 'basis');
    const reason = requireString(basis.reason, 'basis.reason');
    const evidenceIds = stringArray(basis.evidence_ids, 'basis.evidence_ids');
    const contradictionIds = stringArray(basis.contradiction_ids, 'basis.contradiction_ids');
    const explicitRefutes = stringArray(basis.refutes_node_ids, 'basis.refutes_node_ids');
    const next = args.next === undefined ? { mode: 'first_unexplored' } : requireObject(args.next, 'next');
    const nextMode = requireString(next.mode, 'next.mode');
    if (!['branch_id', 'first_unexplored', 'none'].includes(nextMode)) {
      throw new GraphReasoningError(`Unsupported next mode: ${nextMode}`, { code: 'INVALID_ARGUMENT' });
    }

    const contextResult = await this.client.run(`/* backtrack:context */
MATCH (from:Branch {id: $fromBranchId, runId: $runId})
MATCH (bp:BranchPoint {id: $targetBranchPointId, runId: $runId})
MATCH (root:State {id: bp.rootStateId, runId: $runId})
OPTIONAL MATCH path=(from)-[:CHILD_OF*0..]->(branchPointBranch:Branch)<-[:HAS_BRANCH]-(bp)
WITH from, bp, root, path, branchPointBranch
OPTIONAL MATCH (bp)-[:HAS_BRANCH]->(sibling:Branch)
WITH from, bp, root, path, branchPointBranch,
     collect(DISTINCT CASE WHEN sibling IS NULL THEN null ELSE {id: sibling.id, status: sibling.status, label: sibling.label} END) AS siblings
RETURN {
  valid: path IS NOT NULL,
  from_branch: {
    id: from.id,
    branchpoint_id: from.branchPointId,
    parent_branch_id: from.parentBranchId,
    primary_hypothesis_id: from.primaryHypothesisId
  },
  departing_branch: CASE WHEN branchPointBranch IS NULL THEN null ELSE {
    id: branchPointBranch.id,
    branchpoint_id: branchPointBranch.branchPointId,
    parent_branch_id: branchPointBranch.parentBranchId,
    primary_hypothesis_id: branchPointBranch.primaryHypothesisId
  } END,
  path_branch_ids: CASE WHEN path IS NULL THEN [] ELSE [node IN nodes(path) WHERE node:Branch | node.id] END,
  branchpoint: {id: bp.id, root_state_id: root.id, parent_branch_id: bp.parentBranchId},
  siblings: [item IN siblings WHERE item IS NOT NULL]
} AS context`, { runId, fromBranchId, targetBranchPointId });
    const context = firstCell(contextResult);
    if (!context?.valid || !context.departing_branch) {
      throw new GraphReasoningError('The target branch point is not in the source branch lineage', {
        code: 'INVALID_BACKTRACK_TARGET',
        details: { run_id: runId, from_branch_id: fromBranchId, target_branchpoint_id: targetBranchPointId },
      });
    }

    const departingBranchId = context.departing_branch.id;
    const pathBranchIds = context.path_branch_ids?.length > 0
      ? context.path_branch_ids
      : [fromBranchId];

    const refutesNodeIds = [...new Set([
      ...explicitRefutes,
      ...(disposition === 'refuted' && context.departing_branch.primary_hypothesis_id
        ? [context.departing_branch.primary_hypothesis_id]
        : []),
    ])];
    const basisSupportIds = [...new Set([...evidenceIds, ...contradictionIds])];
    const referencedNodeIds = [...new Set([...basisSupportIds, ...refutesNodeIds])];
    if (referencedNodeIds.length > 0) {
      const validationResult = await this.client.run(`/* backtrack:validate_targets */
MATCH (r:Run {id: $runId, status: 'active'})
OPTIONAL MATCH (node:ReasoningNode {runId: $runId})
WHERE node.id IN $targetIds
RETURN collect(DISTINCT node.id) AS valid_ids`, {
        runId,
        targetIds: referencedNodeIds,
      });
      const validIds = firstCell(validationResult);
      if (!validIds) {
        throw new GraphReasoningError(`Active run not found: ${runId}`, { code: 'RUN_NOT_FOUND' });
      }
      const missingNodeIds = referencedNodeIds.filter((id) => !validIds.includes(id));
      if (missingNodeIds.length > 0) {
        throw new GraphReasoningError('One or more backtrack basis nodes do not exist in this active run', {
          code: 'INVALID_REFERENCE',
          details: { missing_node_ids: missingNodeIds },
        });
      }
    }

    let nextBranchId = null;
    if (nextMode === 'branch_id') {
      const requested = requireString(next.branch_id, 'next.branch_id');
      const sibling = context.siblings.find((item) => item.id === requested);
      if (!sibling
          || requested === departingBranchId
          || ['refuted', 'abandoned', 'integrated'].includes(sibling.status)) {
        throw new GraphReasoningError(`Requested next branch is not a viable sibling of ${targetBranchPointId}: ${requested}`, {
          code: 'INVALID_NEXT_BRANCH',
          details: { branch_id: requested, status: sibling?.status ?? null },
        });
      }
      nextBranchId = requested;
    } else if (nextMode === 'first_unexplored') {
      nextBranchId = context.siblings.find((item) => item.id !== departingBranchId && item.status === 'unexplored')?.id
        ?? context.siblings.find((item) => item.id !== departingBranchId && item.status === 'suspended')?.id
        ?? null;
    }

    const activeBranchId = nextBranchId ?? context.branchpoint.parent_branch_id ?? null;
    const createdAt = this.now();
    const stateId = this.idFactory('STATE');
    const basisNodeId = this.idFactory('NODE');
    const basisKind = disposition === 'refuted' ? 'contradiction' : 'uncertainty';
    const invalidatableKinds = ['hypothesis', 'assumption', 'inference', 'conclusion', 'question', 'uncertainty'];

    const statements = [{
      statement: `/* backtrack:transition */
MATCH (r:Run {id: $runId, status: 'active'})-[activeStateRel:ACTIVE_STATE]->(previous:State)
MATCH (departing:Branch {id: $departingBranchId, runId: $runId})
MATCH (bp:BranchPoint {id: $targetBranchPointId, runId: $runId})
MATCH (root:State {id: bp.rootStateId, runId: $runId})
CREATE (nextState:State {
  id: $stateId,
  runId: $runId,
  sequence: previous.sequence + 1,
  reason: 'backtrack',
  branchId: $activeBranchId,
  createdAt: $createdAt
})
CREATE (nextState)-[:PREVIOUS_STATE]->(previous)
CREATE (nextState)-[:BACKTRACKED_TO]->(root)
DELETE activeStateRel
CREATE (r)-[:ACTIVE_STATE]->(nextState)
CREATE (basis:ReasoningNode {
  id: $basisNodeId,
  runId: $runId,
  branchId: $departingBranchId,
  kind: $basisKind,
  content: $reason,
  scope: 'branch',
  status: 'active',
  metadataJson: $metadataJson,
  createdAt: $createdAt,
  updatedAt: $createdAt
})
CREATE (r)-[:CONTAINS]->(basis)
CREATE (departing)-[:CONTAINS]->(basis)
CREATE (nextState)-[:CONTAINS]->(basis)
SET departing.dispositionReason = $reason,
    departing.basisNodeId = $basisNodeId,
    r.updatedAt = $createdAt
RETURN {state_id: nextState.id, basis_node_id: basis.id} AS transition`,
      parameters: {
        runId,
        fromBranchId,
        departingBranchId,
        targetBranchPointId,
        stateId,
        activeBranchId,
        basisNodeId,
        basisKind,
        reason,
        disposition,
        metadataJson: JSON.stringify({
          source_branch_id: fromBranchId,
          path_branch_ids: pathBranchIds,
          evidence_ids: evidenceIds,
          contradiction_ids: contradictionIds,
        }),
        createdAt,
      },
    }, {
      statement: `/* backtrack:path-status */
UNWIND $pathBranchIds AS branchId
MATCH (branch:Branch {id: branchId, runId: $runId})
SET branch.status = CASE
      WHEN branch.id = $departingBranchId THEN $disposition
      WHEN $disposition = 'suspended' THEN 'suspended'
      ELSE 'abandoned'
    END,
    branch.dispositionReason = CASE WHEN branch.id = $departingBranchId THEN $reason ELSE branch.dispositionReason END,
    branch.basisNodeId = CASE WHEN branch.id = $departingBranchId THEN $basisNodeId ELSE branch.basisNodeId END,
    branch.updatedAt = $updatedAt
RETURN collect(branch.id) AS updated_branch_ids`,
      parameters: {
        runId,
        pathBranchIds,
        departingBranchId,
        disposition,
        reason,
        basisNodeId,
        updatedAt: createdAt,
      },
    }];

    if (disposition !== 'suspended') {
      statements.push({
        statement: `/* backtrack:invalidate */
UNWIND $pathBranchIds AS branchId
MATCH (pathBranch:Branch {id: branchId, runId: $runId})
OPTIONAL MATCH (pathBranch)-[:CONTAINS]->(candidate:ReasoningNode)
WITH collect(DISTINCT CASE
       WHEN candidate.kind IN $invalidatableKinds AND candidate.status IN $activeStatuses THEN candidate
       ELSE null
     END) AS collectedSeeds
WITH [seed IN collectedSeeds WHERE seed IS NOT NULL] AS seeds
UNWIND CASE WHEN size(seeds) = 0 THEN [null] ELSE seeds END AS seed
OPTIONAL MATCH (dependent:ReasoningNode {runId: $runId})-[:DEPENDS_ON*1..]->(seed)
WHERE dependent IS NULL OR dependent.status IN $activeStatuses
WITH seeds, collect(DISTINCT dependent) AS dependents
WITH [node IN seeds + dependents WHERE node IS NOT NULL] AS candidates
UNWIND CASE WHEN size(candidates) = 0 THEN [null] ELSE candidates END AS candidate
WITH [node IN collect(DISTINCT candidate) WHERE node IS NOT NULL] AS invalidated
FOREACH (node IN invalidated |
  SET node.status = 'invalidated', node.updatedAt = $updatedAt
)
RETURN [node IN invalidated | node.id] AS invalidated`,
        parameters: {
          runId,
          pathBranchIds,
          invalidatableKinds,
          activeStatuses: ACTIVE_NODE_STATUSES,
          updatedAt: createdAt,
        },
      });
    }

    if (basisSupportIds.length > 0) {
      statements.push({
        statement: `/* backtrack:basis-links */
MATCH (basis:ReasoningNode {id: $basisNodeId, runId: $runId})
UNWIND $targetIds AS targetId
MATCH (target:ReasoningNode {id: targetId, runId: $runId})
CREATE (basis)-[:DEPENDS_ON]->(target)
RETURN count(*) AS support_links`,
        parameters: { runId, basisNodeId, targetIds: basisSupportIds },
      });
    }
    if (refutesNodeIds.length > 0) {
      statements.push({
        statement: `/* backtrack:basis-links */
MATCH (basis:ReasoningNode {id: $basisNodeId, runId: $runId})
UNWIND $targetIds AS targetId
MATCH (target:ReasoningNode {id: targetId, runId: $runId})
CREATE (basis)-[:REFUTES]->(target)
SET target.status = 'refuted', target.updatedAt = $updatedAt
RETURN count(*) AS refute_links`,
        parameters: { runId, basisNodeId, targetIds: refutesNodeIds, updatedAt: createdAt },
      });
    }

    if (activeBranchId) {
      statements.push({
        statement: `/* backtrack:focus */
MATCH (r:Run {id: $runId})
OPTIONAL MATCH (r)-[old:ACTIVE_BRANCH]->(:Branch)
DELETE old
WITH r
MATCH (nextBranch:Branch {id: $activeBranchId, runId: $runId})
MATCH (nextBranch)-[:CHILD_OF*0..]->(lineage:Branch)
WITH r, nextBranch, collect(DISTINCT lineage) AS lineageBranches
FOREACH (branch IN lineageBranches |
  SET branch.status = CASE WHEN branch.status IN ['unexplored', 'suspended'] THEN 'exploring' ELSE branch.status END,
      branch.updatedAt = $updatedAt
)
CREATE (r)-[:ACTIVE_BRANCH]->(nextBranch)
RETURN nextBranch.id AS active_branch_id`,
        parameters: { runId, activeBranchId, updatedAt: createdAt },
      });
    } else {
      statements.push({
        statement: `/* backtrack:focus-clear */
MATCH (r:Run {id: $runId})
OPTIONAL MATCH (r)-[old:ACTIVE_BRANCH]->(:Branch)
DELETE old
RETURN r.id AS run_id`,
        parameters: { runId },
      });
    }

    const results = await this.client.execute(statements);
    if (!firstCell(results[0])) {
      throw new GraphReasoningError('Neo4j did not apply the backtrack transition', { code: 'BACKTRACK_FAILED' });
    }
    const invalidationIndex = statements.findIndex((item) => item.statement.includes('/* backtrack:invalidate */'));
    const invalidatedNodeIds = invalidationIndex >= 0 ? (firstCell(results[invalidationIndex], []) ?? []) : [];
    const activeProjection = await this._projectActiveContext(runId);

    return {
      run_id: runId,
      source_branch_id: fromBranchId,
      closed_branch_id: departingBranchId,
      abandoned_path_branch_ids: pathBranchIds,
      disposition,
      basis_node_id: basisNodeId,
      active_state_id: stateId,
      restored_state_id: context.branchpoint.root_state_id,
      next_branch_id: nextBranchId,
      active_branch_id: activeBranchId,
      invalidated_node_ids: invalidatedNodeIds,
      retained_kinds: disposition === 'suspended'
        ? [...VALID_REASONING_KINDS]
        : ['observation', 'evidence', 'contradiction'],
      active_projection: activeProjection,
    };
  }

  async integrate(args = {}) {
    requireObject(args, 'arguments');
    await this.client.ensureSchema();
    const runId = requireString(args.run_id, 'run_id');
    const sourceBranchIds = stringArray(args.source_branch_ids, 'source_branch_ids');
    if (sourceBranchIds.length < 2) {
      throw new GraphReasoningError('source_branch_ids must contain at least two branches', { code: 'INVALID_ARGUMENT' });
    }
    const conclusion = requireString(args.conclusion, 'conclusion');
    const supportingNodeIds = stringArray(args.supporting_node_ids, 'supporting_node_ids');
    if (supportingNodeIds.length === 0) {
      throw new GraphReasoningError('supporting_node_ids must contain at least one graph node', { code: 'INVALID_ARGUMENT' });
    }

    const validationResult = await this.client.run(`/* integrate:validate */
MATCH (r:Run {id: $runId, status: 'active'})
CALL {
  WITH r
  OPTIONAL MATCH (b:Branch {runId: $runId})
  WHERE b.id IN $sourceBranchIds
  RETURN collect(DISTINCT b.id) AS validBranchIds
}
CALL {
  WITH r
  OPTIONAL MATCH (n:ReasoningNode {runId: $runId})
  WHERE n.id IN $supportingNodeIds AND n.status IN ['active', 'supported']
  RETURN collect(DISTINCT n.id) AS validNodeIds
}
RETURN {
  valid_branch_ids: validBranchIds,
  valid_node_ids: validNodeIds,
  invalid_node_ids: [id IN $supportingNodeIds WHERE NOT id IN validNodeIds]
} AS validation`, { runId, sourceBranchIds, supportingNodeIds });
    const validation = firstCell(validationResult);
    const validBranchIds = validation?.valid_branch_ids ?? [];
    const validNodeIds = validation?.valid_node_ids ?? [];
    const invalidNodeIds = validation?.invalid_node_ids ?? supportingNodeIds;
    const missingBranchIds = sourceBranchIds.filter((id) => !validBranchIds.includes(id));
    if (!validation || missingBranchIds.length > 0 || invalidNodeIds.length > 0 || validNodeIds.length !== supportingNodeIds.length) {
      throw new GraphReasoningError('Integration cannot use missing, refuted, or invalidated support', {
        code: 'INVALID_SUPPORT',
        details: { missing_branch_ids: missingBranchIds, invalid_node_ids: invalidNodeIds },
      });
    }

    const createdAt = this.now();
    const conclusionId = this.idFactory('NODE');
    const stateId = this.idFactory('STATE');
    const statements = [{
      statement: `/* integrate:create */
MATCH (r:Run {id: $runId, status: 'active'})-[activeStateRel:ACTIVE_STATE]->(previous:State)
CREATE (next:State {
  id: $stateId,
  runId: $runId,
  sequence: previous.sequence + 1,
  reason: 'integrate',
  branchId: null,
  createdAt: $createdAt
})
CREATE (next)-[:PREVIOUS_STATE]->(previous)
DELETE activeStateRel
CREATE (r)-[:ACTIVE_STATE]->(next)
CREATE (conclusion:ReasoningNode {
  id: $conclusionId,
  runId: $runId,
  branchId: null,
  kind: 'conclusion',
  content: $content,
  scope: 'global',
  status: 'supported',
  metadataJson: '{}',
  createdAt: $createdAt,
  updatedAt: $createdAt
})
CREATE (r)-[:CONTAINS]->(conclusion)
CREATE (next)-[:CONTAINS]->(conclusion)
WITH r, next, conclusion
OPTIONAL MATCH (r)-[activeBranchRel:ACTIVE_BRANCH]->(:Branch)
DELETE activeBranchRel
WITH r, next, conclusion
SET r.updatedAt = $createdAt
RETURN {conclusion_id: conclusion.id, state_id: next.id} AS created`,
      parameters: { runId, stateId, conclusionId, content: conclusion, createdAt },
    }, {
      statement: `/* integrate:support */
MATCH (conclusion:ReasoningNode {id: $conclusionId, runId: $runId})
UNWIND $supportingNodeIds AS nodeId
MATCH (support:ReasoningNode {id: nodeId, runId: $runId})
CREATE (conclusion)-[:DEPENDS_ON]->(support)
RETURN count(*) AS support_count`,
      parameters: { runId, conclusionId, supportingNodeIds },
    }, {
      statement: `/* integrate:branches */
MATCH (conclusion:ReasoningNode {id: $conclusionId, runId: $runId})
UNWIND $sourceBranchIds AS branchId
MATCH (branch:Branch {id: branchId, runId: $runId})
CREATE (conclusion)-[:SYNTHESIZED_FROM]->(branch)
SET branch.status = CASE
      WHEN branch.status IN ['exploring', 'supported', 'suspended'] THEN 'integrated'
      ELSE branch.status
    END,
    branch.updatedAt = $updatedAt
RETURN count(*) AS branch_count`,
      parameters: { runId, conclusionId, sourceBranchIds, updatedAt: createdAt },
    }];

    const results = await this.client.execute(statements);
    if (!firstCell(results[0])) {
      throw new GraphReasoningError('Neo4j did not create the synthesized conclusion', { code: 'INTEGRATION_FAILED' });
    }
    const activeProjection = await this._projectActiveContext(runId);
    return {
      run_id: runId,
      conclusion_id: conclusionId,
      active_state_id: stateId,
      source_branch_ids: sourceBranchIds,
      supporting_node_ids: supportingNodeIds,
      active_projection: activeProjection,
    };
  }

  async audit(args = {}) {
    requireObject(args, 'arguments');
    await this.client.ensureSchema();
    const runId = requireString(args.run_id, 'run_id');
    const results = await this.client.execute([
      {
        statement: `/* audit:invalid_dependencies */
MATCH (r:Run {id: $runId})
OPTIONAL MATCH (claim:ReasoningNode {runId: $runId})-[:DEPENDS_ON*1..]->(dependency:ReasoningNode {runId: $runId})
WHERE claim IS NULL OR (claim.status IN ['active', 'supported', 'unsupported'] AND dependency.status IN ['refuted', 'invalidated'])
RETURN collect(DISTINCT CASE WHEN claim IS NULL THEN null ELSE {
  node_id: claim.id,
  node_kind: claim.kind,
  dependency_id: dependency.id,
  dependency_status: dependency.status
} END) AS findings`,
        parameters: { runId },
      },
      {
        statement: `/* audit:unsupported_dependencies */
MATCH (r:Run {id: $runId})
OPTIONAL MATCH (claim:ReasoningNode {runId: $runId, status: 'supported'})-[:DEPENDS_ON*1..]->(dependency:ReasoningNode {runId: $runId, status: 'unsupported'})
RETURN collect(DISTINCT CASE WHEN claim IS NULL THEN null ELSE {
  node_id: claim.id,
  node_kind: claim.kind,
  dependency_id: dependency.id,
  dependency_status: dependency.status
} END) AS findings`,
        parameters: { runId },
      },
      {
        statement: `/* audit:unsupported_conclusions */
MATCH (r:Run {id: $runId})
OPTIONAL MATCH (conclusion:ReasoningNode {runId: $runId, kind: 'conclusion'})
WHERE conclusion IS NULL OR (
  conclusion.status IN ['active', 'supported', 'unsupported']
  AND NOT EXISTS { MATCH (conclusion)-[:DEPENDS_ON]->(:ReasoningNode) }
  AND NOT EXISTS { MATCH (:ReasoningNode)-[:SUPPORTS]->(conclusion) }
)
RETURN collect(CASE WHEN conclusion IS NULL THEN null ELSE {node_id: conclusion.id, content: conclusion.content, status: conclusion.status} END) AS findings`,
        parameters: { runId },
      },
      {
        statement: `/* audit:unattached_contradictions */
MATCH (r:Run {id: $runId})
OPTIONAL MATCH (contradiction:ReasoningNode {runId: $runId, kind: 'contradiction'})
WHERE contradiction IS NULL OR (
  contradiction.status IN ['active', 'supported']
  AND NOT EXISTS { MATCH (contradiction)-[:REFUTES]->(:ReasoningNode) }
)
RETURN collect(CASE WHEN contradiction IS NULL THEN null ELSE {node_id: contradiction.id, content: contradiction.content} END) AS findings`,
        parameters: { runId },
      },
      {
        statement: `/* audit:refuted_without_basis */
MATCH (r:Run {id: $runId})
OPTIONAL MATCH (branch:Branch {runId: $runId, status: 'refuted'})
WHERE branch IS NULL OR branch.basisNodeId IS NULL
RETURN collect(CASE WHEN branch IS NULL THEN null ELSE {branch_id: branch.id, label: branch.label} END) AS findings`,
        parameters: { runId },
      },
      {
        statement: `/* audit:unexplored_branches */
MATCH (r:Run {id: $runId})
OPTIONAL MATCH (branch:Branch {runId: $runId, status: 'unexplored'})
RETURN collect(CASE WHEN branch IS NULL THEN null ELSE {branch_id: branch.id, label: branch.label, hypothesis: branch.hypothesis} END) AS findings`,
        parameters: { runId },
      },
    ]);

    const specs = [
      { severity: 'high', type: 'invalidated_dependency', message: 'An active claim depends on a refuted or invalidated node.' },
      { severity: 'high', type: 'unsupported_dependency', message: 'A supported claim still depends on an unsupported node.' },
      { severity: 'high', type: 'unsupported_conclusion', message: 'A conclusion has no graph support path.' },
      { severity: 'medium', type: 'unattached_contradiction', message: 'A contradiction does not refute any graph node.' },
      { severity: 'medium', type: 'refuted_branch_without_basis', message: 'A branch is marked refuted without a recorded basis.' },
      { severity: 'info', type: 'unexplored_branch', message: 'A branch remains unexplored.' },
    ];
    const findings = [];
    for (let index = 0; index < specs.length; index += 1) {
      const details = (firstCell(results[index], []) ?? []).filter(Boolean);
      for (const detail of details) findings.push({ ...specs[index], ...detail });
    }
    const summary = { high: 0, medium: 0, info: 0 };
    for (const finding of findings) summary[finding.severity] += 1;
    return {
      run_id: runId,
      status: summary.high > 0 ? 'failed' : findings.length > 0 ? 'passed_with_findings' : 'passed',
      summary,
      findings,
    };
  }

  async finish(args = {}) {
    requireObject(args, 'arguments');
    const runId = requireString(args.run_id, 'run_id');
    const force = args.force === true;
    const audit = await this.audit({ run_id: runId });
    if (audit.summary.high > 0 && !force) {
      return {
        run_id: runId,
        status: 'blocked',
        reason: 'High-severity graph audit findings must be resolved or force must be explicit.',
        audit,
      };
    }

    const completedAt = this.now();
    const results = await this.client.execute([
      {
        statement: `/* finish:run */
MATCH (r:Run {id: $runId})
SET r.status = 'completed', r.updatedAt = $completedAt, r.completedAt = $completedAt
WITH r
OPTIONAL MATCH (r)-[activeBranch:ACTIVE_BRANCH]->(:Branch)
DELETE activeBranch
RETURN {id: r.id, status: r.status} AS run`,
        parameters: { runId, completedAt },
      },
      {
        statement: `/* finish:conclusions */
MATCH (r:Run {id: $runId})
OPTIONAL MATCH (conclusion:ReasoningNode {runId: $runId, kind: 'conclusion', status: 'supported'})
RETURN collect(CASE WHEN conclusion IS NULL THEN null ELSE {id: conclusion.id, content: conclusion.content, created_at: conclusion.createdAt} END) AS conclusions`,
        parameters: { runId },
      },
      {
        statement: `/* finish:rejected */
MATCH (r:Run {id: $runId})
OPTIONAL MATCH (branch:Branch {runId: $runId})
WHERE branch IS NULL OR branch.status IN ['refuted', 'abandoned']
RETURN collect(CASE WHEN branch IS NULL THEN null ELSE {id: branch.id, label: branch.label, hypothesis: branch.hypothesis, status: branch.status, reason: branch.dispositionReason} END) AS branches`,
        parameters: { runId },
      },
      {
        statement: `/* finish:unresolved */
MATCH (r:Run {id: $runId})
OPTIONAL MATCH (node:ReasoningNode {runId: $runId})
WHERE node IS NULL OR (node.kind IN ['question', 'uncertainty'] AND node.status IN ['active', 'unsupported'])
RETURN collect(CASE WHEN node IS NULL THEN null ELSE {id: node.id, kind: node.kind, content: node.content, branch_id: node.branchId} END) AS nodes`,
        parameters: { runId },
      },
      {
        statement: `/* finish:coverage */
MATCH (r:Run {id: $runId})
OPTIONAL MATCH (branch:Branch {runId: $runId})
WITH collect(branch) AS branches
RETURN {
  total: size([branch IN branches WHERE branch IS NOT NULL]),
  explored: size([branch IN branches WHERE branch IS NOT NULL AND branch.status <> 'unexplored']),
  unexplored: size([branch IN branches WHERE branch IS NOT NULL AND branch.status = 'unexplored'])
} AS coverage`,
        parameters: { runId },
      },
    ]);

    const run = firstCell(results[0]);
    if (!run) throw new GraphReasoningError(`Reasoning run not found: ${runId}`, { code: 'RUN_NOT_FOUND' });
    return {
      run_id: runId,
      status: 'completed',
      supported_conclusions: (firstCell(results[1], []) ?? []).filter(Boolean),
      rejected_branches: (firstCell(results[2], []) ?? []).filter(Boolean),
      unresolved: (firstCell(results[3], []) ?? []).filter(Boolean),
      branch_coverage: firstCell(results[4], { total: 0, explored: 0, unexplored: 0 }),
      audit,
      forced: force,
    };
  }
}

const SERVER_INSTRUCTIONS = [
  'Use Neo4j as the authoritative workspace for explicit reasoning state.',
  'Store concise, decision-relevant propositions rather than raw internal monologue.',
  'Start a run before deep analysis, branch on materially distinct alternatives, attach evidence while exploring, backtrack when a path is contradicted, integrate compatible findings, and inspect the audit before finishing.',
  'Do not use this server as a post-hoc note store and do not request arbitrary Cypher.',
].join(' ');

const reasoningNodeKinds = [
  'observation',
  'question',
  'hypothesis',
  'assumption',
  'constraint',
  'experiment',
  'evidence',
  'inference',
  'contradiction',
  'conclusion',
  'uncertainty',
];

const nonEmptyString = { type: 'string', minLength: 1 };
const idArray = { type: 'array', items: nonEmptyString, uniqueItems: true };

export const TOOL_DEFINITIONS = [
  {
    name: 'reasoning_start',
    title: 'Start or resume graph reasoning',
    description: 'Create a Neo4j reasoning run, or resume an existing run, and return the active graph-derived context projection.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['create', 'resume'], default: 'create' },
        run_id: nonEmptyString,
        goal: nonEmptyString,
        task_type: nonEmptyString,
        initial_context: {
          type: 'object',
          additionalProperties: false,
          properties: {
            observations: { type: 'array', items: nonEmptyString },
            constraints: { type: 'array', items: nonEmptyString },
            questions: { type: 'array', items: nonEmptyString },
          },
        },
      },
      anyOf: [
        { required: ['mode', 'goal'] },
        { required: ['mode', 'run_id'] },
        { required: ['goal'] },
        { required: ['run_id'] },
      ],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'reasoning_inspect',
    title: 'Inspect graph reasoning state',
    description: 'Read an active context, branch frontier, branch contents, state history, or audit findings directly from the Neo4j reasoning graph.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['run_id', 'view'],
      properties: {
        run_id: nonEmptyString,
        view: { type: 'string', enum: ['active_context', 'frontier', 'branch', 'history', 'audit'] },
        branch_id: nonEmptyString,
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'reasoning_advance',
    title: 'Advance graph reasoning',
    description: 'Record one or more concise observations, assumptions, experiments, evidence items, inferences, contradictions, conclusions, or uncertainties in the active Neo4j graph context.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['run_id', 'operations'],
      properties: {
        run_id: nonEmptyString,
        branch_id: nonEmptyString,
        operations: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'content'],
            properties: {
              type: { type: 'string', enum: reasoningNodeKinds },
              content: nonEmptyString,
              scope: { type: 'string', enum: ['global', 'branch'], default: 'branch' },
              status: { type: 'string', enum: ['active', 'unsupported', 'supported'], default: 'active' },
              depends_on: idArray,
              supports: idArray,
              refutes: idArray,
              tests: idArray,
              metadata: { type: 'object' },
            },
          },
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'reasoning_branch',
    title: 'Create a reasoning branch point',
    description: 'Create a Neo4j branch point containing materially distinct alternatives generated by Codex and optionally enter one selected alternative.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['run_id', 'question', 'alternatives'],
      properties: {
        run_id: nonEmptyString,
        from_state_id: nonEmptyString,
        question: nonEmptyString,
        alternatives: {
          type: 'array',
          minItems: 2,
          maxItems: 20,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['label', 'hypothesis'],
            properties: {
              label: nonEmptyString,
              hypothesis: nonEmptyString,
              distinguishing_test: nonEmptyString,
            },
          },
        },
        focus_index: { type: ['integer', 'null'], minimum: 0 },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'reasoning_backtrack',
    title: 'Backtrack in the reasoning graph',
    description: 'Close or suspend the current reasoning path, invalidate failed dependencies when abandoning or refuting it, restore an ancestor branch point, and optionally enter a sibling branch.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['run_id', 'target_branchpoint_id', 'disposition', 'basis'],
      properties: {
        run_id: nonEmptyString,
        from_branch_id: nonEmptyString,
        target_branchpoint_id: nonEmptyString,
        disposition: { type: 'string', enum: ['refuted', 'suspended', 'abandoned'] },
        basis: {
          type: 'object',
          additionalProperties: false,
          required: ['reason'],
          properties: {
            reason: nonEmptyString,
            evidence_ids: idArray,
            contradiction_ids: idArray,
            refutes_node_ids: idArray,
          },
        },
        next: {
          type: 'object',
          additionalProperties: false,
          required: ['mode'],
          properties: {
            mode: { type: 'string', enum: ['branch_id', 'first_unexplored', 'none'] },
            branch_id: nonEmptyString,
          },
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: 'reasoning_integrate',
    title: 'Integrate compatible reasoning branches',
    description: 'Create a global supported conclusion synthesized from compatible Neo4j branches and explicit supporting graph nodes.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['run_id', 'source_branch_ids', 'conclusion', 'supporting_node_ids'],
      properties: {
        run_id: nonEmptyString,
        source_branch_ids: { type: 'array', minItems: 2, items: nonEmptyString, uniqueItems: true },
        conclusion: nonEmptyString,
        supporting_node_ids: { type: 'array', minItems: 1, items: nonEmptyString, uniqueItems: true },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'reasoning_finish',
    title: 'Finish a graph reasoning run',
    description: 'Audit and finalize a Neo4j reasoning run, returning supported conclusions, rejected alternatives, unresolved items, and branch coverage.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['run_id'],
      properties: {
        run_id: nonEmptyString,
        force: { type: 'boolean', default: false },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
];

const TOOL_TO_METHOD = new Map([
  ['reasoning_start', 'start'],
  ['reasoning_inspect', 'inspect'],
  ['reasoning_advance', 'advance'],
  ['reasoning_branch', 'branch'],
  ['reasoning_backtrack', 'backtrack'],
  ['reasoning_integrate', 'integrate'],
  ['reasoning_finish', 'finish'],
]);

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function formatToolResult(value, { modern, isError = false } = {}) {
  const structuredContent = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : { value };
  const result = {
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    isError,
  };
  if (modern) {
    result.resultType = 'complete';
    result._meta = {
      [SERVER_INFO_META_KEY]: { name: SERVER_NAME, version: SERVER_VERSION },
    };
  }
  return result;
}

export function createMcpRuntime({ service } = {}) {
  if (!service || typeof service !== 'object') {
    throw new TypeError('createMcpRuntime requires a reasoning service');
  }

  let protocolEra = 'legacy';

  const runtime = {
    get protocolEra() {
      return protocolEra;
    },

    async handle(message) {
      const id = message && Object.hasOwn(message, 'id') ? message.id : null;
      if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
        return rpcError(id, -32600, 'Invalid JSON-RPC request');
      }

      const isNotification = !Object.hasOwn(message, 'id');
      if (isNotification) {
        return null;
      }

      const params = message.params ?? {};

      if (message.method === 'server/discover') {
        protocolEra = 'modern';
        return rpcResult(id, {
          resultType: 'complete',
          supportedVersions: [MCP_PROTOCOL_MODERN],
          capabilities: { tools: { listChanged: false } },
          _meta: {
            [SERVER_INFO_META_KEY]: { name: SERVER_NAME, version: SERVER_VERSION },
          },
          instructions: SERVER_INSTRUCTIONS,
          ttlMs: 0,
          cacheScope: 'private',
        });
      }

      if (message.method === 'initialize') {
        protocolEra = 'legacy';
        return rpcResult(id, {
          protocolVersion: MCP_PROTOCOL_LEGACY,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: SERVER_INSTRUCTIONS,
        });
      }

      if (message.method === 'ping') {
        if (protocolEra === 'modern') return rpcError(id, -32601, `Method not found: ${message.method}`);
        return rpcResult(id, {});
      }

      if (message.method === 'tools/list') {
        const result = { tools: TOOL_DEFINITIONS };
        if (protocolEra === 'modern') {
          result.resultType = 'complete';
          result.ttlMs = 0;
          result.cacheScope = 'private';
          result._meta = {
            [SERVER_INFO_META_KEY]: { name: SERVER_NAME, version: SERVER_VERSION },
          };
        }
        return rpcResult(id, result);
      }

      if (message.method === 'tools/call') {
        const toolName = params?.name;
        const methodName = TOOL_TO_METHOD.get(toolName);
        if (!methodName || typeof service[methodName] !== 'function') {
          return rpcResult(id, formatToolResult({
            error_code: 'UNKNOWN_TOOL',
            message: `Unknown tool: ${String(toolName)}`,
          }, { modern: protocolEra === 'modern', isError: true }));
        }

        try {
          const value = await service[methodName](params.arguments ?? {});
          return rpcResult(id, formatToolResult(value, { modern: protocolEra === 'modern' }));
        } catch (error) {
          return rpcResult(id, formatToolResult({
            error_code: error?.code ?? 'TOOL_EXECUTION_ERROR',
            message: error instanceof Error ? error.message : String(error),
            details: error?.details,
          }, { modern: protocolEra === 'modern', isError: true }));
        }
      }

      return rpcError(id, -32601, `Method not found: ${message.method}`);
    },
  };

  return runtime;
}

export function createDefaultService({ client, baseUrl, database, fetchImpl, idFactory, now } = {}) {
  const neo4jClient = client ?? new Neo4jHttpClient({ baseUrl, database, fetchImpl });
  return new ReasoningGraphService({ client: neo4jClient, idFactory, now });
}

export async function runStdioServer({ service, input = process.stdin, output = process.stdout, errorOutput = process.stderr } = {}) {
  const runtime = createMcpRuntime({ service });
  const reader = createInterface({ input, crlfDelay: Infinity });

  for await (const line of reader) {
    if (!line.trim()) continue;

    let request;
    try {
      request = JSON.parse(line);
    } catch (error) {
      output.write(`${JSON.stringify(rpcError(null, -32700, 'Parse error'))}\n`);
      continue;
    }

    try {
      const response = await runtime.handle(request);
      if (response !== null) output.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      errorOutput.write(`[graph-reasoning] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      if (Object.hasOwn(request, 'id')) {
        output.write(`${JSON.stringify(rpcError(request.id, -32603, 'Internal error'))}\n`);
      }
    }
  }
}

function isExecutableEntryPoint() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isExecutableEntryPoint()) {
  runStdioServer({ service: createDefaultService() }).catch((error) => {
    console.error(`[graph-reasoning] Fatal server error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
