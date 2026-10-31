import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { records, filesIn as transcripts, asText } from './recovery-io.js';
import { codexSource } from './recovery-codex.js';
import { geminiSource } from './recovery-gemini.js';
import { opencodeSource } from './recovery-opencode.js';

const taskTools = new Set(['Agent', 'Task']);
const fileTools = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'Read',
  'NotebookEdit',
  'write_file',
  'read_file',
  'replace',
  'edit_file',
  'write',
  'edit',
  'read',
]);
const quota =
  /usage.?limit|rate.?limit|weekly limit|out of credits|out_of_credits|quota.?(?:exceeded|exhausted|limit)|resource.?exhausted|sessionbudgetexceeded/i;
const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((block) =>
            block?.type === 'text'
              ? block.text || ''
              : block?.type === 'tool_result'
                ? textOf(block.content)
                : '',
          )
          .filter(Boolean)
          .join('\n')
      : '';
const clean = (value) => String(value || '').replace(/[\x00-\x1f\x7f-\x9f|]/g, ' ');
const tag = (text, name) => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim();
const stamp = (value) => Date.parse(value || '') || 0;

function blocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (!block || typeof block !== 'object') return [];
    if (block.type === 'text') return [{ type: 'text', text: block.text || '' }];
    if (block.type === 'tool_use')
      return [{ type: 'tool_use', id: block.id, name: block.name, input: block.input }];
    if (block.type === 'tool_result')
      return [
        {
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          is_error: block.is_error,
          content: blocks(block.content),
        },
      ];
    if (['image', 'document'].includes(block.type)) return [{ type: block.type, omitted: true }];
    return []; // API request blobs, hidden reasoning, and binary payloads are not portable conversation state.
  });
}

/** Archive saved worker context without pretending to transfer a live runtime. */
export async function buildRecovery(session, destination) {
  const warnings = [];
  const loader = { codex: codexSource, gemini: geminiSource, opencode: opencodeSource }[
    session.source
  ];
  if (session.source !== 'claude' && !loader) return undefined;
  const source = loader ? await loader(session, warnings) : undefined;
  try {
    return await capture(session, destination, warnings, source);
  } finally {
    await source?.close?.();
  }
}

