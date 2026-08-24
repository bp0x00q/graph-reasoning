#!/usr/bin/env node

import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSupportedNode, installGraphReasoning } from './setup-core.mjs';

function usage() {
  return `Usage: node scripts/install.mjs [options]

Options:
  --source PATH             Package source root (defaults to this package)
  --install-root PATH       Plugin parent directory (defaults to ~/.codex/plugins)
  --neo4j-http-url URL      Neo4j HTTP endpoint (default: http://127.0.0.1:7474)
  --neo4j-database NAME     Neo4j database (default: neo4j)
  --skip-marketplace       Do not create or merge ~/.agents/plugins/marketplace.json
  --help                   Show this help
`;
}

function parseArgs(argv) {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const options = {
    sourceRoot: packageRoot,
    homeDir: homedir(),
    installRoot: undefined,
    neo4jHttpUrl: 'http://127.0.0.1:7474',
    neo4jDatabase: 'neo4j',
    skipMarketplace: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };

    switch (arg) {
      case '--source': options.sourceRoot = resolve(next()); break;
      case '--install-root': options.installRoot = resolve(next()); break;
      case '--neo4j-http-url': options.neo4jHttpUrl = next(); break;
      case '--neo4j-database': options.neo4jDatabase = next(); break;
      case '--skip-marketplace': options.skipMarketplace = true; break;
      case '--help': console.log(usage()); process.exit(0); break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

try {
  assertSupportedNode();
  const result = await installGraphReasoning(parseArgs(process.argv.slice(2)));
  console.log('');
  console.log('Graph Reasoning installed.');
  console.log(`Plugin:      ${result.targetRoot}`);
  console.log(`Neo4j HTTP:  ${result.neo4jHttpUrl}`);
  console.log(`Database:    ${result.neo4jDatabase}`);
  if (result.marketplacePath) console.log(`Marketplace: ${result.marketplacePath}`);
  console.log('');
  console.log('Next:');
  console.log('1. Configure and start the local Neo4j database.');
  console.log('2. Run the operating-system test script from the installed plugin.');
  console.log('3. Restart the Codex/ChatGPT host and enable Graph Reasoning.');
} catch (error) {
  console.error(`Graph Reasoning installation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
