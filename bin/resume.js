#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import { validTargetName } from '../src/agents.js';
import { resumeOptions, splitArgs } from '../src/args.js';
import { chooseWorkspace } from '../src/workspaces/guide.js';
import { driveFolderId, identifyDriveFolder } from '../src/workspaces/drive.js';
import fs from 'node:fs/promises';
import { share } from '../src/share.js';
import { createProgress } from '../src/progress.js';
import {
  chooseTarget,
  chooseSession,
  clean,
  inspectTarget,
  targetAvailable,
} from '../src/selection.js';
import { ID_PATTERN } from '../src/cloud-protocol.js';
import { cloudSettings, download } from '../src/cloud.js';
import { restoreCheckpoint, validateCheckpoint } from '../src/checkpoint.js';
import {
  readConfig,
  writeConfig,
  configPath,
  discover,
  filterSessions,
  plan,
  launch,
  tools,
} from '../src/core.js';

const help = `resume — continue local or shared sessions in any agent

  resume share                   Share a session from this folder
  resume share --revoke CLOUD_ID  Revoke a shared checkpoint
  resume                         Choose a local session and installed agent
  resume rs_ID [AGENT]            Continue a cloud handoff (aliases supported)
  resume drive link FOLDER_URL   Link a local Drive folder if automatic detection is unavailable
  resume codex|claude|gemini|opencode|clauded
  resume TARGET --session ID [--dry-run] [--handoff]
  resume TARGET --path ~/git/project
  resume TARGET --here
  resume list [--json] [--search TEXT] [--path PATH]
  resume source add LABEL --tool AGENT --root PATH
  resume target add ALIAS --tool AGENT

Options:
  --session ID    Select an exact session ID (or key from list --json)
  --search TEXT   Filter by title, ID, source, account or directory
  --path PATH     Only chats in this folder or its subfolders
  --here          Use the current folder (the default)
  --all           Show chats from every folder (explicit opt-in)
  --cwd PATH      Override the directory where the selected chat resumes
  --dry-run       Print launch plan without writing a handoff or starting an agent
  --history-only  Continue a shared session without its original workspace files
  --handoff       Start a new context handoff even for same-agent sessions
  --prepare       Write a handoff and worker recovery plan without launching an agent
  --json         Machine-readable session list
  --help         Show this help

By default, only chats in the current folder and its subfolders are shown.
All accounts sharing a history directory are included automatically. Add custom
account roots with source add. Config: ${configPath()}
Agent flags are passed through; use -- to forward options that conflict with resume's.
`;