async function capture(session, destination, warnings, source) {
  const nodes = new Map(),
    dispatches = new Map(),
    links = new Map(),
    reports = [];
  let order = 0;
  const nodeFor = (id) => {
    if (!nodes.has(id))
      nodes.set(id, {
        id,
        assignments: [],
        parentId: null,
        observedFiles: [],
        observedTools: [],
        transcriptAvailable: false,
      });
    return nodes.get(id);
  };
  const report = (id, status, row, file, line, detail) =>
    reports.push({ id, status, timestamp: row.timestamp, file, line, detail, order: order++ });
  const statusFor = (status, detail) =>
    quota.test(String(detail || ''))
      ? 'blocked_quota'
      : ['completed', 'done', 'success'].includes(status)
        ? 'reported_finished'
        : [
              'failed',
              'error',
              'errored',
              'cancelled',
              'canceled',
              'stopped',
              'interrupted',
            ].includes(status)
          ? 'reported_failed'
          : undefined;

  const keyFor = (parentId, callId) => `${parentId || session.id}:${callId}`;
  function inspect(row, parentId, file, line) {
    for (const task of row.recoveryDispatches || []) {
      if (!task.callId) continue;
      const key = keyFor(parentId, task.callId),
        previous = dispatches.get(key);
      dispatches.set(key, {
        ...previous,
        ...task,
        prompt: task.prompt || previous?.prompt,
        name: task.name || previous?.name,
        parentId,
        timestamp: row.timestamp,
      });
    }
    for (const link of row.recoveryLinks || []) {
      if (typeof link.id === 'string' && link.id !== session.id && link.id !== parentId)
        links.set(keyFor(parentId, link.callId), link.id);
    }
    for (const evidence of row.recoveryReports || []) {
      const raw = evidence.status;
      const statusName =
        typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? Object.keys(raw)[0] : '';
      const detail = evidence.detail || asText(raw);
      const status = statusFor(statusName, detail) || 'unknown';
      if (evidence.id)
        report(
          evidence.id,
          status,
          { timestamp: evidence.timestamp || row.timestamp },
          file,
          line,
          detail,
        );
    }
    const content = row.message?.content;
    const list = Array.isArray(content) ? content : [];
    for (const block of list) {
      if (
        !row.recoveryNormalized &&
        block?.type === 'tool_use' &&
        taskTools.has(block.name) &&
        block.id
      ) {
        const key = keyFor(parentId, block.id);
        if (!dispatches.has(key))
          dispatches.set(key, {
            callId: block.id,
            parentId,
            timestamp: row.timestamp,
            name: block.input?.name,
            description: block.input?.description,
            prompt: block.input?.prompt,
          });
        if (typeof block.input?.resume === 'string') links.set(key, block.input.resume);
      }
      if (!row.recoveryNormalized && block?.type === 'tool_result' && block.tool_use_id) {
        const result =
          row.toolUseResult && typeof row.toolUseResult === 'object' ? row.toolUseResult : {};
        const id =
          result.agentId ||
          result.agent_id ||
          textOf(block.content).match(/\bagent(?:_id|Id):\s*([\w.-]+)/)?.[1];
        if (typeof id === 'string' && id) {
          links.set(keyFor(parentId, block.tool_use_id), id);
          const status = statusFor(result.status, result.status + ' ' + textOf(block.content));
          if (status)
            report(id, status, row, file, line, `Tool result: ${result.status || 'error'}`);
        }
      }
    }
    const text =
      row.type === 'queue-operation'
        ? typeof row.content === 'string'
          ? row.content
          : ''
        : textOf(content);
    for (const match of (row.recoveryNormalized ? '' : text).matchAll(
      /<task-notification>([\s\S]*?)<\/task-notification>/g,
    )) {
      const body = match[1],
        id = tag(body, 'task-id'),
        callId = tag(body, 'tool-use-id');
      if (id && callId) links.set(keyFor(parentId, callId), id);
      const status = statusFor(
        tag(body, 'status'),
        tag(body, 'summary') + ' ' + tag(body, 'result'),
      );
      if (id && status)
        report(id, status, row, file, line, `Task notification: ${tag(body, 'status')}`);
    }
  }

  const inspectParent = (row, line) => inspect(row, null, session.originalPath, line);
  if (source) await source.parent.read(inspectParent);
  else await records(session.originalPath, inspectParent, warnings);
  const files = source
    ? source.workers
    : await transcripts(session.originalPath.replace(/\.jsonl$/, '') + '/subagents');
  if (!files.length && !dispatches.size) return undefined;
  await fs.mkdir(destination, { mode: 0o700 }); // Unique destination supplied by the handoff; never overwrite another bundle.
  try {
    if (source) {
      const parentBefore = await fs.stat(source.parent.file);
      const parentSnapshot = await fs.open(
        path.join(destination, 'coordinator.jsonl'),
        'wx',
        0o600,
      );
      try {
        await source.parent.read(async (row) => {
          const content = blocks(row.message?.content);
          if (content.length)
            await parentSnapshot.writeFile(
              JSON.stringify({ type: row.type, timestamp: row.timestamp, content }) + '\n',
            );
        });
      } finally {
        await parentSnapshot.close();
      }
      const parentAfter = await fs.stat(source.parent.file).catch(() => undefined);
      if (
        !source.parent.consistentSnapshot &&
        (!parentAfter ||
          parentBefore.size !== parentAfter.size ||
          parentBefore.mtimeMs !== parentAfter.mtimeMs)
      ) {
        warnings.push({
          file: source.parent.file,
          issue:
            'Coordinator history changed during capture; review current history before continuing.',
        });
      }
    }
    for (const entry of files) {
      const file = typeof entry === 'string' ? entry : entry.file;
      const id =
        typeof entry === 'string' ? path.basename(file, '.jsonl').replace(/^agent-/, '') : entry.id;
      const node = nodeFor(id);
      node.recordKind = 'worker';
      node.originalTranscript = file;
      let meta = typeof entry === 'string' ? {} : entry.meta;
      if (typeof entry === 'string')
        try {
          meta = JSON.parse(await fs.readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
          if (!meta || typeof meta !== 'object' || Array.isArray(meta))
            throw new Error('Invalid worker metadata');
        } catch (error) {
          if (error.code !== 'ENOENT')
            warnings.push({ file, issue: 'Could not read worker metadata.' });
        }
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) meta = {};
      node.name = meta.name || meta.description || meta.agentType || id;
      node.description = meta.description;
      node.parentId = meta.parentAgentId === session.id ? null : meta.parentAgentId || null;
      node.parentRelationshipKnown = Boolean(meta.parentAgentId);
      node.cwd = meta.cwd || session.cwd;
      node.sourceModel = meta.model;
      node.processReportedFinished = meta.finished === true; // A process exit is not proof its assignment passed validation.
      if (meta.toolUseId) links.set(keyFor(node.parentId, meta.toolUseId), id);
      const hash = createHash('sha256').update(id).digest('hex').slice(0, 24);
      node.transcript = `agent-${hash}.jsonl`;
      node.packet = `agent-${hash}.md`;
      let before;
      try {
        before = await fs.stat(file);
      } catch (error) {
        node.transcript = undefined;
        warnings.push({
          file,
          issue: `Transcript unavailable before capture: ${error.code || error.message}`,
        });
        continue;
      }
      const output = await fs.open(path.join(destination, node.transcript), 'wx', 0o600);
      const seen = new Set(),
        paths = new Map(),
        tools = new Set(),
        digest = createHash('sha256');
      const warningsBefore = warnings.length;
      node.messageCount = 0;
      try {
        const visit = async (row, line) => {
          const identity = row.uuid
            ? row.uuid +
              ':' +
              createHash('sha256')
                .update(JSON.stringify([row.message, row.apiError]))
                .digest('hex')
            : undefined;
          if (identity && seen.has(identity)) return;
          if (identity) seen.add(identity);
          inspect(row, id, file, line);
          if (typeof row.cwd === 'string') node.cwd = row.cwd;
          const content = blocks(row.message?.content);
          if (!['user', 'assistant'].includes(row.type) || !content.length) return;
          const text = textOf(row.message?.content);
          const portable = {
            type: row.type,
            timestamp: row.timestamp,
            sourceId: row.uuid,
            parentSourceId: row.parentUuid,
            content,
            ...(row.apiError ? { apiError: row.apiError } : {}),
          };
          const encoded = JSON.stringify(portable) + '\n';
          await output.writeFile(encoded);
          digest.update(encoded);
          node.messageCount++;
          if (row.timestamp) node.lastActivity = row.timestamp;
          if (!node.initialPrompt && row.type === 'user' && text) node.initialPrompt = text;
          if (row.apiError)
            report(
              id,
              quota.test(row.apiError) ? 'blocked_quota' : 'reported_failed',
              row,
              file,
              line,
              row.apiError,
            );
          else if (row.type === 'assistant') {
            report(
              id,
              'unknown',
              row,
              file,
              line,
              'Saved assistant activity; no task-completion proof.',
            );
            if (text) node.lastAssistantMessage = text.slice(-6000);
          }
          for (const block of content) {
            if (block.type !== 'tool_use') continue;
            tools.add(block.name);
            if (fileTools.has(block.name)) {
              const reference =
                block.input?.file_path ||
                block.input?.filePath ||
                block.input?.path ||
                block.input?.notebook_path;
              if (typeof reference === 'string') {
                const resolved = path.isAbsolute(reference)
                  ? reference
                  : path.resolve(
                      node.cwd || session.cwd || path.dirname(session.originalPath),
                      reference,
                    );
                const entry = paths.get(resolved) || { path: resolved, actions: [] };
                if (!entry.actions.includes(block.name)) entry.actions.push(block.name);
                paths.set(resolved, entry);
              }
            }
          }
        };
        if (typeof entry === 'string') await records(file, visit, warnings);
        else await entry.read(visit);
        node.transcriptAvailable = node.messageCount > 0;
        node.transcriptComplete = warnings.length === warningsBefore;
      } catch (error) {
        warnings.push({
          file,
          issue: `Transcript snapshot incomplete: ${error.code || error.message}`,
        });
      } finally {
        await output.close();
      }
      node.transcriptSha256 = digest.digest('hex');
      node.observedTools = [...tools].sort();
      for (const reference of paths.values()) {
        try {
          const stat = await fs.stat(reference.path);
          reference.exists = true;
          reference.bytes = stat.size;
        } catch {
          reference.exists = false;
        }
      }
      node.observedFiles = [...paths.values()];
      const after = await fs.stat(file).catch(() => undefined);
      node.sourceChangedDuringCapture =
        !entry.consistentSnapshot &&
        (!after || before.size !== after.size || before.mtimeMs !== after.mtimeMs);
      if (node.sourceChangedDuringCapture) {
        node.transcriptComplete = false;
        warnings.push({
          file,
          issue: 'Source changed during capture; do not treat this as a final worker state.',
        });
      }
    }

    for (const [callId, task] of dispatches) {
      const id = links.get(callId) || `dispatch-${callId}`;
      const node = nodeFor(id);
      node.recordKind ||= links.has(callId) ? 'worker_reference' : 'dispatch_only';
      node.name = task.name || node.name || task.description || id;
      node.description ||= task.description;
      if (!task.followup && !node.parentRelationshipKnown) node.parentId ||= task.parentId;
      node.assignments.push({
        callId: task.callId,
        timestamp: task.timestamp,
        prompt: task.prompt || '',
        description: task.description,
      });
      if (!node.packet)
        node.packet = `agent-${createHash('sha256').update(id).digest('hex').slice(0, 24)}.md`;
    }
    for (const node of nodes.values()) {
      node.children = [...nodes.values()]
        .filter((child) => child.parentId === node.id)
        .map((child) => child.id);
      node.statusEvidence = reports
        .filter((item) => item.id === node.id)
        .sort((a, b) => stamp(a.timestamp) - stamp(b.timestamp) || a.order - b.order);
      const latest = node.statusEvidence.at(-1);
      node.reportedStatus = latest?.status || 'unknown';
      node.liveState = 'not_checked';
      node.recoveryAction =
        node.reportedStatus === 'reported_finished'
          ? 'verify_outputs_before_reusing'
          : 'inspect_files_and_children_before_resuming';
      if (!node.transcriptAvailable)
        warnings.push({
          agentId: node.id,
          issue:
            'No complete transcript snapshot is available. Assignment and any saved fragments must be reviewed.',
        });
      const assignments = node.assignments.length
        ? node.assignments.map((task) => task.prompt || task.description || '').join('\n\n---\n\n')
        : node.initialPrompt ||
          'Assignment not recovered. Inspect coordinator history before proceeding.';
      const packet = `# Worker recovery: ${clean(node.name || node.id)}\n\nHistorical status: ${node.reportedStatus}. Live execution has not been checked.\nParent worker: ${node.parentId || 'coordinator'}\nChild workers: ${node.children.join(', ') || 'none recorded'}\nSaved transcript: ${node.transcript || 'unavailable'}\nOriginal transcript: ${node.originalTranscript || 'unavailable'}\n\n## Recovery procedure\n\n1. Confirm this assignment is still relevant to the current user goal.\n2. Read its saved transcript and check its output files and child-worker results before repeating work. A finished process or completion report does not prove the outputs pass validation.\n3. Do not start duplicate writers while an original worker or another replacement is still active. Reconcile parent and child scopes before delegating.\n4. Resume only the unfinished steps using the target agent's own tools and permissions. Source runtime IDs, model settings, approvals and credentials are not transferable. Report missing integrations instead of inventing results.\n5. Return completed deliverables, validation evidence, and remaining work to the coordinator.\n\n## Original assignment(s) — historical context\n\n${assignments}\n\n## Last saved assistant message\n\n${node.lastAssistantMessage || 'No assistant text recovered.'}\n\n## Observed file references\n\n${node.observedFiles.map((f) => `- ${f.path} (${f.actions.join(', ')}; ${f.exists ? 'exists' : 'missing or unreadable'})`).join('\n') || 'No explicit file-tool paths recovered. Shell commands and assignments may reference additional outputs; inspect the transcript.'}\n\n## Source tools observed\n\n${node.observedTools.join(', ') || 'Unknown'}\n`;
      await fs.writeFile(path.join(destination, node.packet), packet, { flag: 'wx', mode: 0o600 });
    }
    warnings = [...new Map(warnings.map((item) => [JSON.stringify(item), item])).values()];
    const agents = [...nodes.values()];
    const counts = {};
    for (const agent of agents)
      counts[agent.reportedStatus] = (counts[agent.reportedStatus] || 0) + 1;
    const transcriptCount = agents.filter((agent) => agent.transcriptAvailable).length;
    const dispatchOnlyCount = agents.filter((agent) => agent.recordKind === 'dispatch_only').length;
    const manifest = {
      schema: 'resume-agent-recovery/v1',
      capturedAt: new Date().toISOString(),
      sourceSession: {
        tool: session.source,
        id: session.id,
        cwd: session.cwd,
        originalPath: session.originalPath,
      },
      liveState: 'not_checked',
      ...(source ? { coordinatorTranscript: 'coordinator.jsonl' } : {}),
      counts,
      transcriptCount,
      dispatchOnlyCount,
      warnings,
      agents,
    };
    const rows = agents
      .map(
        (agent) =>
          `| ${clean(agent.name || agent.id).slice(0, 90)} | ${agent.reportedStatus} | ${agent.children.length} | [assignment + recovery context](${agent.packet}) |`,
      )
      .join('\n');
    const index = `# Recover the previous agent team\n\n${agents.length} worker/dispatch records were found in the saved ${session.source} history: ${transcriptCount} transcript snapshots and ${dispatchOnlyCount} dispatches with no confirmed worker identity. These are historical records, not live processes. Full metadata, status evidence and file references are in manifest.json.${source ? ' Read coordinator.jsonl for the current recorded parent conversation. It applies source journal edits and rewinds and can contain newer messages than the main parser archive; prefer it when they conflict.' : ''}\n\n## Coordinator procedure\n\n- Reconcile this inventory against the latest user goal. Earlier tasks in the same chat may no longer be relevant; do not restart every worker.\n- Check whether original work or automatic continuation is still active before making changes. This snapshot does not prove processes have stopped.\n- Verify completed artifacts and reuse them. Quota-blocked and failed workers may have produced valid partial results. Unknown means inspect, not running or finished.\n- Read the per-worker packet and JSONL transcript. Restore only unfinished work. If the target supports subagents, delegate with these packets as context; otherwise continue sequentially.\n- Review parent/child relationships before scheduling. Avoid assigning a parent and its child the same write scope. Recreate fresh-context reviewers separately when the original assignment requires independence.\n- Use the target's available tools and permissions. Credentials, MCP connections, approvals and running processes do not transfer. Surface missing integrations.\n- Report what was reused, resumed, validated and left blocked; never treat a process exit or an old success message as current validation.\n\n## Inventory\n\n| Worker | Last reported state | Children | Recovery packet |\n| --- | --- | --- | --- |\n${rows}\n\n## Capture warnings\n\n${warnings.length ? `${warnings.length} warnings are recorded in manifest.json. Review them before relying on the snapshot.` : 'No capture warnings.'}\n`;
    await fs.writeFile(
      path.join(destination, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    await fs.writeFile(path.join(destination, 'RECOVER.md'), index, { flag: 'wx', mode: 0o600 });
    return {
      directory: destination,
      manifest: path.join(destination, 'manifest.json'),
      instructions: path.join(destination, 'RECOVER.md'),
      count: agents.length,
      transcriptCount,
      dispatchOnlyCount,
      counts,
      warningCount: warnings.length,
    };
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true });
    throw error;
  }
}
