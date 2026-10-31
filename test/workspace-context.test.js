import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  captureCheckpoint,
  restoreCheckpoint,
  checkWorkspace,
  detectWorkspace,
  git,
} from '../src/checkpoint.js';
import { resolveTarget, worker } from '../src/core.js';
import { mirrorFolderId, driveFolderId } from '../src/workspaces/drive.js';
import { contextInstructions } from '../src/workspaces/context.js';
import { chooseWorkspace } from '../src/workspaces/guide.js';

const folderId = '1SharedWorkspaceABC123456789';
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-context-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sender = path.join(root, 'sender', 'Project'),
    recipient = path.join(root, 'recipient', 'Renamed project');
  await fs.mkdir(sender, { recursive: true });
  await fs.mkdir(recipient, { recursive: true });
  const account = { tool: 'claude', root: path.join(root, 'history'), label: 'test' },
    id = '22222222-2222-4222-8222-222222222222';
  const originalPath = path.join(account.root, 'projects', 'project', id + '.jsonl');
  await fs.mkdir(path.dirname(originalPath), { recursive: true });
  await fs.writeFile(
    originalPath,
    JSON.stringify({
      type: 'user',
      sessionId: id,
      cwd: sender,
      timestamp: '2026-10-31T10:00:00.000Z',
      message: {
        role: 'user',
        content: `Investigate the report in ${sender}/report.txt; preserve the source data.`,
      },
    }) + '\n',
  );
  const [session] = await worker(account, 'list');
  return {
    root,
    sender,
    recipient,
    session: { ...session, account },
    config: {
      driveFolders: [
        { path: sender, folderId },
        { path: recipient, folderId },
      ],
    },
    stateRoot: path.join(root, 'private-context'),
  };
}

test('Drive folder IDs, not names or account paths, establish shared context', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.sender, 'report.txt'), 'sender live data');
  await fs.writeFile(path.join(f.recipient, 'report.txt'), 'recipient live data');
  const options = { config: f.config, accountRoots: [], stateRoot: f.stateRoot };
  const checkpoint = await captureCheckpoint(f.session, options);
  assert.equal(checkpoint.workspace.kind, 'gdrive');
  assert.equal(checkpoint.workspace.folderId, folderId);
  assert.deepEqual(checkpoint.files, []);
  const result = await restoreCheckpoint(
    checkpoint,
    f.recipient,
    'rs_' + 'd'.repeat(24),
    resolveTarget('codex', {}),
    options,
  );
  assert.equal(result.cwd, await fs.realpath(f.recipient));
  assert.ok(!result.file.startsWith(f.recipient));
  assert.equal(
    await fs.readFile(path.join(f.recipient, 'report.txt'), 'utf8'),
    'recipient live data',
  );
  assert.deepEqual(
    await fs.readdir(f.recipient),
    ['report.txt'],
    'no context or metadata written to Drive',
  );
  const brief = await fs.readFile(result.file, 'utf8');
  assert.match(brief, /Request access/);
  assert.match(brief, /may have changed/);
  assert.ok(brief.includes(folderId));
  assert.ok(brief.includes(result.cwd + '/report.txt'));
  const mismatch = {
    ...options,
    config: { driveFolders: [{ path: f.recipient, folderId: '1DifferentFolderABC123456789' }] },
  };
  await assert.rejects(
    checkWorkspace(checkpoint, f.recipient, mismatch),
    (error) => error.code === 'WORKSPACE_CONTEXT',
  );
  await assert.rejects(
    chooseWorkspace(checkpoint, f.recipient, {
      config: mismatch.config,
      progress: (_m, operation) => operation(),
      interactive: false,
    }),
    (error) => /Request access/.test(error.message) && /--history-only/.test(error.message),
  );
});

test('history-only resume never uses an unrelated working folder or reconstructs unavailable files', async (t) => {
  const f = await fixture(t);
  await git(f.sender, 'init');
  await git(f.sender, 'config', 'user.email', 'test@example.com');
  await git(f.sender, 'config', 'user.name', 'Test');
  await fs.writeFile(path.join(f.sender, 'report.txt'), 'base');
  await git(f.sender, 'add', '.');
  await git(f.sender, 'commit', '-m', 'base');
  await git(f.sender, 'remote', 'add', 'origin', 'https://github.com/example/project.git');
  await fs.writeFile(path.join(f.sender, 'report.txt'), 'changed after commit');
  const checkpoint = await captureCheckpoint(f.session);
  const before = await fs.readdir(f.recipient);
  await assert.rejects(
    checkWorkspace(checkpoint, f.recipient),
    (error) => error.code === 'WORKSPACE_CONTEXT',
  );
  const result = await restoreCheckpoint(
    checkpoint,
    f.recipient,
    'rs_' + 'h'.repeat(24),
    resolveTarget('gemini', {}),
    { historyOnly: true, stateRoot: f.stateRoot },
  );
  assert.equal(result.historyOnly, true);
  assert.notEqual(result.cwd, f.recipient);
  assert.deepEqual(await fs.readdir(f.recipient), before);
  await assert.rejects(fs.stat(path.join(result.cwd, 'report.txt')), { code: 'ENOENT' });
  const brief = await fs.readFile(result.file, 'utf8');
  assert.match(brief, /HISTORY-ONLY MODE/);
  assert.match(brief, /git clone https:\/\/github.com\/example\/project.git/);
  assert.match(brief, /original workspace unavailable/);
  assert.ok(!brief.includes(f.sender));
  assert.match(result.args.at(-1), /original files are unavailable/);
});

