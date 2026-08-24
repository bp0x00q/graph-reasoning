import {
  copyFile,
  cp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const PLUGIN_NAME = 'graph-reasoning';
const NEO4J_SETTINGS = new Map([
  ['dbms.security.auth_enabled', 'false'],
  ['server.default_listen_address', '127.0.0.1'],
  ['server.http.enabled', 'true'],
]);

export function assertSupportedNode(version = process.versions.node) {
  const match = /^(?<major>\d+)\./.exec(String(version));
  if (!match) {
    throw new Error(`Unable to determine the Node.js version from: ${String(version)}`);
  }

  const major = Number(match.groups.major);
  if (major < 20) {
    throw new Error(`Node.js 20 or newer is required. Found ${String(version)}.`);
  }
  return major;
}

export function configureNeo4jText(input) {
  const source = String(input ?? '');
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const seen = new Set();
  const output = [];

  for (const line of lines) {
    let matchedName = null;
    for (const name of NEO4J_SETTINGS.keys()) {
      const pattern = new RegExp(`^\\s*#?\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=.*$`);
      if (pattern.test(line)) {
        matchedName = name;
        break;
      }
    }

    if (!matchedName) {
      output.push(line);
      continue;
    }

    if (!seen.has(matchedName)) {
      output.push(`${matchedName}=${NEO4J_SETTINGS.get(matchedName)}`);
      seen.add(matchedName);
    }
  }

  for (const [name, value] of NEO4J_SETTINGS) {
    if (!seen.has(name)) output.push(`${name}=${value}`);
  }

  while (output.length > 1 && output.at(-1) === '' && output.at(-2) === '') {
    output.pop();
  }

  return `${output.join(eol).replace(new RegExp(`${eol}*$`), '')}${eol}`;
}

export async function configureNeo4jFile({ configPath, now = new Date() }) {
  if (!configPath) throw new Error('configPath is required');
  const resolvedPath = await realpath(resolve(configPath));
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const backupPath = `${resolvedPath}.graph-reasoning-backup-${stamp}`;
  const original = await readFile(resolvedPath, 'utf8');
  await copyFile(resolvedPath, backupPath);
  await writeFile(resolvedPath, configureNeo4jText(original), 'utf8');
  return { configPath: resolvedPath, backupPath };
}

function shouldCopy(sourceRoot, sourcePath) {
  const rel = relative(sourceRoot, sourcePath);
  if (!rel || rel === '.') return true;
  const first = rel.split(sep)[0];
  return first !== '.git' && first !== 'node_modules';
}


function isPathWithin(candidate, parent) {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function samePath(left, right) {
  try {
    return (await realpath(left)) === (await realpath(right));
  } catch {
    return resolve(left) === resolve(right);
  }
}

function assertMarketplaceObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Marketplace root must be a JSON object: ${path}`);
  }
}

function marketplaceSourcePath(homeDir, targetRoot) {
  const rel = relative(resolve(homeDir), resolve(targetRoot));
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new Error('Install root is outside the user home. Use --skip-marketplace for an external install root.');
  }
  return `./${rel.split(sep).join('/')}`;
}

function graphReasoningMarketplaceEntry(sourcePath) {
  return {
    name: PLUGIN_NAME,
    source: {
      source: 'local',
      path: sourcePath,
    },
    policy: {
      installation: 'AVAILABLE',
      authentication: 'ON_INSTALL',
    },
    category: 'Developer Tools',
  };
}

export async function installGraphReasoning({
  sourceRoot,
  homeDir,
  installRoot,
  neo4jHttpUrl = 'http://127.0.0.1:7474',
  neo4jDatabase = 'neo4j',
  skipMarketplace = false,
} = {}) {
  assertSupportedNode();
  if (!sourceRoot) throw new Error('sourceRoot is required');
  if (!homeDir) throw new Error('homeDir is required');

  const source = await realpath(resolve(sourceRoot));
  const pluginsRoot = resolve(installRoot ?? join(homeDir, '.codex', 'plugins'));
  const targetRoot = join(pluginsRoot, PLUGIN_NAME);
  const marketplaceSource = skipMarketplace ? null : marketplaceSourcePath(homeDir, targetRoot);
  await mkdir(pluginsRoot, { recursive: true });

  const sourceEqualsTarget = await samePath(source, targetRoot);
  if (!sourceEqualsTarget && (isPathWithin(targetRoot, source) || isPathWithin(source, targetRoot))) {
    throw new Error(`Source and destination paths overlap: source=${source}, destination=${targetRoot}`);
  }

  if (!sourceEqualsTarget) {
    await rm(targetRoot, { recursive: true, force: true });
    await cp(source, targetRoot, {
      recursive: true,
      force: true,
      filter: (sourcePath) => shouldCopy(source, sourcePath),
    });
  }

  const mcpPath = join(targetRoot, '.mcp.json');
  let mcpConfig;
  try {
    mcpConfig = JSON.parse(await readFile(mcpPath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read bundled MCP configuration at ${mcpPath}: ${error.message}`);
  }

  const serverConfig = mcpConfig?.[PLUGIN_NAME];
  if (!serverConfig || typeof serverConfig !== 'object' || Array.isArray(serverConfig)) {
    throw new Error(`The bundled MCP configuration is missing the ${PLUGIN_NAME} server entry: ${mcpPath}`);
  }
  serverConfig.env ??= {};
  serverConfig.env.NEO4J_HTTP_URL = String(neo4jHttpUrl);
  serverConfig.env.NEO4J_DATABASE = String(neo4jDatabase);
  await writeFile(mcpPath, `${JSON.stringify(mcpConfig, null, 2)}\n`, 'utf8');

  let marketplacePath = null;
  if (!skipMarketplace) {
    marketplacePath = join(homeDir, '.agents', 'plugins', 'marketplace.json');
    await mkdir(dirname(marketplacePath), { recursive: true });

    let marketplace;
    try {
      marketplace = JSON.parse(await readFile(marketplacePath, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new Error(`Existing marketplace JSON is invalid and was not modified: ${marketplacePath}\n${error.message}`);
      }
      marketplace = {
        name: 'local-personal',
        interface: { displayName: 'Local Personal Plugins' },
        plugins: [],
      };
    }

    assertMarketplaceObject(marketplace, marketplacePath);
    marketplace.name ??= 'local-personal';
    marketplace.interface ??= { displayName: 'Local Personal Plugins' };
    if (!Array.isArray(marketplace.plugins)) marketplace.plugins = [];
    marketplace.plugins = [
      ...marketplace.plugins.filter((entry) => entry?.name !== PLUGIN_NAME),
      graphReasoningMarketplaceEntry(marketplaceSource),
    ];
    await writeFile(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf8');
  }

  return {
    sourceRoot: source,
    targetRoot,
    mcpPath,
    marketplacePath,
    neo4jHttpUrl: String(neo4jHttpUrl),
    neo4jDatabase: String(neo4jDatabase),
  };
}

