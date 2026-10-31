import { parseArgs } from 'node:util';
import { confirm, isCancel } from '@clack/prompts';
import { readConfig, discover, filterSessions } from './core.js';
import { chooseSession, clean } from './selection.js';
import { createProgress } from './progress.js';
import { captureCheckpoint } from './checkpoint.js';
import { cloudSettings, upload, revoke } from './cloud.js';

export async function share(args) {
  const { values: opt } = parseArgs({
    args,
    options: {
      help: { type: 'boolean' },
      yes: { type: 'boolean' },
      json: { type: 'boolean' },
      session: { type: 'string' },
      path: { type: 'string' },
      search: { type: 'string' },
      revoke: { type: 'string' },
    },
  });
  if (opt.help) {
    console.log(
      `resume share — share a session from the current folder\n\n  resume share\n  resume share --session ID [--yes] [--json]\n  resume share --path PATH [--search TEXT]\n  resume share --revoke CLOUD_ID\n\nSet RESUME_SERVER and RESUME_TOKEN on both computers.\nThe checkpoint includes conversation, saved subagent work and workspace context. Git includes file changes; Google Drive uses the existing shared folder.\nIgnored files and external files are excluded. Downloads expire after 7 days by default.\n--yes approves uploading the displayed checkpoint without an interactive prompt.`,
    );
    return;
  }
  const config = await readConfig(),
    settings = cloudSettings(config);
  const progress = createProgress({ enabled: Boolean(process.stderr.isTTY) && !opt.json });
  if (opt.revoke) {
    await progress('Revoking handoff', () => revoke(settings, opt.revoke));
    console.log(opt.json ? JSON.stringify({ revoked: opt.revoke }) : 'Handoff revoked.');
    return;
  }
  const found = await progress('Finding local sessions', () => discover(config));
  for (const warning of found.warnings) console.error(`Warning: ${clean(warning)}`);
  const sessions = filterSessions(found.sessions, {
    folder: opt.path || process.cwd(),
    search: opt.search,
  });
  const session = await chooseSession(sessions, opt.session);
  if (!session) return;
  const checkpoint = await progress('Preparing files, conversation and subagent work', () =>
    captureCheckpoint(session, { config }),
  );
  const workspaceInfo =
    checkpoint.workspace.kind === 'git'
      ? `Git repository: ${clean(checkpoint.workspace.identity || '(no remote)')}`
      : checkpoint.workspace.kind === 'gdrive'
        ? `Google Drive: https://drive.google.com/drive/folders/${checkpoint.workspace.folderId}\nFiles remain in Drive; recipients need their own Google permissions. Wait for Drive to finish syncing before sharing.`
        : 'Local folder: history only. Files are not bundled; recipients can continue from conversation context.';
  console.error(
    `${workspaceInfo}\n${clean(session.summary || session.id)}\n${checkpoint.files.length} bundled file changes · ${checkpoint.recovery.count} worker records · ${(Buffer.byteLength(JSON.stringify(checkpoint)) / 1024).toFixed(0)} KiB\nServer: ${settings.server}\nFiles: ${checkpoint.files.map((f) => clean(f.path)).join(', ') || '(none)'}\nConversation and worker history will be shared with anyone holding this server’s team token. Secret detection is best-effort.`,
  );
  if (!opt.yes) {
    if (!process.stdin.isTTY)
      throw new Error('Review the checkpoint above and use --yes to approve upload.');
    const approved = await confirm({ message: 'Share this checkpoint?' });
    if (isCancel(approved) || !approved) return;
  }
  const receipt = await progress('Uploading handoff', () => upload(settings, checkpoint));
  console.log(
    opt.json
      ? JSON.stringify(receipt)
      : `Shared: ${receipt.id}\nExpires: ${receipt.expiresAt}\n\nOn another computer, run:\n  resume ${receipt.id}`,
  );
}