test('ordinary folders share only history and explicitly defer file collection', async (t) => {
  const f = await fixture(t);
  const checkpoint = await captureCheckpoint(f.session, { accountRoots: [] });
  assert.equal(checkpoint.workspace.kind, 'folder');
  assert.deepEqual(checkpoint.files, []);
  assert.match(contextInstructions(checkpoint.workspace), /not implemented yet/);
  await assert.rejects(
    checkWorkspace(checkpoint, f.sender),
    (error) => error.code === 'WORKSPACE_CONTEXT',
  );
  const result = await restoreCheckpoint(
    checkpoint,
    f.recipient,
    'rs_' + 'f'.repeat(24),
    resolveTarget('claude', {}),
    { historyOnly: true, stateRoot: f.stateRoot },
  );
  assert.equal(result.historyOnly, true);
});

test('unknown Drive folders are not silently treated as ordinary folders', async (t) => {
  const f = await fixture(t),
    unknown = path.join(f.root, 'GoogleDrive-test', 'My Drive', 'Project');
  await fs.mkdir(unknown, { recursive: true });
  await assert.rejects(detectWorkspace(unknown, { accountRoots: [] }), /resume drive link/);
});

test('Drive folder links are constrained to genuine Google Drive folder URLs', () => {
  assert.equal(
    driveFolderId(`https://drive.google.com/drive/u/0/folders/${folderId}?usp=sharing`),
    folderId,
  );
  for (const link of [
    `https://evil.example/drive/folders/${folderId}`,
    `https://drive.google.com.evil.example/drive/folders/${folderId}`,
    `http://drive.google.com/drive/folders/${folderId}`,
    'file:///etc/passwd',
    'https://drive.google.com/drive/folders/local-pending',
  ])
    assert.throws(() => driveFolderId(link));
});

test('DriveFS native detection verifies inode ancestry and cloud root identity, read-only', async (t) => {
  const f = await fixture(t),
    account = path.join(f.root, 'desktop-account');
  await fs.mkdir(account);
  const mirrorFile = path.join(account, 'mirror_sqlite.db'),
    metaFile = path.join(account, 'mirror_metadata_sqlite.db');
  const mirror = new DatabaseSync(mirrorFile),
    meta = new DatabaseSync(metaFile);
  mirror.exec(
    'CREATE TABLE mirror_item(local_stable_id INTEGER, stable_id INTEGER, inode INTEGER, parent_local_stable_id INTEGER, local_filename TEXT, is_root INTEGER); CREATE TABLE root_config(local_stable_id INTEGER, item_id TEXT);',
  );
  meta.exec(
    'CREATE TABLE items(stable_id INTEGER, id TEXT, is_folder INTEGER, trashed INTEGER, is_tombstone INTEGER);',
  );
  const parent = path.dirname(f.sender),
    rootId = '0RootFolderABC123456789';
  mirror
    .prepare('INSERT INTO mirror_item VALUES(1,11,?,NULL,?,1)')
    .run((await fs.stat(parent, { bigint: true })).ino, path.basename(parent));
  mirror
    .prepare('INSERT INTO mirror_item VALUES(2,22,?,1,?,0)')
    .run((await fs.stat(f.sender, { bigint: true })).ino, path.basename(f.sender));
  mirror.prepare('INSERT INTO root_config VALUES(1,?)').run(rootId);
  meta.prepare('INSERT INTO items VALUES(11,?,1,0,0)').run(rootId);
  meta.prepare('INSERT INTO items VALUES(22,?,1,0,0)').run(folderId);
  mirror.close();
  meta.close();
  const beforeMirror = await fs.readFile(mirrorFile),
    beforeMeta = await fs.readFile(metaFile);
  assert.equal(await mirrorFolderId(f.sender, account), folderId);
  assert.equal(await mirrorFolderId(f.recipient, account), undefined);
  const checkpoint = await captureCheckpoint(f.session, { accountRoots: [account] });
  assert.equal(checkpoint.workspace.identitySource, 'drive-desktop');
  assert.deepEqual(await fs.readFile(mirrorFile), beforeMirror);
  assert.deepEqual(await fs.readFile(metaFile), beforeMeta);
});

