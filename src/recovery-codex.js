import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  records,
  filesIn,
  parseObject,
  textParts,
  message,
  asText,
  selectWorkers,
} from './recovery-io.js';

const toolName = (name) => String(name || '').replace(/^functions\./, '');
const digest = (row) => createHash('sha256').update(JSON.stringify(row)).digest('hex');

function normalize(raw, meta, calls) {
  const p = raw.payload || {},
    name = toolName(p.name);
  const row = message('assistant', [], { timestamp: raw.timestamp, cwd: meta.cwd, id: p.id });
  row.recoveryDispatches = [];
  row.recoveryLinks = [];
  row.recoveryReports = [];
  if (raw.type === 'response_item') {
    if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) {
      row.type = p.role;
      row.message.content = textParts(p.content);
    } else if (['function_call', 'custom_tool_call'].includes(p.type)) {
      const rawInput = p.arguments ?? p.input,
        parsed = parseObject(rawInput);
      const input =
        typeof rawInput === 'string' && !Object.keys(parsed).length && rawInput.trim() !== '{}'
          ? { raw: rawInput }
          : parsed;
      const callId = p.call_id;
      calls.set(callId, { name, input });
      row.message.content = [{ type: 'tool_use', id: callId, name, input }];
      if (name === 'spawn_agent')
        row.recoveryDispatches.push({
          callId,
          name: input.agent_type,
          prompt: input.message || input.prompt,
        });
      if (name === 'send_input' && typeof input.id === 'string' && input.message) {
        row.recoveryDispatches.push({ callId, prompt: input.message, followup: true });
        row.recoveryLinks.push({ callId, id: input.id });
      }
    } else if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
      row.type = 'user';
      row.message.content = [
        { type: 'tool_result', tool_use_id: p.call_id, content: asText(p.output) },
      ];
      const call = calls.get(p.call_id),
        result = parseObject(p.output);
      if (call?.name === 'spawn_agent' && typeof result.agent_id === 'string')
        row.recoveryLinks.push({ callId: p.call_id, id: result.agent_id });
      if (['wait', 'wait_agent'].includes(call?.name)) {
        for (const [id, status] of Object.entries(result.status || {}))
          row.recoveryReports.push({ id, status });
      }
    }
  } else if (raw.type === 'event_msg') {
    if (['collab_agent_spawn_begin', 'collab_agent_spawn_end'].includes(p.type)) {
      row.recoveryDispatches.push({
        callId: p.call_id,
        name: p.new_agent_nickname || p.new_agent_role,
        prompt: p.prompt,
      });
      if (p.new_thread_id) {
        row.recoveryLinks.push({ callId: p.call_id, id: p.new_thread_id });
        row.recoveryReports.push({ id: p.new_thread_id, status: p.status });
      }
    } else if (p.type === 'collab_waiting_end') {
      for (const [id, status] of Object.entries(p.statuses || {}))
        row.recoveryReports.push({ id, status });
      for (const item of p.agent_statuses || [])
        row.recoveryReports.push({ id: item.thread_id, status: item.status });
    } else if (p.type === 'error') {
      row.message.content = textParts(p.message || 'Saved Codex error');
      row.apiError = asText(p.codex_error_info || p.message);
    } else if (p.type === 'task_complete') {
      // A completed turn is evidence, not validation of the entire worker assignment.
      row.recoveryReports.push({ id: meta.id, status: 'completed' });
    }
  }
  return row;
}

export async function codexSource(session, warnings) {
  const index = new Map();
  const paths = new Set([
    session.originalPath,
    ...(await filesIn(path.join(session.account.root, 'sessions'))),
    ...(await filesIn(path.join(session.account.root, 'archived_sessions'))),
  ]);
  for (const file of paths) {
    let metadata;
    try {
      await records(
        file,
        (raw) => {
          if (raw.type === 'session_meta') {
            metadata = raw.payload;
            return false;
          }
        },
        [],
      );
    } catch (error) {
      if (file === session.originalPath) throw error;
      warnings.push({ file, issue: 'Could not inspect Codex thread metadata.' });
      continue;
    }
    if (file === session.originalPath && metadata?.id !== session.id)
      throw new Error('Codex recovery could not identify the selected session.');
    if (!metadata?.id) continue;
    const lineage = metadata.source?.subagent?.thread_spawn || {};
    const parent =
      metadata.parent_thread_id ||
      lineage.parent_thread_id ||
      (metadata.source?.subagent || metadata.attached_thread ? metadata.forked_from_id : undefined);
    const descriptor = {
      id: metadata.id,
      file,
      hashes: new Set(),
      meta: {
        parentAgentId: parent,
        name: metadata.agent_nickname || lineage.agent_nickname || metadata.agent_role,
        cwd: metadata.cwd,
      },
      async read(visit) {
        const calls = new Map(),
          ancestors = [],
          visited = new Set([this.id]);
        let ancestor = index.get(this.meta.parentAgentId);
        while (ancestor && !visited.has(ancestor.id)) {
          ancestors.push(ancestor);
          visited.add(ancestor.id);
          ancestor = index.get(ancestor.meta.parentAgentId);
        }
        await records(
          file,
          async (raw, line) => {
            const hash = digest(raw);
            this.hashes.add(hash);
            if (ancestors.some((item) => item.hashes.has(hash))) return; // Full-history forks must not replay inherited dispatches.
            await visit(normalize(raw, metadata, calls), line);
          },
          warnings,
        );
      },
    };
    if (index.has(descriptor.id))
      warnings.push({
        file,
        agentId: descriptor.id,
        issue: 'Duplicate Codex thread ID; using the first discovered rollout.',
      });
    else index.set(descriptor.id, descriptor);
  }
  const parent = index.get(session.id);
  if (!parent) throw new Error('Codex recovery could not identify the selected session.');
  const workers = await selectWorkers(parent, index, warnings);
  return { parent, workers };
}
