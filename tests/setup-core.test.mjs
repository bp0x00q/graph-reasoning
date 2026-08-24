import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertSupportedNode,
  configureNeo4jText,
  installGraphReasoning,
} from '../scripts/setup-core.mjs';

test('assertSupportedNode accepts Node 20+ and rejects older versions', () => {
  assert.equal(assertSupportedNode('20.0.0'), 20);
  assert.equal(assertSupportedNode('22.12.1'), 22);
  assert.throws(() => assertSupportedNode('18.20.5'), /Node\.js 20 or newer/);
  assert.throws(() => assertSupportedNode('not-a-version'), /Unable to determine/);
});

test('configureNeo4jText adds localhost-only unauthenticated HTTP settings once', () => {
  const input = [
    '# dbms.security.auth_enabled=true',
    'server.default_listen_address=0.0.0.0',
    'server.http.enabled=false',
    'server.http.enabled=true',
    'dbms.logs.query.enabled=INFO',
    '',
  ].join('\n');

  const output = configureNeo4jText(input);
  assert.equal((output.match(/^dbms\.security\.auth_enabled=false$/gm) ?? []).length, 1);
  assert.equal((output.match(/^server\.default_listen_address=127\.0\.0\.1$/gm) ?? []).length, 1);
  assert.equal((output.match(/^server\.http\.enabled=true$/gm) ?? []).length, 1);
  assert.match(output, /^dbms\.logs\.query\.enabled=INFO$/m);
});

test('installGraphReasoning copies the package, updates MCP settings, and preserves marketplace entries', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'graph-reasoning-install-'));
  const source = join(temp, 'source');
  const home = join(temp, 'home');
  const installRoot = join(home, '.codex', 'plugins');

  await mkdir(join(source, '.codex-plugin'), { recursive: true });
  await writeFile(join(source, '.codex-plugin', 'plugin.json'), '{"name":"graph-reasoning"}\n');
  await writeFile(join(source, '.mcp.json'), JSON.stringify({
    'graph-reasoning': {
      command: 'node',
      args: ['./server/index.mjs'],
      cwd: '.',
      env: { NEO4J_HTTP_URL: 'http://127.0.0.1:7474', NEO4J_DATABASE: 'neo4j' },
    },
  }, null, 2));
  await mkdir(join(source, 'server'), { recursive: true });
  await writeFile(join(source, 'server', 'index.mjs'), '');

  const marketplacePath = join(home, '.agents', 'plugins', 'marketplace.json');
  await mkdir(join(home, '.agents', 'plugins'), { recursive: true });
  await writeFile(marketplacePath, JSON.stringify({
    name: 'personal',
    plugins: [{ name: 'other-plugin', source: { source: 'local', path: './other' } }],
  }, null, 2));

  const result = await installGraphReasoning({
    sourceRoot: source,
    homeDir: home,
    installRoot,
    neo4jHttpUrl: 'http://127.0.0.1:7575',
    neo4jDatabase: 'reasoning',
  });

  const installedMcp = JSON.parse(await readFile(join(result.targetRoot, '.mcp.json'), 'utf8'));
  assert.equal(installedMcp['graph-reasoning'].env.NEO4J_HTTP_URL, 'http://127.0.0.1:7575');
  assert.equal(installedMcp['graph-reasoning'].env.NEO4J_DATABASE, 'reasoning');

  const marketplace = JSON.parse(await readFile(marketplacePath, 'utf8'));
  assert.deepEqual(marketplace.plugins.map((entry) => entry.name).sort(), ['graph-reasoning', 'other-plugin']);
  assert.equal(marketplace.plugins.find((entry) => entry.name === 'graph-reasoning').source.path, './.codex/plugins/graph-reasoning');
});


test('installGraphReasoning points the marketplace at a custom install root', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'graph-reasoning-custom-root-'));
  const source = join(temp, 'source');
  const home = join(temp, 'home');
  const installRoot = join(home, 'custom', 'plugins');

  await mkdir(join(source, '.codex-plugin'), { recursive: true });
  await writeFile(join(source, '.codex-plugin', 'plugin.json'), '{"name":"graph-reasoning"}\n');
  await writeFile(join(source, '.mcp.json'), JSON.stringify({
    'graph-reasoning': {
      command: 'node',
      args: ['./server/index.mjs'],
      cwd: '.',
      env: {},
    },
  }, null, 2));
  await mkdir(join(source, 'server'), { recursive: true });
  await writeFile(join(source, 'server', 'index.mjs'), '');

  await installGraphReasoning({ sourceRoot: source, homeDir: home, installRoot });
  const marketplace = JSON.parse(await readFile(join(home, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  assert.equal(
    marketplace.plugins.find((entry) => entry.name === 'graph-reasoning').source.path,
    './custom/plugins/graph-reasoning',
  );
});

test('installGraphReasoning refuses overlapping source and destination paths', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'graph-reasoning-paths-'));
  const source = join(temp, 'source');
  const home = join(temp, 'home');
  await mkdir(source, { recursive: true });

  await assert.rejects(
    installGraphReasoning({
      sourceRoot: source,
      homeDir: home,
      installRoot: join(source, 'nested-plugins'),
      skipMarketplace: true,
    }),
    /source and destination paths overlap/i,
  );
});

test('installGraphReasoning requires skipMarketplace for install roots outside the user home', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'graph-reasoning-external-root-'));
  const source = join(temp, 'source');
  const home = join(temp, 'home');
  const installRoot = join(temp, 'external-plugins');

  await mkdir(source, { recursive: true });

  await assert.rejects(
    installGraphReasoning({ sourceRoot: source, homeDir: home, installRoot }),
    /outside the user home.*skip-marketplace/i,
  );
});

test('configureNeo4jText preserves CRLF files for Windows installations', () => {
  const output = configureNeo4jText('server.http.enabled=false\r\n');
  assert.match(output, /server\.http\.enabled=true\r\n/);
  assert.equal(output.replace(/\r\n/g, '').includes('\n'), false);
});
