import fs from 'node:fs/promises';
import path from 'node:path';
import {
  filesIn,
  safeId,
  parseObject,
  textParts,
  message,
  asText,
  timestamp,
  selectWorkers,
} from './recovery-io.js';

function normalize(saved, parts, cwd) {
  const row = message(saved.role === 'user' || saved.type === 'user' ? 'user' : 'assistant', [], {
    id: saved.id,
    timestamp: saved.time?.completed || saved.time?.created || saved.timestamp,
    cwd,
  });
  row.recoveryDispatches = [];
  row.recoveryLinks = [];
  row.recoveryReports = [];
  if (saved.error) row.apiError = asText(saved.error);
  if (saved.text) row.message.content.push(...textParts(saved.text));
  for (const part of parts) {
    if (part.type === 'text') row.message.content.push(...textParts(part.text));
    if (part.type !== 'tool') continue;
    const state = part.state || {},
      name = part.tool || part.name;
    const input = parseObject(state.input),
      metadata = state.metadata || state.structured || {};
    const callId = part.callID || part.id;
    const output = state.output ?? state.error ?? state.content ?? state.result;
    row.message.content.push({ type: 'tool_use', id: callId, name, input });
    if (output != null)
      row.message.content.push({
        type: 'tool_result',
        tool_use_id: callId,
        content: asText(output),
        is_error: state.status === 'error',
      });
    if (name === 'task') {
      const id =
        metadata.sessionId ||
        metadata.sessionID ||
        input.task_id ||
        asText(output).match(/(?:task_id:\s*|<task\s+id=")([\w.-]+)/)?.[1];
      row.recoveryDispatches.push({
        callId,
        name: input.subagent_type,
        description: input.description,
        prompt: input.prompt,
      });
      if (typeof id === 'string') {
        row.recoveryLinks.push({ callId, id });
        const explicit = asText(output).match(/<task\s+[^>]*state="([\w-]+)"/)?.[1];
        const status = explicit || (metadata.background ? 'running' : state.status);
        row.recoveryReports.push({
          id,
          status,
          detail: asText(output),
          timestamp: timestamp(part.time?.completed || state.time?.end),
        });
      }
    }
  }
  if (!row.message.content.length && row.apiError) row.message.content = textParts(row.apiError);
  return row;
}

export async function opencodeSource(session, warnings) {
  const index = new Map();
  let close = async () => {};
  if (session.originalPath.endsWith('.db')) {
    // Read one consistent snapshot, including WAL state, without migrating or modifying the source DB.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(session.originalPath, { readOnly: true });
    close = async () => {
      db.close();
    };
    try {
      db.exec('BEGIN');
      const tables = new Set(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((row) => row.name),
      );
      const columns = new Set(
        db
          .prepare('PRAGMA table_info(session)')
          .all()
          .map((row) => row.name),
      );
      const fields = ['id', 'parent_id', 'directory', 'title'].filter((key) => columns.has(key));
      for (const saved of db.prepare(`SELECT ${fields.join(',')} FROM session`).all()) {
        const descriptor = {
          id: saved.id,
          file: session.originalPath,
          consistentSnapshot: true,
          meta: { name: saved.title, cwd: saved.directory, parentAgentId: saved.parent_id },
          async read(visit) {
            let count = 0;
            // New OpenCode versions retain old tables during migration. Prefer populated v2 messages.
            const v2 = tables.has('session_message')
              ? db
                  .prepare(
                    'SELECT id,type,data,time_created FROM session_message WHERE session_id=? ORDER BY seq',
                  )
                  .all(saved.id)
              : [];
            if (v2.length) {
              for (const entry of v2) {
                let data;
                try {
                  data = JSON.parse(entry.data);
                } catch {
                  warnings.push({
                    file: session.originalPath,
                    agentId: saved.id,
                    issue: `Unreadable OpenCode message ${entry.id}.`,
                  });
                  continue;
                }
                if (!['user', 'assistant', 'synthetic'].includes(entry.type)) continue;
                await visit(
                  normalize(
                    {
                      ...data,
                      id: entry.id,
                      type: entry.type,
                      timestamp: timestamp(entry.time_created),
                    },
                    data.content || [],
                    saved.directory,
                  ),
                  ++count,
                );
              }
            } else if (tables.has('message')) {
              for (const entry of db
                .prepare(
                  'SELECT id,data,time_created FROM message WHERE session_id=? ORDER BY time_created,id',
                )
                .all(saved.id)) {
                let data;
                try {
                  data = JSON.parse(entry.data);
                } catch {
                  warnings.push({
                    file: session.originalPath,
                    agentId: saved.id,
                    issue: `Unreadable OpenCode message ${entry.id}.`,
                  });
                  continue;
                }
                const parts = [];
                if (tables.has('part'))
                  for (const item of db
                    .prepare('SELECT id,data FROM part WHERE message_id=? ORDER BY id')
                    .all(entry.id)) {
                    try {
                      parts.push({ ...JSON.parse(item.data), id: item.id });
                    } catch {
                      warnings.push({
                        file: session.originalPath,
                        agentId: saved.id,
                        issue: `Unreadable OpenCode part ${item.id}.`,
                      });
                    }
                  }
                await visit(
                  normalize(
                    { ...data, id: entry.id, timestamp: timestamp(entry.time_created) },
                    parts,
                    saved.directory,
                  ),
                  ++count,
                );
              }
            }
          },
        };
        index.set(saved.id, descriptor);
      }
    } catch (error) {
      await close();
      throw error;
    }
  } else {
    const storage = path.join(session.account.root, 'opencode', 'storage');
    const candidates = new Set([
      session.originalPath,
      ...(await filesIn(path.join(storage, 'session'), ['.json'])),
    ]);
    for (const file of candidates) {
      let saved;
      try {
        saved = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch (error) {
        if (file === session.originalPath)
          throw new Error('OpenCode recovery could not read the selected session metadata.', {
            cause: error,
          });
        warnings.push({ file, issue: 'Unreadable OpenCode session metadata.' });
        continue;
      }
      if (file === session.originalPath && saved?.id !== session.id)
        throw new Error('OpenCode recovery could not identify the selected session.');
      if (!safeId(saved?.id)) continue;
      if (index.has(saved.id)) {
        warnings.push({
          file,
          agentId: saved.id,
          issue: 'Duplicate OpenCode session ID; using the first discovered metadata.',
        });
        continue;
      }
      index.set(saved.id, {
        id: saved.id,
        file,
        meta: { name: saved.title, cwd: saved.directory, parentAgentId: saved.parentID },
        async read(visit) {
          let count = 0;
          for (const msgFile of await filesIn(
            path.join(storage, 'message', saved.id),
            ['.json'],
            false,
          )) {
            let data;
            try {
              data = JSON.parse(await fs.readFile(msgFile, 'utf8'));
            } catch {
              warnings.push({ file: msgFile, issue: 'Unreadable OpenCode message.' });
              continue;
            }
            if (!safeId(data.id)) continue;
            const parts = [];
            for (const partFile of await filesIn(
              path.join(storage, 'part', data.id),
              ['.json'],
              false,
            )) {
              try {
                parts.push(JSON.parse(await fs.readFile(partFile, 'utf8')));
              } catch {
                warnings.push({ file: partFile, issue: 'Unreadable OpenCode part.' });
              }
            }
            await visit(normalize(data, parts, saved.directory), ++count);
          }
        },
      });
    }
  }
  try {
    const parent = index.get(session.id);
    if (!parent) throw new Error('OpenCode recovery could not identify the selected session.');
    return { parent, workers: await selectWorkers(parent, index, warnings), close };
  } catch (error) {
    await close();
    throw error;
  }
}
