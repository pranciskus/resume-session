import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceContextError } from './context.js';
const exec = promisify(execFile);
export const validDriveId = (id) =>
  typeof id === 'string' && /^[A-Za-z0-9_-]{10,200}$/.test(id) && !id.startsWith('local-');
export function driveFolderId(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Use the Google Drive folder link from its Share dialog.');
  }
  const id = url.pathname.match(/\/folders\/([A-Za-z0-9_-]+)\/?$/)?.[1];
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'drive.google.com' ||
    url.username ||
    url.password ||
    !validDriveId(id)
  )
    throw new Error('Expected a https://drive.google.com/drive/folders/ID link.');
  return id;
}
async function canonical(value) {
  try {
    return await fs.realpath(value);
  } catch {
    return path.resolve(value);
  }
}

// DriveFS metadata is an optional, read-only adapter. Never infer a cloud ID
// from a folder name. Unknown desktop schemas fall through to explicit binding.
export async function mirrorFolderId(cwd, accountRoot, onError = () => {}) {
  let mirror, metadata;
  try {
    mirror = new DatabaseSync(path.join(accountRoot, 'mirror_sqlite.db'), { readOnly: true });
    metadata = new DatabaseSync(path.join(accountRoot, 'mirror_metadata_sqlite.db'), {
      readOnly: true,
    });
    const query = mirror.prepare(
      'SELECT local_stable_id, stable_id, inode, parent_local_stable_id, local_filename, is_root FROM mirror_item WHERE inode = ?',
    );
    query.setReadBigInts(true);
    const parentQuery = mirror.prepare(
      'SELECT local_stable_id, stable_id, inode, parent_local_stable_id, local_filename, is_root FROM mirror_item WHERE local_stable_id = ?',
    );
    parentQuery.setReadBigInts(true);
    const stat = await fs.stat(cwd, { bigint: true });
    if (!stat.isDirectory()) return;
    const candidates = query.all(stat.ino),
      matches = new Set();
    for (const candidate of candidates) {
      let item = candidate,
        directory = cwd,
        anchored = false;
      const seen = new Set();
      while (item && seen.size < 256 && !seen.has(item.local_stable_id)) {
        seen.add(item.local_stable_id);
        const current = await fs.stat(directory, { bigint: true });
        if (!current.isDirectory() || current.ino !== item.inode) break;
        if (item.is_root === 1n) {
          const root = mirror
            .prepare('SELECT item_id FROM root_config WHERE local_stable_id = ?')
            .get(item.local_stable_id);
          const cloud = metadata
            .prepare(
              'SELECT id FROM items WHERE stable_id = ? AND is_folder = 1 AND trashed = 0 AND is_tombstone = 0',
            )
            .get(item.stable_id);
          anchored = Boolean(root && cloud && root.item_id === cloud.id);
          break;
        }
        if (
          path.basename(directory) !== item.local_filename ||
          path.dirname(directory) === directory
        )
          break;
        directory = path.dirname(directory);
        item = parentQuery.get(item.parent_local_stable_id);
      }
      if (!anchored) continue;
      const cloud = metadata
        .prepare(
          'SELECT id FROM items WHERE stable_id = ? AND is_folder = 1 AND trashed = 0 AND is_tombstone = 0',
        )
        .get(candidate.stable_id);
      if (validDriveId(cloud?.id)) matches.add(cloud.id);
    }
    if (matches.size === 1) return [...matches][0];
  } catch (error) {
    onError(error); /* Missing, locked or changed desktop metadata is not proof of identity. */
  } finally {
    mirror?.close();
    metadata?.close();
  }
}
async function nativeId(cwd) {
  try {
    let value;
    if (process.platform === 'win32') {
      const handle = await fs.open(cwd + ':user.drive.id', 'r');
      try {
        const bytes = Buffer.alloc(256);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        value = bytes.subarray(0, bytesRead).toString('utf8').trim();
      } finally {
        await handle.close();
      }
    } else if (process.platform === 'darwin') {
      value = (
        await exec('/usr/bin/xattr', ['-p', 'user.drive.id', cwd], {
          timeout: 3000,
          maxBuffer: 4096,
        })
      ).stdout.trim();
    }
    if (validDriveId(value)) return value;
  } catch {}
}
export async function identifyDriveFolder(cwd, { config = {}, accountRoots } = {}) {
  const root = await canonical(cwd);
  const direct = await nativeId(root);
  if (direct) return { folderId: direct, root, source: 'drive-desktop' };
  if (!accountRoots) {
    const base =
      process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'Google', 'DriveFS')
        : path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'DriveFS');
    try {
      accountRoots = (await fs.readdir(base, { withFileTypes: true }))
        .filter((item) => item.isDirectory() && /^\d+$/.test(item.name))
        .map((item) => path.join(base, item.name));
    } catch {
      accountRoots = [];
    }
  }
  const matches = new Set();
  for (const account of accountRoots) {
    const id = await mirrorFolderId(root, account);
    if (id) matches.add(id);
  }
  if (matches.size === 1) return { folderId: [...matches][0], root, source: 'drive-desktop' };
  if (matches.size > 1)
    throw new WorkspaceContextError(
      'Multiple Drive identities match this folder. Reconnect Drive for desktop before continuing.',
      { kind: 'folder', name: path.basename(root) },
    );
  for (const binding of config.driveFolders || []) {
    if (validDriveId(binding.folderId) && (await canonical(binding.path)) === root)
      return { folderId: binding.folderId, root, source: 'user-linked' };
  }
}
export function looksLikeDrivePath(cwd) {
  return /(?:GoogleDrive-[^/\\]+|Google Drive|My Drive|Shared drives)(?:[/\\]|$)/i.test(cwd);
}

