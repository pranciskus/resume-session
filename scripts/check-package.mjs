// Validate the distributable's real global command, including Windows npm shims.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import spawn from 'cross-spawn';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-install-'));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this check with npm run test:package');
function run(command, args) {
  const result = spawn.sync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
try {
  const [pack] = JSON.parse(
    run(process.execPath, [npm, 'pack', '--json', '--pack-destination', root]),
  );
  assert.ok(
    pack.files.every((file) =>
      /^(bin\/|src\/|README\.md$|LICENSE$|package\.json$)/.test(file.path),
    ),
    'Only distribution files may be packed',
  );
  const prefix = path.join(root, 'installed');
  run(process.execPath, [
    npm,
    'install',
    '-g',
    '--prefix',
    prefix,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    path.join(root, pack.filename),
  ]);
  const executable = path.join(
    prefix,
    ...(process.platform === 'win32' ? ['resume.cmd'] : ['bin', 'resume']),
  );
  assert.match(run(executable, ['--help']), /current folder and its subfolders/);
  assert.match(run(executable, ['share', '--help']), /share a session/);
  console.log(
    `Packed installation and resume command passed on ${process.platform} (${process.version}).`,
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
