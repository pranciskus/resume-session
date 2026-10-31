import { safeRelative } from './workspaces/files.js';

const MAX_ENTRIES = 10000;
const MAX_DEPTH = 128;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// The archive is untrusted input. Bound nesting before recursive path mapping,
// and report protocol errors before creating any workspace or recovery files.
export function validateDepth(value) {
  const pending = [{ value, depth: 0 }];
  while (pending.length) {
    const current = pending.pop();
    if (current.depth > MAX_DEPTH) throw new Error('Checkpoint nesting exceeds 128 levels.');
    if (current.value && typeof current.value === 'object') {
      for (const child of Object.values(current.value)) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

export function validateEntries(entries, { artifacts = false } = {}) {
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES)
    throw new Error('Invalid checkpoint files.');
  const names = new Map();
  for (const entry of entries) {
    if (!record(entry)) throw new Error('Invalid checkpoint file entry.');
    safeRelative(entry.path);
    const key = entry.path.normalize('NFC').toLowerCase();
    if (names.has(key)) throw new Error('Duplicate checkpoint path.');
    names.set(key, entry);
    if (artifacts) {
      if (typeof entry.text !== 'string') throw new Error('Invalid recovery artifact.');
      const packets = entry.path.endsWith('.json')
        ? [entry.text]
        : entry.path.endsWith('.jsonl')
          ? entry.text.split('\n').filter((line) => line.trim())
          : [];
      for (const packet of packets) {
        let parsed;
        try {
          parsed = JSON.parse(packet);
        } catch {
          throw new Error(`Invalid recovery JSON: ${entry.path}`);
        }
        validateDepth(parsed);
      }
    } else if (entry.deleted === true) {
      if (entry.data !== undefined) throw new Error('Invalid deletion.');
    } else if (
      (entry.deleted !== undefined && entry.deleted !== false) ||
      typeof entry.data !== 'string' ||
      Buffer.from(entry.data, 'base64').toString('base64') !== entry.data ||
      typeof entry.executable !== 'boolean'
    ) {
      throw new Error('Invalid checkpoint file contents.');
    }
  }
  for (const [name, entry] of names) {
    // Deleted files can become directories (and vice versa). Only live file
    // ancestors conflict; deleted descendants are removed before writes.
    if (!artifacts && entry.deleted === true) continue;
    const parts = name.split('/');
    for (let end = 1; end < parts.length; end++) {
      const ancestor = names.get(parts.slice(0, end).join('/'));
      if (ancestor && (artifacts || ancestor.deleted !== true)) {
        throw new Error('Conflicting checkpoint file and directory paths.');
      }
    }
  }
}

export function validateSessionContext(session, recovery, supportedTools) {
  if (
    !record(session) ||
    !supportedTools.includes(session.source) ||
    typeof session.markdown !== 'string' ||
    !Array.isArray(session.messages)
  ) {
    throw new Error('Unsupported or incomplete handoff format.');
  }
  if (!record(recovery)) throw new Error('Invalid recovery context.');
  for (const key of ['count', 'warnings']) {
    if (!Number.isSafeInteger(recovery[key]) || recovery[key] < 0)
      throw new Error(`Invalid recovery ${key}.`);
  }
  validateEntries(recovery.artifacts, { artifacts: true });
}