export const driveWorkspace = {
  validate(workspace) {
    if (
      !validDriveId(workspace.folderId) ||
      typeof workspace.name !== 'string' ||
      workspace.name.length > 1024 ||
      workspace.cwd !== ''
    )
      throw new Error('Invalid Google Drive workspace.');
  },
  async capture(cwd, options) {
    const found = await identifyDriveFolder(cwd, options);
    if (!found)
      throw new Error(
        'Cannot identify this Google Drive folder. Run resume drive link FOLDER_URL in the folder once, then retry.',
      );
    return {
      root: found.root,
      sourceRoot: path.resolve(cwd),
      files: [],
      workspace: {
        kind: 'gdrive',
        folderId: found.folderId,
        name: path.basename(found.root),
        cwd: '',
        identitySource: found.source,
      },
    };
  },
  async verify(snapshot, options) {
    const found = await identifyDriveFolder(snapshot.root, options);
    if (found?.folderId !== snapshot.workspace.folderId)
      throw new Error('Google Drive folder identity changed during capture.');
  },
  async check(workspace, cwd, options) {
    // Accept a selected descendant, but only after proving an ancestor's exact ID.
    let root = await canonical(cwd);
    for (let depth = 0; depth < 64; depth++) {
      const found = await identifyDriveFolder(root, options);
      if (found?.folderId === workspace.folderId) {
        await fs.access(root, fs.constants.R_OK);
        return { root, source: found.source };
      }
      if (path.dirname(root) === root) break;
      root = path.dirname(root);
    }
    throw new WorkspaceContextError(
      'The selected folder does not match the shared Google Drive folder, or its identity/access cannot be verified locally.',
      workspace,
    );
  },
  async restore(workspace, files, cwd, options) {
    if (files.length) throw new Error('Drive reference handoffs must not contain file overrides.');
    const found = await this.check(workspace, cwd, options);
    return {
      destination: found.root,
      externalState: true,
      notes: `Google Drive folder: https://drive.google.com/drive/folders/${workspace.folderId}\nIdentity matched using ${found.source === 'drive-desktop' ? 'Drive for desktop metadata' : 'a user-confirmed local binding'}. Folder contents are live and may have changed since sharing. Files are not bundled or overwritten. Verify current files and Drive sync before continuing. Local availability does not prove current online edit permission.`,
      async cleanup() {},
    };
  },
};
