#!/usr/bin/env node

import { assertSupportedNode, configureNeo4jFile } from './setup-core.mjs';

function usage() {
  return `Usage: node scripts/configure-neo4j.mjs --config PATH\n`;
}

function parseArgs(argv) {
  let configPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--config':
        index += 1;
        if (index >= argv.length) throw new Error('--config requires a path');
        configPath = argv[index];
        break;
      case '--help':
        console.log(usage());
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!configPath) throw new Error('Supply --config PATH');
  return { configPath };
}

try {
  assertSupportedNode();
  const result = await configureNeo4jFile(parseArgs(process.argv.slice(2)));
  console.log('Neo4j configuration updated.');
  console.log(`Config:  ${result.configPath}`);
  console.log(`Backup:  ${result.backupPath}`);
  console.log('Restart Neo4j before testing Graph Reasoning.');
} catch (error) {
  console.error(`Neo4j configuration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
