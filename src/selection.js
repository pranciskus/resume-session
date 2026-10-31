import fs from 'node:fs/promises';
import path from 'node:path';
import spawn from 'cross-spawn';
import { Worker } from 'node:worker_threads';
import { parse } from 'shell-quote';
import { autocomplete, isCancel } from '@clack/prompts';
import { resolveTarget } from './core.js';
import { tools, validTargetName } from './agents.js';
import { aliasCommand } from './aliases.js';
export const clean = (value) => String(value || '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');

async function executable(command, env = process.env) {
  const paths =
    command.includes('/') || command.includes('\\') ? [''] : (env.PATH || '').split(path.delimiter);
  const extensions =
    process.platform === 'win32'
      ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')]
      : [''];
  for (const folder of paths)
    for (const extension of extensions) {
      try {
        const file = path.resolve(folder, command + extension);
        await fs.access(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        if ((await fs.stat(file)).isFile()) return true;
      } catch {}
    }
  return false;
}
async function shellHasCommand(name, env) {
  if (!/^[\w.-]+$/.test(name)) return false;
  const windows = process.platform === 'win32',
    fish = path.basename(env.SHELL || '') === 'fish';
  const script =
    'if (Get-Command -Name $env:RESUME_TARGET_NAME -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }';
  const args = windows
    ? ['-NoLogo', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
    : fish
      ? ['-ic', 'type -q -- $argv[1]', name]
      : ['-ic', 'command -v "$1" >/dev/null 2>&1', 'resume', name];
  return new Promise((resolve) => {
    const child = spawn(windows ? 'pwsh' : env.SHELL || '/bin/sh', args, {
      env: { ...env, RESUME_TARGET_NAME: name },
      stdio: 'ignore',
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 15000);
    child.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}
export async function targetAvailable(target) {
  const env = { ...process.env, ...target.env };
  return target.shell ? shellHasCommand(target.command, env) : executable(target.command, env);
}
async function shellAliases() {
  const windows = process.platform === 'win32',
    fish = path.basename(process.env.SHELL || '') === 'fish';
  return new Promise((resolve) => {
    const script = `$items = @(Get-Command -CommandType Alias,Function | ForEach-Object { $target = $null; if ($_.CommandType -eq 'Alias') { $target = $_.Definition } else { $calls = @($_.ScriptBlock.Ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)); if ($calls.Count -eq 1) { $target = $calls[0].GetCommandName() } }; if ($target) { @{ name = $_.Name; command = $target } } }); ConvertTo-Json -Compress -InputObject $items`;
    const child = spawn(
      windows ? 'pwsh' : process.env.SHELL || '/bin/sh',
      windows
        ? ['-NoLogo', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
        : ['-ic', fish ? 'functions (functions --names)' : 'alias'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    const timeout = setTimeout(() => {
      child.kill();
      resolve([]);
    }, 15000);
    child.stdout.on('data', (chunk) => {
      if (output.length < 1024 * 1024) output += chunk;
    });
    child.stderr.resume();
    child.on('error', () => {
      clearTimeout(timeout);
      resolve([]);
    });
    child.on('close', () => {
      clearTimeout(timeout);
      const aliases = [];
      if (windows) {
        try {
          for (const entry of JSON.parse(output)) {
            const tool = entry.command
              .split(/[\\/]/)
              .at(-1)
              .replace(/\.(exe|cmd|bat|ps1)$/i, '')
              .toLowerCase();
            if (tools.includes(tool)) aliases.push({ ...entry, tool });
          }
        } catch {}
        resolve(aliases);
        return;
      }
      for (const line of output.split('\n')) {
        try {
          if (fish) {
            const tokens = parse(line.trim());
            if (tokens[0] !== 'function') continue;
            const name = tokens[1];
            const wrap = tokens.findIndex(
              (t) => typeof t === 'string' && (t === '--wraps' || t.startsWith('--wraps=')),
            );
            if (wrap < 0) continue;
            const command = aliasCommand(
              tokens[wrap] === '--wraps' ? tokens[wrap + 1] : tokens[wrap].slice(8),
            );
            const tool = command?.split(/[\\/]/).at(-1);
            if (tools.includes(tool)) aliases.push({ name, tool, command });
            continue;
          }
          const entry = parse(line).find((t) => typeof t === 'string' && /^[\w.-]+=/.test(t));
          if (!entry) continue;
          const split = entry.indexOf('='),
            name = entry.slice(0, split),
            command = aliasCommand(entry.slice(split + 1));
          const tool = command?.split(/[\\/]/).at(-1);
          if (tools.includes(tool)) aliases.push({ name, tool, command });
        } catch {}
      }
      resolve(aliases);
    });
  });
}
export async function availableTargets(config) {
  const targets = new Map();
  for (const tool of tools)
    if (await executable(tool)) targets.set(tool, resolveTarget(tool, config));
  for (const alias of await shellAliases())
    if (await executable(alias.command))
      targets.set(alias.name, {
        name: alias.name,
        tool: alias.tool,
        command: alias.name,
        args: [],
        env: {},
        shell: true,
      });
  for (const name of Object.keys(config.targets || {})) {
    const target = resolveTarget(name, config);
    if (await targetAvailable(target)) targets.set(name, target);
    else targets.delete(name);
  }
  return [...targets.values()].filter((target) => validTargetName(target.name));
}
export async function chooseTarget(config, progress) {
  const targets = await progress('Finding installed agents', () => availableTargets(config));
  if (!targets.length)
    throw new Error('No supported agents found. Install Claude, Codex, Gemini, or OpenCode first.');
  if (!process.stdin.isTTY)
    throw new Error('Choose an agent explicitly in non-interactive mode: resume ID codex');
  const name = await autocomplete({
    message: 'Continue with which agent?',
    options: targets.map((t) => ({
      value: t.name,
      label: t.name,
      hint: t.name === t.tool ? undefined : t.tool,
    })),
  });
  return isCancel(name) ? undefined : targets.find((t) => t.name === name);
}
export async function chooseSession(sessions, id, message = 'Choose a session from this folder') {
  if (id) {
    const matches = sessions.filter((s) => s.id === id || s.key === id);
    if (matches.length !== 1)
      throw new Error(
        matches.length
          ? 'Ambiguous session ID; use its exact key from resume list --json.'
          : 'Session not found in this folder.',
      );
    return matches[0];
  }
  if (!sessions.length) throw new Error('No matching local sessions found.');
  if (!process.stdin.isTTY)
    throw new Error('Interactive selection requires a terminal. Supply --session ID.');
  const key = await autocomplete({
    message,
    maxItems: 12,
    options: sessions.map((s) => ({
      value: s.key,
      label: `${s.source} · ${clean(s.summary || s.id).slice(0, 110)}`,
      hint: `${clean(s.updatedAt)} · ${clean(s.cwd)}`,
    })),
  });
  return isCancel(key) ? undefined : sessions.find((s) => s.key === key);
}

export function inspectTarget(name, config) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./target-worker.js', import.meta.url), {
      workerData: { name, config },
      execArgv: [],
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('Timed out reading shell configuration.'));
    }, 20000);
    worker.once('message', (result) => {
      clearTimeout(timer);
      result.error ? reject(new Error(result.error)) : resolve(result.target);
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.once('exit', (code) => {
      clearTimeout(timer);
      if (code) reject(new Error(`Agent inspection exited (${code}).`));
    });
  });
}
