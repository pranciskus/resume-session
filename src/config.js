import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { tools, validTargetName } from './agents.js';

export const configPath = () =>
  process.env.RESUME_CONFIG || path.join(os.homedir(), '.config', 'resume', 'config.json');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.length > 0 && !value.includes('\0');
function requireConfig(condition, field) {
  if (!condition) throw new Error(`Invalid configuration: ${field}.`);
}

export function validateConfig(config) {
  requireConfig(record(config), 'expected an object');
  if (config.sources !== undefined) {
    requireConfig(Array.isArray(config.sources), 'sources must be an array');
    for (const source of config.sources) {
      requireConfig(
        record(source) && tools.includes(source.tool) && text(source.root),
        'each source needs a supported tool and root',
      );
      for (const field of ['label', 'db']) {
        requireConfig(
          source[field] === undefined || text(source[field]),
          `source ${field} must be a nonempty string`,
        );
      }
    }
  }
  if (config.targets !== undefined) {
    requireConfig(record(config.targets), 'targets must be an object');
    for (const [name, target] of Object.entries(config.targets)) {
      requireConfig(validTargetName(name), 'target name is invalid or reserved');
      requireConfig(
        record(target) && tools.includes(target.tool),
        'each target needs a supported tool',
      );
      requireConfig(
        target.command === undefined || text(target.command),
        'target command must be a nonempty string',
      );
      requireConfig(
        target.shell === undefined || typeof target.shell === 'boolean',
        'target shell must be a boolean',
      );
      requireConfig(
        target.args === undefined ||
          (Array.isArray(target.args) &&
            target.args.every((arg) => typeof arg === 'string' && !arg.includes('\0'))),
        'target args must be strings',
      );
      requireConfig(
        target.env === undefined ||
          (record(target.env) &&
            Object.entries(target.env).every(
              ([key, value]) =>
                text(key) &&
                !key.includes('=') &&
                typeof value === 'string' &&
                !value.includes('\0'),
            )),
        'target env must contain string values',
      );
    }
  }
  if (config.driveFolders !== undefined) {
    requireConfig(Array.isArray(config.driveFolders), 'driveFolders must be an array');
    for (const binding of config.driveFolders) {
      requireConfig(
        record(binding) &&
          text(binding.path) &&
          typeof binding.folderId === 'string' &&
          /^[A-Za-z0-9_-]{10,200}$/.test(binding.folderId) &&
          !binding.folderId.startsWith('local-'),
        'Drive bindings need a path and cloud folder ID',
      );
    }
  }
  if (config.cloud !== undefined) {
    requireConfig(record(config.cloud), 'cloud must be an object');
    requireConfig(
      config.cloud.server === undefined || text(config.cloud.server),
      'cloud server must be a URL string',
    );
  }
  return config;
}

export async function readConfig(filename = configPath()) {
  let contents;
  try {
    contents = await fs.readFile(filename, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  let config;
  try {
    config = JSON.parse(contents);
  } catch {
    throw new Error(`Invalid JSON in configuration: ${filename}`);
  }
  return validateConfig(config);
}

export async function writeConfig(config, filename = configPath()) {
  validateConfig(config);
  const contents = JSON.stringify(config, null, 2) + '\n';
  // Preserve an intentional dotfiles symlink, but replace its destination
  // atomically. A partial write must never truncate the existing settings.
  let destination;
  try {
    destination = await fs.realpath(filename);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const existing = await fs.lstat(filename).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (existing?.isSymbolicLink())
      throw new Error('Configuration symlink has a missing destination; repair it before saving.');
    destination = path.resolve(filename);
  }
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(destination), `.resume-config-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, destination);
  } finally {
    await handle?.close();
    await fs.rm(temporary, { force: true });
  }
}
