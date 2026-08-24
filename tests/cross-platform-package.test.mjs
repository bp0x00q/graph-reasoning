import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

test('package contains native setup entry points for Windows and Linux', async () => {
  const required = [
    'setup/windows/install.ps1',
    'setup/windows/configure-neo4j.ps1',
    'setup/windows/test.ps1',
    'setup/linux/install.sh',
    'setup/linux/configure-neo4j.sh',
    'setup/linux/test.sh',
    'scripts/install.mjs',
    'scripts/configure-neo4j.mjs',
    'scripts/verify.mjs',
  ];

  for (const relativePath of required) {
    assert.equal(await exists(resolve(root, relativePath)), true, `${relativePath} is missing`);
  }
});



test('OS wrappers delegate to the same shared setup implementation', async () => {
  const windowsInstall = await readFile(resolve(root, 'setup/windows/install.ps1'), 'utf8');
  const windowsConfigure = await readFile(resolve(root, 'setup/windows/configure-neo4j.ps1'), 'utf8');
  const windowsTest = await readFile(resolve(root, 'setup/windows/test.ps1'), 'utf8');
  const linuxInstall = await readFile(resolve(root, 'setup/linux/install.sh'), 'utf8');
  const linuxConfigure = await readFile(resolve(root, 'setup/linux/configure-neo4j.sh'), 'utf8');
  const linuxTest = await readFile(resolve(root, 'setup/linux/test.sh'), 'utf8');

  assert.match(windowsInstall, /scripts[\\/]install\.mjs/i);
  assert.match(linuxInstall, /scripts\/install\.mjs/i);
  assert.match(windowsConfigure, /scripts[\\/]configure-neo4j\.mjs/i);
  assert.match(linuxConfigure, /scripts\/configure-neo4j\.mjs/i);
  assert.match(windowsTest, /scripts[\\/]verify\.mjs/i);
  assert.match(linuxTest, /scripts\/verify\.mjs/i);
  assert.match(linuxInstall, /^#!\/usr\/bin\/env bash/m);
});

test('package metadata is platform-neutral and does not require Docker', async () => {
  const plugin = JSON.parse(await readFile(resolve(root, '.codex-plugin/plugin.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const readme = await readFile(resolve(root, 'README.md'), 'utf8');

  assert.equal(plugin.version, '0.2.0');
  assert.equal(pkg.version, '0.2.0');
  assert.doesNotMatch(plugin.description, /windows|linux/i);
  assert.doesNotMatch(plugin.interface.longDescription, /windows-local|linux-local/i);
  assert.doesNotMatch(pkg.description, /windows-local|linux-local/i);
  assert.match(readme, /Windows/i);
  assert.match(readme, /Linux/i);
  assert.doesNotMatch(readme, /Docker.*required|required.*Docker/i);
  assert.equal(await exists(resolve(root, 'docker-compose.yml')), false);
});

test('repository-ready package includes CI and publication guidance', async () => {
  assert.equal(await exists(resolve(root, '.github/workflows/ci.yml')), true);
  assert.equal(await exists(resolve(root, 'PUBLICATION-CHECKLIST.md')), true);
  const ci = await readFile(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  const publication = await readFile(resolve(root, 'PUBLICATION-CHECKLIST.md'), 'utf8');
  assert.match(ci, /ubuntu-latest/);
  assert.match(ci, /windows-latest/);
  assert.match(publication, /license/i);
});
