import fs from 'node:fs/promises';
import path from 'node:path';
import {
  records,
  filesIn,
  safeId,
  textParts,
  message,
  asText,
  selectWorkers,
} from './recovery-io.js';

// Gemini JSONL is an append-only state journal, not a sequence of independent messages.
async function conversation(file, warnings) {
  if (file.endsWith('.json')) return JSON.parse(await fs.readFile(file, 'utf8'));
  let meta = {},
    messages = new Map();
  const put = (row) => messages.set(row.id || `line-${messages.size}`, row);
  const patch = (update) => {
    const old = messages.get(update.id);
    if (!old) return;
    if (update.content !== undefined) old.content = update.content;
    for (const tool of update.toolCalls || []) {
      const existing = old.toolCalls?.find((item) => item.id === tool.id);
      if (existing && 'result' in tool) existing.result = tool.result;
    }
  };
  await records(
    file,
    (row, line) => {
      if (row.$rewindTo) {
        const ids = [...messages.keys()],
          start = ids.indexOf(row.$rewindTo);
        if (start === -1) messages.clear();
        else for (const id of ids.slice(start)) messages.delete(id);
      } else if (row.$patch) {
        const p = row.$patch;
        if (p.id) patch(p);
        for (const update of p.updates || []) patch(update);
        for (const id of p.removeIds || []) messages.delete(id);
        if (p.orderIds) {
          const ordered = new Map();
          for (const id of p.orderIds) if (messages.has(id)) ordered.set(id, messages.get(id));
          for (const [id, value] of messages) if (!ordered.has(id)) ordered.set(id, value);
          messages = ordered;
        }
      } else if (row.$set) {
        meta = { ...meta, ...row.$set };
        if (Array.isArray(row.$set.messages)) {
          messages.clear();
          row.$set.messages.forEach(put);
        }
      } else if (['user', 'gemini', 'error', 'info', 'warning'].includes(row.type))
        put({ ...row, sourceLine: line });
      else meta = { ...meta, ...row };
    },
    warnings,
  );
  return { ...meta, messages: [...messages.values()] };
}

export async function geminiSource(session, warnings) {
  const folder = path.dirname(session.originalPath),
    index = new Map();
  const children = safeId(session.id)
    ? await filesIn(path.join(folder, session.id), ['.jsonl', '.json'])
    : [];
  const candidates = new Set([
    session.originalPath,
    ...children,
    ...(await filesIn(folder, ['.json', '.jsonl'], false)),
  ]);
  for (const file of candidates) {
    let data;
    try {
      data = await conversation(file, warnings);
    } catch (error) {
      if (file === session.originalPath) throw error;
      warnings.push({ file, issue: 'Could not read Gemini conversation.' });
      continue;
    }
    if (file === session.originalPath && data.sessionId !== session.id)
      throw new Error('Gemini recovery could not identify the selected session.');
    if (!data.sessionId) continue;
    if (file !== session.originalPath && !children.includes(file) && data.kind !== 'subagent')
      continue;
    const descriptor = {
      id: data.sessionId,
      file,
      explicitParent: Boolean(data.parentSessionId),
      meta: {
        parentAgentId: data.parentSessionId || (children.includes(file) ? session.id : undefined),
        cwd: data.directories?.[0],
        name: data.agentName,
      },
      async read(visit) {
        // Re-read to detect current journal state. Source stat checks flag concurrent changes.
        const current = await conversation(file, warnings);
        for (const [i, saved] of (current.messages || []).entries()) {
          const row = message(
            saved.type === 'user' ? 'user' : 'assistant',
            textParts(saved.content),
            { ...saved, cwd: current.directories?.[0] || session.cwd },
          );
          row.recoveryDispatches = [];
          row.recoveryLinks = [];
          row.recoveryReports = [];
          if (saved.type === 'error') row.apiError = asText(saved.content);
          for (const tc of saved.toolCalls || []) {
            row.message.content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.args || {},
            });
            if (tc.result != null)
              row.message.content.push({
                type: 'tool_result',
                tool_use_id: tc.id,
                content: textParts(tc.result),
                is_error: tc.status === 'error',
              });
            const knownDelegate = [
              'delegate_to_agent',
              'run_agent',
              'codebase_investigator',
              'generalist',
            ].includes(tc.name);
            if (tc.agentId || knownDelegate) {
              row.recoveryDispatches.push({
                callId: tc.id,
                name: tc.name,
                prompt: asText(tc.args?.prompt || tc.args?.query || tc.args?.task || tc.args),
                description: tc.description,
              });
              if (tc.agentId) {
                row.recoveryLinks.push({ callId: tc.id, id: tc.agentId });
                row.recoveryReports.push({
                  id: tc.agentId,
                  status: tc.status,
                  detail: asText(tc.result),
                  timestamp: tc.timestamp,
                });
              }
            }
          }
          await visit(row, saved.sourceLine || i + 1);
        }
      },
    };
    if (index.has(descriptor.id))
      warnings.push({
        file,
        agentId: descriptor.id,
        issue: 'Duplicate Gemini session ID; using the first discovered conversation.',
      });
    else index.set(descriptor.id, descriptor);
  }
  const parent = index.get(session.id);
  if (!parent) throw new Error('Gemini recovery could not identify the selected session.');
  // Directory nesting points to the main session, while tool records identify the actual parent.
  // Only reachable conversations can establish relationships. Another chat
  // in this folder must not steal a worker by mentioning its session ID.
  const queue = [parent],
    queued = new Set([parent.id]);
  const assigned = new Set(
    [...index.values()].filter((item) => item.explicitParent).map((item) => item.id),
  );
  for (let offset = 0; offset < queue.length; offset++) {
    const descriptor = queue[offset];
    await descriptor.read((row) => {
      for (const link of row.recoveryLinks || []) {
        const child = index.get(link.id);
        if (!child || child.id === parent.id || child.id === descriptor.id) continue;
        if (assigned.has(child.id) && child.meta.parentAgentId !== descriptor.id) {
          warnings.push({
            file: descriptor.file,
            agentId: child.id,
            issue: 'Conflicting Gemini worker parent; retained the established relationship.',
          });
          continue;
        }
        child.meta.parentAgentId = descriptor.id;
        assigned.add(child.id);
      }
    });
    for (const child of index.values()) {
      if (child.meta.parentAgentId === descriptor.id && !queued.has(child.id)) {
        queue.push(child);
        queued.add(child.id);
      }
    }
  }
  return { parent, workers: await selectWorkers(parent, index, warnings) };
}
