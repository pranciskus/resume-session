import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { availableTargets, inspectTarget, targetAvailable } from '../src/selection.js';

test(
  'installed target picker includes real executables and detected aliases, excludes unavailable commands',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-target-test-'));
    const previous = { PATH: process.env.PATH, SHELL: process.env.SHELL };
    t.after(async () => {
      Object.assign(process.env, previous);
      await fs.rm(root, { recursive: true, force: true });
    });
    await fs.writeFile(path.join(root, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await fs.writeFile(
      path.join(root, 'shell'),
      `#!/bin/sh
printf "work='codex --model example'\\n"
`,
      { mode: 0o755 },
    );
    process.env.PATH = root;
    process.env.SHELL = path.join(root, 'shell');
    const choices = await availableTargets({
      targets: { missing: { tool: 'claude', command: path.join(root, 'missing'), shell: false } },
    });
    assert.deepEqual(choices.map((t) => t.name).sort(), ['codex', 'work']);
    assert.equal(choices.find((t) => t.name === 'work').shell, true);
    assert.equal(
      await targetAvailable({ command: path.join(root, 'missing'), env: {}, shell: false }),
      false,
    );
  },
);

test('target inspection preserves configured command, options and environment', async () => {
  const target = await inspectTarget('custom', {
    targets: {
      custom: {
        tool: 'codex',
        command: process.execPath,
        args: ['--example'],
        env: { EXAMPLE: 'value' },
        shell: false,
      },
    },
  });
  assert.equal(target.command, process.execPath);
  assert.deepEqual(target.args, ['--example']);
  assert.equal(target.env.EXAMPLE, 'value');
});