test('a quota-blocked receiving agent can re-share the earlier job without losing its context', async (t) => {
  const f = await fixture(t);
  await git(f.sender, 'init');
  await git(f.sender, 'config', 'user.email', 'test@example.com');
  await git(f.sender, 'config', 'user.name', 'Test');
  await fs.writeFile(path.join(f.sender, 'input.txt'), 'source data');
  await git(f.sender, 'add', '.');
  await git(f.sender, 'commit', '-m', 'base');
  await git(f.root, 'clone', f.sender, path.join(f.root, 'clone'));
  const original = await captureCheckpoint(f.session);
  const incoming = await restoreCheckpoint(
    original,
    path.join(f.root, 'clone'),
    'rs_' + 'q'.repeat(24),
    resolveTarget('claude', {}),
  );
  const id = '33333333-3333-4333-8333-333333333333',
    file = path.join(f.session.account.root, 'projects', 'project', id + '.jsonl');
  await fs.writeFile(
    file,
    ['user', 'assistant']
      .map((role, index) =>
        JSON.stringify({
          type: role,
          sessionId: id,
          cwd: incoming.cwd,
          timestamp: '2026-10-31T11:00:00.000Z',
          message: {
            role,
            content: index
              ? 'Usage limit reached.'
              : 'Continue the shared session in .resume/HANDOFF.md.',
          },
        }),
      )
      .join('\n') + '\n',
  );
  const next = (await worker(f.session.account, 'list')).find((s) => s.id === id);
  const reshared = await captureCheckpoint({ ...next, account: f.session.account });
  assert.equal(reshared.ancestry.length, 1);
  assert.ok(JSON.stringify(reshared.ancestry).includes('preserve the source data'));
  const resumed = await restoreCheckpoint(
    reshared,
    f.recipient,
    'rs_' + 'r'.repeat(24),
    resolveTarget('codex', {}),
    { historyOnly: true, stateRoot: f.stateRoot },
  );
  const brief = await fs.readFile(resumed.file, 'utf8');
  assert.match(brief, /Earlier shared context/);
  const earlier = await fs.readFile(
    path.join(path.dirname(resumed.file), 'parents', 'rs_' + 'q'.repeat(24), 'history.json'),
    'utf8',
  );
  assert.match(earlier, /preserve the source data/);
  assert.ok(!earlier.includes(incoming.cwd));
});

test('Drive re-sharing preserves prior context without copying private archives into the shared folder', async (t) => {
  const f = await fixture(t),
    options = { config: f.config, accountRoots: [], stateRoot: f.stateRoot };
  const original = await captureCheckpoint(f.session, options);
  const incoming = await restoreCheckpoint(
    original,
    f.recipient,
    'rs_' + 'v'.repeat(24),
    resolveTarget('claude', {}),
    options,
  );
  const id = '44444444-4444-4444-8444-444444444444',
    file = path.join(f.session.account.root, 'projects', 'project', id + '.jsonl');
  await fs.writeFile(
    file,
    JSON.stringify({
      type: 'user',
      sessionId: id,
      cwd: incoming.cwd,
      timestamp: '2026-10-31T12:00:00.000Z',
      message: { role: 'user', content: incoming.args.at(-1) },
    }) + '\n',
  );
  const next = (await worker(f.session.account, 'list')).find((s) => s.id === id);
  const reshared = await captureCheckpoint({ ...next, account: f.session.account }, options);
  assert.equal(reshared.ancestry.length, 1);
  assert.equal(reshared.ancestry[0].id, 'rs_' + 'v'.repeat(24));
  assert.deepEqual(await fs.readdir(f.recipient), []);
});

test('Git access guidance omits credentials and permits a matching upstream remote', async (t) => {
  const f = await fixture(t);
  await git(f.sender, 'init');
  await git(f.sender, 'config', 'user.email', 'test@example.com');
  await git(f.sender, 'config', 'user.name', 'Test');
  await fs.writeFile(path.join(f.sender, 'input.txt'), 'data');
  await git(f.sender, 'add', '.');
  await git(f.sender, 'commit', '-m', 'base');
  const cloned = path.join(f.root, 'fork');
  await git(f.root, 'clone', f.sender, cloned);
  await git(
    f.sender,
    'remote',
    'add',
    'origin',
    'https://username:private-token@example.com/team/project.git?token=hidden',
  );
  const checkpoint = await captureCheckpoint(f.session);
  assert.equal(checkpoint.workspace.cloneUrl, 'https://example.com/team/project.git');
  assert.ok(!JSON.stringify(checkpoint.workspace).includes('private-token'));
  await git(cloned, 'remote', 'set-url', 'origin', 'https://example.com/fork/project.git');
  await git(cloned, 'remote', 'add', 'upstream', 'https://example.com/team/project.git');
  assert.ok((await checkWorkspace(checkpoint, cloned)).root);
});
