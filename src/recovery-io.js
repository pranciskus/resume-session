import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';

export async function records(file, visit, warnings) {
  const input = createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let number = 0;
  try {
    for await (const line of lines) {
      number++;
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        warnings.push({
          file,
          line: number,
          issue: 'Unreadable JSON record; possibly an incomplete write.',
        });
        continue;
      }
      if (row && typeof row === 'object' && (await visit(row, number)) === false) break;
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

export async function filesIn(folder, extensions = ['.jsonl'], recursive = true) {
  let entries;
  try {
    entries = await fs.readdir(folder, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory() && recursive) files.push(...(await filesIn(file, extensions)));
    else if (entry.isFile() && extensions.includes(path.extname(entry.name))) files.push(file);
  }
  return files.sort(); // Never follow history-directory symlinks out of the selected store.
}

export const safeId = (id) =>
  typeof id === 'string' && /^[\w.-]+$/.test(id) && id !== '.' && id !== '..';
export const asText = (value) =>
  typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
export const timestamp = (value) =>
  typeof value === 'number' ? new Date(value).toISOString() : value;
export function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
export function textParts(value) {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) => {
    if (typeof part === 'string') return [{ type: 'text', text: part }];
    if (typeof part?.text === 'string' && !part.thought && part.type !== 'reasoning')
      return [{ type: 'text', text: part.text }];
    if (part?.functionResponse)
      return [{ type: 'text', text: asText(part.functionResponse.response) }];
    return [];
  });
}
export function message(role, content, source = {}) {
  return {
    type: role,
    uuid: source.id,
    timestamp: timestamp(source.timestamp),
    cwd: source.cwd,
    message: { content },
    recoveryNormalized: true,
  };
}

// Select only the root's proven descendants/references. Unrelated same-folder chats are excluded.
export async function selectWorkers(parent, index, warnings) {
  const selected = new Map([[parent.id, parent]]),
    queue = [parent];
  for (let offset = 0; offset < queue.length; offset++) {
    const current = queue[offset];
    const add = (id, linked = false) => {
      if (!id || id === current.id || id === parent.id || selected.has(id)) return;
      const candidate = index.get(id) || {
        id,
        file: current.file,
        meta: { parentAgentId: current.id },
        referenceOnly: true,
        read: async () => {},
      };
      if (candidate.meta.parentAgentId === candidate.id) {
        warnings.push({
          file: candidate.file,
          agentId: id,
          issue: 'Self-referencing worker parent; using the dispatch relationship.',
        });
        candidate.meta.parentAgentId = current.id;
      }
      if (linked && candidate.meta.parentAgentId && candidate.meta.parentAgentId !== current.id) {
        warnings.push({
          file: current.file,
          agentId: id,
          issue:
            'A tool reference conflicts with the saved parent relationship; retained the saved relationship.',
        });
        return;
      }
      candidate.meta.parentAgentId ||= current.id;
      selected.set(id, candidate);
      queue.push(candidate);
    };
    try {
      await current.read((row) => {
        for (const link of row.recoveryLinks || []) add(link.id, true);
      });
    } catch (error) {
      if (current === parent) throw error;
      warnings.push({
        file: current.file,
        agentId: current.id,
        issue: 'Worker history could not be fully inspected; capture may be incomplete.',
      });
    }
    for (const candidate of index.values())
      if (candidate.meta.parentAgentId === current.id) add(candidate.id);
  }
  return [...selected.values()].filter((item) => item !== parent && !item.referenceOnly);
}
