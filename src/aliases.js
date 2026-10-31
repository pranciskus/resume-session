import path from 'node:path';
import spawn from 'cross-spawn';
import { parse } from 'shell-quote';

// This reads definitions only. The user's shell performs the actual expansion
// at launch, preserving its quoting, environment assignments, and flags.
export function aliasCommand(definition) {
  const tokens = parse(definition, (key) => `UNRESOLVED_VARIABLE_${key}`);
  if (tokens.some((token) => typeof token !== 'string')) return undefined;
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] || '')) index++;
  if (tokens[index] === 'env') {
    index++;
    while (index < tokens.length) {
      const token = tokens[index];
      if (token === '-u' || token === '--unset') {
        index += 2;
        continue;
      }
      if (
        ['-i', '--ignore-environment', '--'].includes(token) ||
        token.startsWith('--unset=') ||
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
      ) {
        index++;
        continue;
      }
      break;
    }
  }
  if (tokens[index] === 'command' || tokens[index] === 'exec') {
    index++;
    if (tokens[index] === '--') index++;
  }
  const command = tokens[index];
  return command && !command.startsWith('-') && !command.includes('UNRESOLVED_VARIABLE_')
    ? command
    : undefined;
}

function definitionFor(name, env, platform) {
  let command, args;
  const marker = 'RESUME_ALIAS_DEFINITION:';
  if (platform === 'win32') {
    command = 'pwsh';
    const script = `$c = Get-Command -Name $env:RESUME_ALIAS_NAME -ErrorAction SilentlyContinue; if ($c.CommandType -eq 'Alias') { Write-Output ('${marker}' + $c.Definition) } elseif ($c.CommandType -eq 'Function') { $calls = @($c.ScriptBlock.Ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)); if ($calls.Count -eq 1) { Write-Output ('${marker}' + $calls[0].GetCommandName()) } }`;
    args = ['-NoLogo', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  } else {
    command = env.SHELL || '/bin/sh';
    if (path.basename(command) === 'fish') {
      args = ['-ic', 'functions -- $argv[1]', name];
    } else {
      args = ['-ic', `printf '${marker}\\n'; alias -- "$1" 2>/dev/null`, 'resume', name];
    }
  }
  const result = spawn.sync(command, args, {
    env: { ...env, RESUME_ALIAS_NAME: name },
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    if (result.error.code === 'ENOENT') return undefined;
    throw new Error(`Could not inspect shell alias ${name}: ${result.error.message}`);
  }
  const output = result.stdout || '';
  if (platform === 'win32')
    return output
      .split(/\r?\n/)
      .find((line) => line.startsWith(marker))
      ?.slice(marker.length)
      .trim();
  if (path.basename(command) === 'fish') {
    const line = output.split(/\r?\n/).find((line) => /^function\s/.test(line));
    if (!line) return undefined;
    const tokens = parse(line);
    const wraps = tokens.findIndex(
      (token) => typeof token === 'string' && (token === '--wraps' || token.startsWith('--wraps=')),
    );
    return wraps < 0
      ? undefined
      : tokens[wraps] === '--wraps'
        ? tokens[wraps + 1]
        : tokens[wraps].slice('--wraps='.length);
  }
  const start = output.lastIndexOf(marker);
  if (start < 0) return undefined;
  const tokens = parse(output.slice(start + marker.length).trim());
  return tokens
    .find((token) => typeof token === 'string' && token.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

export function detectAliasTool(
  name,
  tools,
  { env = process.env, platform = process.platform } = {},
) {
  const seen = new Set();
  let current = name;
  while (current && !seen.has(current) && seen.size < 8) {
    seen.add(current);
    const definition = definitionFor(current, env, platform);
    if (!definition) return undefined;
    const executable = platform === 'win32' ? definition : aliasCommand(definition);
    if (!executable) return undefined;
    const filename = executable
      .split(/[\\/]/)
      .at(-1)
      .replace(/\.(exe|cmd|bat|ps1)$/i, '');
    const base = platform === 'win32' ? filename.toLowerCase() : filename;
    if (tools.includes(base)) return base;
    // Only simple names can refer to another shell alias. Paths are executables.
    if (!/^[\w.-]+$/.test(executable)) return undefined;
    current = executable;
  }
  return undefined;
}
