import path from 'node:path';
import os from 'node:os';
import { select, text, isCancel } from '@clack/prompts';
import { checkWorkspace } from '../checkpoint.js';
import { contextInstructions } from './context.js';

export async function chooseWorkspace(
  checkpoint,
  cwd,
  { config, progress, historyOnly = false, interactive = process.stdin.isTTY } = {},
) {
  if (historyOnly) return { cwd, historyOnly: true };
  while (true) {
    cwd =
      cwd === '~'
        ? os.homedir()
        : cwd.startsWith('~/')
          ? path.join(os.homedir(), cwd.slice(2))
          : cwd;
    try {
      await progress('Checking workspace context', () =>
        checkWorkspace(checkpoint, cwd, { config }),
      );
      return { cwd, historyOnly: false };
    } catch (error) {
      if (error.code !== 'WORKSPACE_CONTEXT') throw error;
      const guidance = `${error.message}\n\n${contextInstructions(checkpoint.workspace)}\n\nYou can also continue without the files using --history-only.`;
      if (!interactive) throw new Error(guidance);
      console.error(guidance);
      const choice = await select({
        message: 'How would you like to continue?',
        output: process.stderr,
        options: [
          {
            value: 'history',
            label: 'Continue with session history only',
            hint: 'Original files will be unavailable',
          },
          { value: 'folder', label: 'Choose the correct local folder' },
          { value: 'stop', label: 'Stop and set up access first' },
        ],
      });
      if (isCancel(choice) || choice === 'stop') return;
      if (choice === 'history') return { cwd, historyOnly: true };
      const value = await text({
        message: 'Local folder path',
        output: process.stderr,
        validate: (v) => (v?.trim() ? undefined : 'Enter a folder path.'),
      });
      if (isCancel(value)) return;
      cwd = value.trim();
    }
  }
}
