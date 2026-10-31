import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readConfig, writeConfig, validateConfig } from '../src/config.js';
import { validTargetName } from '../src/agents.js';
import { resolveTarget } from '../src/core.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-config-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, file: path.join(root, 'config.json') };
}

test('configuration rejects malformed fields without echoing secret contents', async (t) => {
  const { file } = await fixture(t);
  assert.deepEqual(await readConfig(file), {});
  await fs.writeFile(file, '{"token":"PRIVATE_VALUE",');
  await assert.rejects(
    readConfig(file),
    (error) => /Invalid JSON/.test(error.message) && !error.message.includes('PRIVATE_VALUE'),
  );
  for (const config of [
    null,
    [],
    { sources: {} },
    { sources: [null] },
    { targets: [] },
    { targets: { test: { tool: 'codex', args: '--danger' } } },
    { targets: { test: { tool: 'codex', env: { TOKEN: {} } } } },
    { targets: { test: { tool: 'codex', shell: 'false' } } },
    { driveFolders: [{ path: '/tmp', folderId: 'local-1234567' }] },
    { cloud: null },
  ]) {
    assert.throws(() => validateConfig(config), /Invalid configuration/);
  }
});

test('configuration saves a complete private replacement and preserves prior bytes on invalid input', async (t) => {
  const { root, file } = await fixture(t);
  await fs.writeFile(file, '{}\n', { mode: 0o644 });
  const config = {
    targets: {
      work: {
        tool: 'codex',
        command: process.execPath,
        args: [''],
        env: { EXAMPLE: '' },
        shell: false,
      },
    },
  };
  await writeConfig(config, file);
  assert.deepEqual(await readConfig(file), config);
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const before = await fs.readFile(file);
  await assert.rejects(writeConfig({ sources: null }, file), /Invalid configuration/);
  assert.deepEqual(await fs.readFile(file), before);
  assert.deepEqual(await fs.readdir(root), ['config.json']);
});

test('failed configuration rename cleans temporary files and preserves the destination', async (t) => {
  const { root, file } = await fixture(t);
  await fs.mkdir(file);
  await fs.writeFile(path.join(file, 'keep'), 'untouched');
  await assert.rejects(writeConfig({}, file));
  assert.equal(await fs.readFile(path.join(file, 'keep'), 'utf8'), 'untouched');
  assert.deepEqual(await fs.readdir(root), ['config.json']);
});

test(
  'intentional config symlinks survive saves; dangling links are not replaced',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { root, file } = await fixture(t);
    const destination = path.join(root, 'dotfiles.json');
    await fs.writeFile(destination, '{}');
    await fs.symlink('dotfiles.json', file);
    await writeConfig({ sources: [] }, file);
    assert.equal(await fs.readlink(file), 'dotfiles.json');
    assert.deepEqual(await readConfig(destination), { sources: [] });
    await fs.unlink(destination);
    await assert.rejects(writeConfig({}, file), /missing destination/);
    assert.equal(await fs.readlink(file), 'dotfiles.json');
  },
);

test('reserved commands and prototype property names cannot become agent targets', () => {
  for (const name of [
    'list',
    'source',
    'target',
    'drive',
    'share',
    'rs_any',
    '__proto__',
    'constructor',
    'prototype',
    '.',
    '..',
    '-flag',
  ]) {
    assert.equal(validTargetName(name), false);
    assert.throws(() => resolveTarget(name, {}), /reserved/);
    assert.throws(() => validateConfig({ targets: { [name]: { tool: 'codex' } } }), /reserved/);
  }
  const targets = Object.create({ codex: { tool: 'claude' } });
  // An inherited property must not override a known agent. Keep this test
  // independent of shell startup; dedicated alias tests cover that boundary.
  const target = resolveTarget('codex', { targets });
  assert.equal(target.tool, 'codex');
  assert.equal(target.shell, false);
});

test('CLI rejects ambiguous management commands without changing settings', async (t) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const exec = promisify(execFile);
  const { file } = await fixture(t);
  await writeConfig({}, file);
  const bin = fileURLToPath(new URL('../bin/resume.js', import.meta.url));
  for (const args of [
    ['target', 'add', 'list', '--tool', 'codex'],
    ['target', 'add', 'work', 'extra', '--tool', 'codex'],
    ['source', 'add', 'work', '--tool', 'claude', '--root', '/tmp', '--unexpected'],
  ]) {
    await assert.rejects(
      exec(process.execPath, [bin, ...args], {
        env: { ...process.env, RESUME_CONFIG: file },
        timeout: 5000,
      }),
      (error) => error.code === 1 && /reserved|Use source\/target/.test(error.stderr),
    );
    assert.deepEqual(await readConfig(file), {});
  }
});
