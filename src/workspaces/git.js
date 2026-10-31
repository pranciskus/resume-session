import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkspaceContextError } from './context.js';
import { MAX_BYTES } from '../cloud-protocol.js';
import { safeRelative, secretCheck, checkParents } from './files.js';
const exec = promisify(execFile);
export async function git(cwd, ...args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  const result = await exec(
    'git',
    ['-c', `core.hooksPath=${os.devNull}`, '-c', 'core.fsmonitor=false', ...args],
    { cwd, env, encoding: 'utf8', maxBuffer: MAX_BYTES, timeout: 60000 },
  );
  return result.stdout;
}
export function repoIdentity(remote) {
  if (!remote) return null;
  // Strip credentials, normalize SSH/HTTPS transports, retain host and full repo path.
  let value = remote.trim();
  if (/^[^/@]+@[^:]+:/.test(value)) value = value.replace(/^[^@]+@([^:]+):/, '$1/');
  else {
    try {
      const url = new URL(value);
      value = url.host + url.pathname;
    } catch {
      return null;
    }
  }
  return value.replace(/\.git\/?$/, '').replace(/\/$/, '');
}
async function identity(root) {
  try {
    return repoIdentity(await git(root, 'remote', 'get-url', 'origin'));
  } catch {
    return null;
  }
}
async function cloneUrl(root) {
  try {
    const raw = (await git(root, 'remote', 'get-url', 'origin')).trim();
    if (/^[\w.-]+@[\w.-]+:[\w./-]+$/.test(raw)) return raw;
    const url = new URL(raw);
    if (!['https:', 'ssh:'].includes(url.protocol) || /[\x00-\x20]/.test(raw)) return null;
    url.password = '';
    if (url.protocol === 'https:') url.username = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}
async function changedFiles(root, base) {
  const tracked = (await git(root, 'diff', '--name-only', '-z', '--no-renames', base, '--'))
    .split('\0')
    .filter(Boolean);
  const deleted = new Set(
    (await git(root, 'diff', '--name-only', '--diff-filter=D', '-z', '--no-renames', base, '--'))
      .split('\0')
      .filter(Boolean),
  );
  const untracked = (await git(root, 'ls-files', '--others', '--exclude-standard', '-z'))
    .split('\0')
    .filter(Boolean);
  const recreated = new Set(untracked);
  const files = [];
  let bytes = 0;
  for (const name of [...new Set([...tracked, ...untracked])].sort()) {
    if (name === '.resume' || name.startsWith('.resume/')) continue;
    safeRelative(name);
    // A staged deletion can coexist with a new, untracked file at the same
    // path. Capture its current bytes instead of losing the replacement.
    if (deleted.has(name) && !recreated.has(name)) {
      files.push({ path: name, deleted: true });
      continue;
    }
    await checkParents(root, name);
    let stat;
    try {
      stat = await fs.lstat(path.join(root, name));
    } catch (error) {
      if (error.code === 'ENOENT') {
        files.push({ path: name, deleted: true });
        continue;
      }
      throw error;
    }
    if (!stat.isFile())
      throw new Error(`Cannot share changed symlink, submodule, or directory: ${name}`);
    if (stat.size > MAX_BYTES || (bytes += stat.size) > MAX_BYTES)
      throw new Error('Changed files exceed 32 MiB.');
    const data = await fs.readFile(path.join(root, name));
    secretCheck(name, data.toString('utf8'));
    files.push({
      path: name,
      data: data.toString('base64'),
      executable: Boolean(stat.mode & 0o111),
    });
  }
  return files;
}

// A workspace adapter describes how to snapshot and reconstruct files. Session
// history, worker recovery and transport do not depend on Git.
export const gitWorkspace = {
  validate(workspace) {
    if (
      !/^[a-f0-9]{40,64}$/.test(workspace.base || '') ||
      !/^[a-f0-9]{40,64}$/.test(workspace.head || '')
    )
      throw new Error('Invalid Git checkpoint.');
    if (
      workspace.cloneUrl != null &&
      (typeof workspace.cloneUrl !== 'string' ||
        workspace.cloneUrl.length > 2048 ||
        /[\x00-\x20]/.test(workspace.cloneUrl) ||
        repoIdentity(workspace.cloneUrl) !== workspace.identity ||
        !/^(https:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:)/.test(workspace.cloneUrl))
    )
      throw new Error('Invalid repository checkout URL.');
    if (workspace.cloneUrl?.includes('://')) {
      const url = new URL(workspace.cloneUrl);
      if (url.password || (url.protocol === 'https:' && url.username) || url.search || url.hash)
        throw new Error(
          'Repository checkout URL must not contain credentials or query parameters.',
        );
    }
    if (
      workspace.identity !== null &&
      (typeof workspace.identity !== 'string' || workspace.identity.length > 2048)
    )
      throw new Error('Invalid repository identity.');
  },
  async capture(cwd) {
    const root = (await git(cwd, 'rev-parse', '--show-toplevel')).trim();
    const head = (await git(root, 'rev-parse', 'HEAD')).trim();
    if ((await git(root, 'ls-files', '--unmerged')).trim())
      throw new Error('Resolve Git conflicts before handing off.');
    // Rebuild unpushed work as changes against a commit the other checkout can have.
    const boundary = (await git(root, 'rev-list', '--boundary', 'HEAD', '--not', '--remotes'))
      .split('\n')
      .find((line) => /^-[a-f0-9]{40,64}$/.test(line));
    const base = boundary ? boundary.slice(1) : head;
    const files = await changedFiles(root, base);

    const canonicalCwd = await fs.realpath(cwd);
    const sourceRoot = path.resolve(cwd, path.relative(canonicalCwd, root));
    return {
      root,
      sourceRoot,
      files,
      workspace: {
        kind: 'git',
        identity: await identity(root),
        cloneUrl: await cloneUrl(root),
        base,
        head,
        cwd: path.relative(root, canonicalCwd).split(path.sep).join('/'),
      },
    };
  },
  async verify(snapshot) {
    const {
      root,
      files,
      workspace: { base, head },
    } = snapshot;
    if (
      (await git(root, 'rev-parse', 'HEAD')).trim() !== head ||
      JSON.stringify(await changedFiles(root, base)) !== JSON.stringify(files)
    )
      throw new Error('Project changed during capture. Pause edits and retry handoff.');
  },
  async check(workspace, cwd) {
    let root;
    try {
      root = (await git(cwd, 'rev-parse', '--show-toplevel')).trim();
    } catch {
      throw new WorkspaceContextError(
        'This folder is not a checkout of the required Git repository.',
        workspace,
      );
    }
    const names = (await git(root, 'remote')).trim().split('\n').filter(Boolean);
    const identities = await Promise.all(
      names.map(async (name) => {
        try {
          return repoIdentity(await git(root, 'remote', 'get-url', name));
        } catch {
          return null;
        }
      }),
    );
    if (workspace.identity && !identities.includes(workspace.identity))
      throw new WorkspaceContextError(
        'Wrong repository: this checkout does not match the shared session.',
        workspace,
      );
    try {
      await git(root, 'cat-file', '-e', workspace.base + '^{commit}');
    } catch {
      throw new WorkspaceContextError(
        'Required Git base is missing from this checkout.',
        workspace,
      );
    }
    return { root };
  },
  async restore(workspace, files, cwd) {
    const { root } = await this.check(workspace, cwd);
    const parent = await fs.mkdtemp(path.join(path.dirname(root), '.resume-worktree-'));
    const destination = path.join(parent, 'project');
    let added = false;
    try {
      await git(root, 'worktree', 'add', '--detach', destination, workspace.base);
      added = true;
      const ordered = [...files].sort(
        (a, b) => Number(b.deleted === true) - Number(a.deleted === true),
      );
      for (const file of ordered) {
        await checkParents(destination, file.path);
        const filename = path.join(destination, file.path);
        let stat;
        try {
          stat = await fs.lstat(filename);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (stat && !stat.isFile() && !(file.deleted && stat.isSymbolicLink()))
          throw new Error(`Cannot overwrite symlink or directory: ${file.path}`);
        if (file.deleted) {
          if (stat) await fs.unlink(filename);
          for (
            let directory = path.dirname(filename);
            directory !== destination;
            directory = path.dirname(directory)
          ) {
            try {
              await fs.rmdir(directory);
            } catch (error) {
              if (['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) break;
              throw error;
            }
          }
        } else {
          await fs.mkdir(path.dirname(filename), { recursive: true });
          await fs.writeFile(filename, Buffer.from(file.data, 'base64'), {
            mode: file.executable ? 0o755 : 0o644,
          });
          await fs.chmod(filename, file.executable ? 0o755 : 0o644);
        }
      }

      return {
        destination,
        notes: `Git base: ${workspace.base}\nOriginal HEAD: ${workspace.head}\nUnpushed, staged, and unstaged changes are restored as uncommitted files; original commit/index boundaries are not reproduced. Unchanged files come from the Git base. Dependencies and ignored files are not transferred.`,
        async cleanup() {
          await git(root, 'worktree', 'remove', '--force', destination);
          await fs.rm(parent, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (added) await git(root, 'worktree', 'remove', '--force', destination).catch(() => {});
      await fs.rm(parent, { recursive: true, force: true });
      throw error;
    }
  },
};