async function main() {
  if (process.argv[2] === 'share') {
    await share(process.argv.slice(3));
    return;
  }
  const { args, extra } = splitArgs(process.argv.slice(2));
  const { values: opt, positionals: pos } = parseArgs({
    args,
    allowPositionals: true,
    options: resumeOptions,
  });
  if (opt.help) {
    console.log(help);
    return;
  }
  const progress = createProgress({
    enabled: Boolean(process.stderr.isTTY) && !opt.json && !opt['dry-run'],
  });
  const config = await readConfig();
  if (pos[0]?.startsWith('rs_')) {
    if (!ID_PATTERN.test(pos[0]))
      throw new Error(
        'Invalid shared-session ID. Use the complete rs_ ID printed by resume share.',
      );
    const checkpoint = validateCheckpoint(
      await progress('Downloading handoff', () => download(cloudSettings(config), pos[0])),
    );
    if (opt['dry-run']) {
      console.log(
        JSON.stringify(
          {
            source: checkpoint.session.source,
            workspace: checkpoint.workspace,
            files: checkpoint.files.map((f) => f.path),
            historyOnly: Boolean(opt['history-only']),
          },
          null,
          2,
        ),
      );
      return;
    }
    const location = await chooseWorkspace(checkpoint, opt.cwd || process.cwd(), {
      config,
      progress,
      historyOnly: opt['history-only'],
    });
    if (!location) return;
    const agent = extra[0] && !extra[0].startsWith('-') ? extra.shift() : undefined;
    let target = agent
      ? await progress('Reading agent configuration', () => inspectTarget(agent, config))
      : await chooseTarget(config, progress);
    if (!target) return;
    if (!(await progress('Checking agent availability', () => targetAvailable(target)))) {
      if (!process.stdin.isTTY)
        throw new Error(`${target.name} is not available on this computer.`);
      console.error(`${target.name} is not available on this computer.`);
      target = await chooseTarget(config, progress);
      if (!target) return;
    }
    target.args.push(...extra);
    const result = await progress('Restoring files, conversation and subagent work', () =>
      restoreCheckpoint(checkpoint, location.cwd, pos[0], target, {
        config,
        historyOnly: location.historyOnly,
      }),
    );
    if (opt.prepare) {
      console.log(
        opt.json
          ? JSON.stringify(result, null, 2)
          : `Prepared handoff: ${result.file}\nWorkspace: ${result.workspacePath}`,
      );
      return;
    }
    console.error(
      `${result.historyOnly ? 'History-only workspace' : 'Workspace'}: ${result.workspacePath}`,
    );
    process.exitCode = await launch(result, { progress });
    return;
  }
  if (opt['history-only']) throw new Error('--history-only applies to shared rs_ session IDs.');
  if (pos[0] === 'drive') {
    if (pos[1] !== 'link' || pos.length !== 3 || extra.length)
      throw new Error('Use resume drive link FOLDER_URL [--path PATH].');
    const folderId = driveFolderId(pos[2]);
    const folder = await fs.realpath(opt.path || process.cwd());
    if (!(await fs.stat(folder)).isDirectory())
      throw new Error('Drive binding must refer to a directory.');
    const native = await identifyDriveFolder(folder, { config: {} });
    if (native && native.folderId !== folderId)
      throw new Error('The folder link conflicts with the identity reported by Drive for desktop.');
    config.driveFolders = (config.driveFolders || []).filter((binding) => binding.path !== folder);
    config.driveFolders.push({ path: folder, folderId });
    await writeConfig(config);
    console.log(
      'Linked this local folder to its Google Drive folder ID. This records your mapping; it does not grant or verify online permissions.',
    );
    return;
  }
  if (['source', 'target'].includes(pos[0])) {
    if (pos[1] !== 'add' || pos.length !== 3 || extra.length || !tools.includes(opt.tool))
      throw new Error('Use source/target add NAME --tool claude|codex|gemini|opencode');
    if (pos[0] === 'source') {
      if (!opt.root) throw new Error('source add requires --root PATH');
      config.sources ||= [];
      config.sources = config.sources.filter((s) => s.label !== pos[2]);
      config.sources.push({ label: pos[2], tool: opt.tool, root: path.resolve(opt.root) });
    } else {
      if (!validTargetName(pos[2])) throw new Error('Invalid or reserved target name.');
      config.targets ||= {};
      config.targets[pos[2]] = { tool: opt.tool, shell: true };
    }
    await writeConfig(config);
    console.log(`Saved ${pos[2]} in ${configPath()}`);
    return;
  }
  const target =
    pos[0] === 'list'
      ? null
      : pos[0]
        ? await progress('Reading agent configuration', () => inspectTarget(pos[0], config))
        : await chooseTarget(config, progress);
  if (!target && pos[0] !== 'list') return;
  const found = await progress('Finding local sessions…', () => discover(config));
  for (const warning of found.warnings) console.error(`Warning: ${warning}`);
  if ([opt.path, opt.here, opt.all].filter(Boolean).length > 1)
    throw new Error('Use only one of --path, --here or --all.');
  const folder = opt.all ? undefined : opt.path || process.cwd();
  const sessions = filterSessions(found.sessions, { folder, search: opt.search });
  if (!target) {
    console.log(
      opt.json
        ? JSON.stringify(sessions, null, 2)
        : sessions
            .map(
              (s) =>
                `${s.id}  ${s.source}/${s.account.label || 'custom'}  ${s.updatedAt}\n  ${clean(s.summary || '(untitled)')}\n  ${clean(s.cwd)}`,
            )
            .join('\n'),
    );
    return;
  }
  if (!sessions.length)
    throw new Error(
      'No matching local sessions found. Use resume source add for a custom account directory.',
    );
  const session = await chooseSession(
    sessions,
    opt.session,
    `Continue which session in ${target.name}${folder ? ` (folder: ${folder})` : ''}? Type to search.`,
  );
  if (!session) return;
  target.args.push(...extra);
  const result = await progress('Preparing session and saved subagent work…', () =>
    plan(session, target, {
      cwd: opt.cwd,
      handoff: opt.handoff || opt.prepare,
      dryRun: opt['dry-run'],
    }),
  );
  if (opt['dry-run']) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (opt.prepare) {
    console.log(
      opt.json
        ? JSON.stringify(result, null, 2)
        : `Prepared handoff: ${result.file}${result.recovery ? `\nWorker recovery plan: ${result.recovery.instructions} (${result.recovery.count} worker/dispatch records)` : ''}`,
    );
    return;
  }
  console.error(
    result.mode === 'native'
      ? `Resuming ${session.source} session ${session.id}`
      : `Context saved to ${result.file}`,
  );
  process.exitCode = await launch(result, { progress });
}
main().catch((error) => {
  console.error(`resume: ${error.message}`);
  process.exitCode = 1;
});
