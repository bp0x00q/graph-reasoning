#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSupportedNode } from './setup-core.mjs';

function usage() {
  return `Usage: node scripts/verify.mjs [options]

Options:
  --plugin-root PATH        Plugin root (defaults to this package)
  --neo4j-http-url URL      Neo4j HTTP endpoint (default: http://127.0.0.1:7474)
  --neo4j-database NAME     Neo4j database (default: neo4j)
  --skip-integration        Skip the live Neo4j branch/backtrack test
  --help                    Show this help
`;
}

function parseArgs(argv) {
  const options = {
    pluginRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    neo4jHttpUrl: 'http://127.0.0.1:7474',
    neo4jDatabase: 'neo4j',
    skipIntegration: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    switch (arg) {
      case '--plugin-root': options.pluginRoot = resolve(next()); break;
      case '--neo4j-http-url': options.neo4jHttpUrl = next(); break;
      case '--neo4j-database': options.neo4jDatabase = next(); break;
      case '--skip-integration': options.skipIntegration = true; break;
      case '--help': console.log(usage()); process.exit(0); break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function run(description, args, { cwd, env }) {
  console.log(`\n=== ${description} ===`);
  const result = spawnSync(process.execPath, args, {
    cwd,
    env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${description} failed with exit code ${String(result.status)}`);
  }
}

try {
  assertSupportedNode();
  const options = parseArgs(process.argv.slice(2));
  const env = {
    ...process.env,
    NEO4J_HTTP_URL: options.neo4jHttpUrl,
    NEO4J_DATABASE: options.neo4jDatabase,
  };

  run('Server syntax check', ['--check', 'server/index.mjs'], { cwd: options.pluginRoot, env });
  run('Unit and protocol tests', ['--test'], { cwd: options.pluginRoot, env });
  run('MCP STDIO smoke test', ['scripts/protocol-smoke.mjs'], { cwd: options.pluginRoot, env });
  if (!options.skipIntegration) {
    run('Live Neo4j branch/backtrack integration test', ['scripts/neo4j-smoke.mjs'], { cwd: options.pluginRoot, env });
  }
  console.log('\nAll requested checks passed.');
} catch (error) {
  console.error(`Verification failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
