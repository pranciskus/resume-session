import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceContextError } from './context.js';
export const folderWorkspace = {
  validate(workspace) {
    if (
      typeof workspace.name !== 'string' ||
      workspace.name.length > 1024 ||
      workspace.cwd !== '' ||
      workspace.filesIncluded !== false
    )
      throw new Error('Invalid local-folder workspace.');
  },
  async capture(cwd) {
    const root = await fs.realpath(cwd);
    if (!(await fs.stat(root)).isDirectory()) throw new Error('Session folder is not a directory.');
    return {
      root,
      sourceRoot: path.resolve(cwd),
      files: [],
      workspace: { kind: 'folder', name: path.basename(root), cwd: '', filesIncluded: false },
    };
  },
  async verify(snapshot) {
    if (!(await fs.stat(snapshot.root)).isDirectory())
      throw new Error('Session folder is no longer available.');
  },
  async check(workspace) {
    throw new WorkspaceContextError(
      'This job references an ordinary local folder. Its files were not bundled and matching context cannot be established automatically.',
      workspace,
    );
  },
  async restore(workspace) {
    return this.check(workspace);
  },
};
