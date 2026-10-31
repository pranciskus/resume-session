import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { buildRecovery } from '../src/recovery.js';
import { plan, resolveTarget } from '../src/core.js';
import { captureCheckpoint, restoreCheckpoint, git } from '../src/checkpoint.js';

const rootId = '77777777-7777-4777-8777-777777777777';
const at = (second) => `2026-10-01T10:00:${String(second).padStart(2, '0')}.000Z`;
async function json(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value));
}
async function jsonl(file, rows) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}
async function base(t, tool) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-platform-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  await fs.mkdir(cwd);
  return {
    root,
    cwd,
    session: {
      id: rootId,
      source: tool,
      cwd,
      createdAt: at(0),
      updatedAt: at(6),
      account: { tool, root: path.join(root, 'account'), label: 'old-account' },
      key: `${tool}:fictional`,
    },
  };
}
async function bundle(f, name = 'bundle') {
  const result = await buildRecovery(f.session, path.join(f.root, name));
  assert.ok(result);
  const manifest = JSON.parse(await fs.readFile(result.manifest, 'utf8'));
  const nodes = Object.fromEntries(manifest.agents.map((node) => [node.id, node]));
  const snapshot = async (id) =>
    fs.readFile(path.join(result.directory, nodes[id].transcript), 'utf8');
  return { result, manifest, nodes, snapshot };
}

async function codex(t) {
  const f = await base(t, 'codex');
  const meta = (id, parent, extra = {}) => ({
    type: 'session_meta',
    payload: {
      id,
      cwd: f.cwd,
      source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent } } } : 'cli',
      ...extra,
    },
  });
  const call = (id, prompt, second = 1) => ({
    type: 'response_item',
    timestamp: at(second),
    payload: {
      type: 'function_call',
      name: 'spawn_agent',
      call_id: id,
      arguments: JSON.stringify({ message: prompt, agent_type: 'worker' }),
    },
  });
  const result = (id, child, second = 1) => ({
    type: 'response_item',
    timestamp: at(second),
    payload: {
      type: 'function_call_output',
      call_id: id,
      output: JSON.stringify({ agent_id: child }),
    },
  });
  const text = (role, value, second) => ({
    type: 'response_item',
    timestamp: at(second),
    payload: {
      type: 'message',
      role,
      content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: value }],
    },
  });
  const parent = [
    meta(rootId),
    text('user', 'INHERITED_ROOT_ONLY: finish and independently verify the feature.', 0),
    call('same-call', 'Build the feature using existing files.'),
    result('same-call', 'builder'),
    call('missing-call', 'Recover a missing dispatch.', 2),
  ];
  f.session.originalPath = path.join(
    f.session.account.root,
    'sessions',
    `rollout-2026-10-01T10-00-00-${rootId}.jsonl`,
  );
  await jsonl(f.session.originalPath, parent);
  await jsonl(path.join(f.session.account.root, 'archived_sessions', 'builder.jsonl'), [
    meta('builder', rootId, { creator_account_id: 'PRIVATE_ACCOUNT_SENTINEL' }),
    ...parent,
    text('user', 'Build the feature using existing files.', 2),
    call('same-call', 'Independently review the feature.', 3),
    result('same-call', 'reviewer', 3),
    {
      type: 'event_msg',
      timestamp: at(3),
      payload: {
        type: 'collab_agent_spawn_end',
        call_id: 'same-call',
        new_thread_id: 'reviewer',
        prompt: 'Independently review the feature.',
        status: 'running',
      },
    },
    {
      type: 'event_msg',
      timestamp: at(5),
      payload: {
        type: 'error',
        message: 'Usage limit reached',
        codex_error_info: 'UsageLimitExceeded',
      },
    },
  ]);
  await jsonl(path.join(f.session.account.root, 'sessions', 'reviewer.jsonl'), [
    meta('reviewer', 'builder'),
    text('user', 'Independently review the feature.', 3),
    text('assistant', 'Review passed. REVIEW_SENTINEL', 4),
    { type: 'event_msg', timestamp: at(4), payload: { type: 'task_complete' } },
  ]);
  await jsonl(path.join(f.session.account.root, 'sessions', 'unrelated.jsonl'), [
    meta('unrelated', null, { forked_from_id: rootId }),
    text('user', 'UNRELATED_PRIVATE_SENTINEL', 2),
  ]);
  return f;
}

test('Codex recovers archived nested workers, excludes inherited forks and unrelated chats, and retains missing dispatches', async (t) => {
  const f = await codex(t),
    b = await bundle(f);
  assert.equal(b.result.count, 3);
  assert.equal(b.nodes.builder.reportedStatus, 'blocked_quota');
  assert.equal(b.nodes.reviewer.reportedStatus, 'reported_finished');
  assert.equal(b.nodes.reviewer.parentId, 'builder');
  assert.equal(b.nodes.reviewer.assignments.length, 1); // Function call + collab event are the same dispatch.
  assert.equal(b.nodes.builder.assignments.length, 1);
  assert.equal(b.result.dispatchOnlyCount, 1);
  assert.equal(b.manifest.sourceSession.tool, 'codex');
  const saved = await b.snapshot('builder');
  assert.ok(!saved.includes('INHERITED_ROOT_ONLY'));
  assert.ok(!saved.includes('PRIVATE_ACCOUNT_SENTINEL'));
  assert.ok(!JSON.stringify(b.manifest).includes('UNRELATED_PRIVATE_SENTINEL'));
});

async function gemini(t, legacy = false) {
  const f = await base(t, 'gemini');
  const folder = path.join(f.session.account.root, '.gemini', 'tmp', 'project', 'chats');
  f.session.originalPath = path.join(folder, `session-${rootId}.${legacy ? 'json' : 'jsonl'}`);
  const metadata = (sessionId, kind = 'subagent') => ({
    sessionId,
    projectHash: 'project',
    startTime: at(0),
    lastUpdated: at(6),
    directories: [f.cwd],
    kind,
  });
  const user = (id, content) => ({ id, type: 'user', timestamp: at(0), content });
  const assistant = (id, content, toolCalls = [], second = 2) => ({
    id,
    type: 'gemini',
    timestamp: at(second),
    content,
    toolCalls,
  });
  const tool = (id, agentId, query, status = 'success', second = 4) => ({
    id,
    name: 'custom_reviewer',
    args: { query },
    agentId,
    status,
    timestamp: at(second),
    result: [{ functionResponse: { response: { result: 'Finished.' } } }],
  });
  const parent = [
    user('main-user', 'Finish the feature and independent review.'),
    assistant('main-tools', '', [tool('same-call', 'builder', 'Build the feature.', 'error', 6)]),
  ];
  parent[1].toolCalls[0].result = 'usage_limit_reached';
  const builder = [
    user('builder-user', 'Build the feature.'),
    assistant('nested', '', [tool('same-call', 'reviewer', 'Review independently.')]),
    assistant('withdrawn', '', [tool('withdrawn-call', 'ghost', 'SUPERSEDED_TASK')]),
    { $rewindTo: 'withdrawn' },
    { id: 'error', type: 'error', timestamp: at(5), content: 'Weekly limit reached' },
  ];
  const reviewer = [
    user('review-user', 'Review independently.'),
    assistant('review-result', 'OLD_RESULT_SENTINEL', [], 3),
    { $patch: { id: 'review-result', content: 'REVIEW_SENTINEL: checked the feature.' } },
  ];
  if (legacy) {
    await json(f.session.originalPath, { ...metadata(rootId, 'main'), messages: parent });
    await json(path.join(folder, rootId, 'builder.json'), {
      ...metadata('builder'),
      messages: builder.filter((row) => row.type && row.id !== 'withdrawn'),
    });
    await json(path.join(folder, rootId, 'reviewer.json'), {
      ...metadata('reviewer'),
      messages: reviewer
        .filter((row) => row.type)
        .map((row) => (row.id === 'review-result' ? { ...row, content: 'REVIEW_SENTINEL' } : row)),
    });
  } else {
    await jsonl(f.session.originalPath, [metadata(rootId, 'main'), ...parent]);
    await jsonl(path.join(folder, rootId, 'builder.jsonl'), [metadata('builder'), ...builder]);
    await jsonl(path.join(folder, rootId, 'reviewer.jsonl'), [metadata('reviewer'), ...reviewer]);
  }
  await jsonl(path.join(folder, 'session-unrelated.jsonl'), [
    metadata('unrelated', 'main'),
    user('other', 'UNRELATED_PRIVATE_SENTINEL'),
  ]);
  return f;
}

for (const legacy of [false, true])
  test(`Gemini ${legacy ? 'JSON' : 'JSONL journal'} recovers custom agents, nested relationships and quota failures`, async (t) => {
    const f = await gemini(t, legacy),
      b = await bundle(f);
    assert.equal(b.result.count, 2);
    assert.equal(b.nodes.builder.reportedStatus, 'blocked_quota');
    assert.equal(b.nodes.reviewer.parentId, 'builder');
    assert.equal(b.nodes.reviewer.reportedStatus, 'reported_finished');
    assert.match(await b.snapshot('reviewer'), /REVIEW_SENTINEL/);
    assert.ok(!(await b.snapshot('reviewer')).includes('OLD_RESULT_SENTINEL'));
    assert.ok(!JSON.stringify(b.manifest).includes('SUPERSEDED_TASK'));
    assert.ok(!JSON.stringify(b.manifest).includes('UNRELATED_PRIVATE_SENTINEL'));
  });

async function opencode(t, mode = 'sqlite') {
  const f = await base(t, 'opencode');
  const store = path.join(f.session.account.root, 'opencode', 'storage');
  const sessions = [
    { id: rootId, title: 'Feature coordinator' },
    { id: 'builder', parentID: rootId, title: 'Build feature' },
    { id: 'reviewer', parentID: 'builder', title: 'Review feature' },
    { id: 'unrelated', title: 'UNRELATED_PRIVATE_SENTINEL' },
  ];
  const tool = (id, child, prompt, status = 'completed', second = 4) => ({
    id,
    callID: 'same-call',
    type: 'tool',
    tool: 'task',
    state: {
      status,
      input: { prompt, subagent_type: 'general' },
      metadata: { sessionId: child },
      output: status === 'error' ? 'usage_limit_reached' : 'Finished',
      time: { end: Date.parse(at(second)) },
    },
  });
  const rows = [
    {
      id: 'msg_root_user',
      sessionID: rootId,
      role: 'user',
      parts: [{ id: 'prt_user', type: 'text', text: 'Finish the feature and independent review.' }],
      second: 0,
    },
    {
      id: 'msg_root_tool',
      sessionID: rootId,
      role: 'assistant',
      parts: [
        tool('prt_root_task', 'builder', 'Build the feature.', 'error', 6),
        {
          ...tool('prt_missing', 'missing', 'Recover missing worker.', 'running'),
          callID: 'missing-call',
        },
      ],
      second: 1,
    },
    {
      id: 'msg_builder_user',
      sessionID: 'builder',
      role: 'user',
      parts: [{ id: 'prt_builder_user', type: 'text', text: 'Build the feature.' }],
      second: 1,
    },
    {
      id: 'msg_builder_task',
      sessionID: 'builder',
      role: 'assistant',
      parts: [tool('prt_nested_task', 'reviewer', 'Review independently.')],
      second: 2,
    },
    {
      id: 'msg_reviewer',
      sessionID: 'reviewer',
      role: 'assistant',
      parts: [
        { id: 'prt_review', type: 'text', text: 'REVIEW_SENTINEL: checked the feature.' },
        { id: 'prt_reason', type: 'reasoning', text: 'HIDDEN_REASONING_SENTINEL' },
      ],
      second: 3,
    },
  ];
  if (mode === 'legacy') {
    for (const saved of sessions)
      await json(path.join(store, 'session', 'project', saved.id + '.json'), {
        ...saved,
        directory: f.cwd,
      });
    for (const row of rows) {
      await json(path.join(store, 'message', row.sessionID, row.id + '.json'), {
        ...row,
        time: { created: Date.parse(at(row.second)) },
      });
      for (const part of row.parts)
        await json(path.join(store, 'part', row.id, part.id + '.json'), part);
    }
    f.session.originalPath = path.join(store, 'session', 'project', rootId + '.json');
  } else {
    f.session.originalPath = path.join(f.session.account.root, 'opencode', 'opencode.db');
    await fs.mkdir(path.dirname(f.session.originalPath), { recursive: true });
    const db = new DatabaseSync(f.session.originalPath);
    db.exec(
      'CREATE TABLE session (id TEXT, parent_id TEXT, directory TEXT, title TEXT); CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part (id TEXT, message_id TEXT, data TEXT); CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);',
    );
    for (const saved of sessions)
      db.prepare('INSERT INTO session VALUES (?,?,?,?)').run(
        saved.id,
        saved.parentID || null,
        f.cwd,
        saved.title,
      );
    for (const [i, row] of rows.entries()) {
      if (mode === 'v2') {
        const content = row.parts.map((part) =>
          part.type === 'tool'
            ? {
                ...part,
                name: 'task',
                state: { ...part.state, structured: part.state.metadata },
                time: { completed: part.state.time.end },
              }
            : part,
        );
        db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?)').run(
          row.id,
          row.sessionID,
          row.role,
          i,
          Date.parse(at(row.second)),
          JSON.stringify(row.role === 'user' ? { text: row.parts[0].text } : { content }),
        );
      } else {
        db.prepare('INSERT INTO message VALUES (?,?,?,?)').run(
          row.id,
          row.sessionID,
          Date.parse(at(row.second)),
          JSON.stringify({ role: row.role }),
        );
        for (const part of row.parts)
          db.prepare('INSERT INTO part VALUES (?,?,?)').run(part.id, row.id, JSON.stringify(part));
      }
    }
    db.close();
  }
  return f;
}

async function claude(t) {
  const f = await base(t, 'claude');
  f.session.originalPath = path.join(
    f.session.account.root,
    'projects',
    'project',
    rootId + '.jsonl',
  );
  const row = (role, content) => ({
    type: role,
    sessionId: rootId,
    cwd: f.cwd,
    timestamp: at(0),
    message: { role, content },
  });
  const parent = [row('user', 'Build and review a feature.')];
  for (const id of ['builder', 'reviewer']) {
    parent.push(
      row('assistant', [
        { type: 'tool_use', id, name: 'Agent', input: { name: id, prompt: `${id} assignment` } },
      ]),
    );
    parent.push({
      ...row('user', [{ type: 'tool_result', tool_use_id: id, content: `agentId: ${id}` }]),
      toolUseResult: { agentId: id },
    });
    await jsonl(f.session.originalPath.replace(/\.jsonl$/, '') + `/subagents/agent-${id}.jsonl`, [
      row('user', `${id} assignment`),
      row('assistant', 'Partial work saved.'),
    ]);
  }
  await jsonl(f.session.originalPath, parent);
  return f;
}

for (const mode of ['sqlite', 'v2', 'legacy'])
  test(`OpenCode ${mode} preserves nested work without changing the source`, async (t) => {
    const f = await opencode(t, mode),
      before = await fs.readFile(f.session.originalPath),
      b = await bundle(f);
    assert.equal(b.result.count, 3);
    assert.equal(b.nodes.builder.reportedStatus, 'blocked_quota');
    assert.equal(b.nodes.reviewer.reportedStatus, 'reported_finished');
    assert.equal(b.nodes.reviewer.parentId, 'builder');
    assert.equal(b.nodes.missing.transcriptAvailable, false);
    assert.equal(b.nodes.missing.assignments[0].prompt, 'Recover missing worker.');
    assert.ok(!(await b.snapshot('reviewer')).includes('HIDDEN_REASONING_SENTINEL'));
    assert.ok(!JSON.stringify(b.manifest).includes('UNRELATED_PRIVATE_SENTINEL'));
    assert.deepEqual(await fs.readFile(f.session.originalPath), before);
  });

for (const [source, fixture] of [
  ['claude', claude],
  ['codex', codex],
  ['gemini', gemini],
  ['opencode', opencode],
])
  test(`${source} worker packets are included for every other destination`, async (t) => {
    const f = await fixture(t);
    for (const target of ['claude', 'codex', 'gemini', 'opencode'].filter(
      (tool) => tool !== source,
    )) {
      const prepared = await plan(f.session, resolveTarget(target, {}));
      assert.ok(prepared.recovery.transcriptCount >= 2);
      assert.match(await fs.readFile(prepared.file, 'utf8'), /Worker recovery plan/);
      assert.ok(prepared.args.some((arg) => arg.includes('worker recovery plan')));
    }
  });

for (const [source, fixture] of [
  ['claude', claude],
  ['codex', codex],
  ['gemini', gemini],
  ['opencode', opencode],
])
  test(`${source} portable job restores workers for all four agents`, async (t) => {
    const f = await fixture(t);
    await git(f.cwd, 'init');
    await git(f.cwd, 'config', 'user.name', 'Test');
    await git(f.cwd, 'config', 'user.email', 'test@example.com');
    await fs.writeFile(path.join(f.cwd, 'README.txt'), 'Shared project');
    await git(f.cwd, 'add', '.');
    await git(f.cwd, 'commit', '-m', 'base');
    const recipient = path.join(f.root, 'recipient');
    await git(f.root, 'clone', f.cwd, recipient);
    const checkpoint = await captureCheckpoint(f.session);
    assert.ok(checkpoint.recovery.count >= 2);
    for (const target of ['claude', 'codex', 'gemini', 'opencode']) {
      const prepared = await restoreCheckpoint(
        checkpoint,
        recipient,
        'rs_' + 'x'.repeat(24),
        resolveTarget(target, {}),
      );
      const manifest = JSON.parse(
        await fs.readFile(
          path.join(prepared.worktree, '.resume', 'agents', 'manifest.json'),
          'utf8',
        ),
      );
      assert.ok(manifest.agents.length >= 2);
      assert.ok(manifest.agents.some((agent) => agent.id === 'builder'));
      assert.ok(manifest.agents.some((agent) => agent.id === 'reviewer'));
      assert.ok(prepared.args.at(-1).includes(prepared.file));
    }
  });

test('Codex references recover a worker without lineage metadata and preserve follow-up assignments', async (t) => {
  const f = await codex(t);
  const file = path.join(f.session.account.root, 'archived_sessions', 'builder.jsonl');
  const rows = (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  rows[0].payload.source = 'cli';
  await jsonl(file, rows);
  await fs.appendFile(
    f.session.originalPath,
    JSON.stringify({
      type: 'response_item',
      timestamp: at(7),
      payload: {
        type: 'function_call',
        name: 'functions.send_input',
        call_id: 'followup',
        arguments: JSON.stringify({
          id: 'builder',
          message: 'Preserve the partial implementation.',
        }),
      },
    }) + '\n',
  );
  const b = await bundle(f);
  assert.equal(b.nodes.builder.parentId, null);
  assert.equal(b.nodes.builder.assignments.length, 2);
  assert.match(b.nodes.builder.assignments[1].prompt, /Preserve/);
});

test('Codex grandchildren remain recoverable when an intermediate worker transcript is missing', async (t) => {
  const f = await codex(t);
  await fs.rm(path.join(f.session.account.root, 'archived_sessions', 'builder.jsonl'));
  const b = await bundle(f);
  assert.equal(b.nodes.builder.transcriptAvailable, false);
  assert.equal(b.nodes.reviewer.transcriptAvailable, true);
  assert.equal(b.nodes.reviewer.parentId, 'builder');
  assert.match(b.nodes.reviewer.initialPrompt, /Independently review/);
});

test('Codex custom tool input survives normalization and is never executed', async (t) => {
  const f = await codex(t);
  const file = path.join(f.session.account.root, 'archived_sessions', 'builder.jsonl');
  await fs.appendFile(
    file,
    JSON.stringify({
      type: 'response_item',
      timestamp: at(6),
      payload: {
        type: 'custom_tool_call',
        call_id: 'patch',
        name: 'apply_patch',
        input:
          '*** Begin Patch\n*** Add File: never-created.txt\n+PATCH_CONTEXT_SENTINEL\n*** End Patch',
      },
    }) + '\n',
  );
  const b = await bundle(f);
  assert.match(await b.snapshot('builder'), /PATCH_CONTEXT_SENTINEL/);
  await assert.rejects(fs.stat(path.join(f.cwd, 'never-created.txt')), { code: 'ENOENT' });
});

test('Gemini checkpoints and patches restore the final journal state, not superseded tasks', async (t) => {
  const f = await gemini(t);
  await fs.appendFile(
    f.session.originalPath,
    JSON.stringify({
      $set: {
        messages: [
          {
            id: 'replacement',
            type: 'user',
            timestamp: at(8),
            content: 'Current coordinator goal.',
          },
        ],
      },
    }) + '\n',
  );
  const b = await bundle(f);
  assert.equal(b.nodes.builder.assignments.length, 0); // The original dispatch was rewound by the checkpoint.
  assert.match(
    await fs.readFile(path.join(b.result.directory, 'coordinator.jsonl'), 'utf8'),
    /Current coordinator goal/,
  );
  assert.ok(b.nodes.builder.initialPrompt); // Orphaned historical worker context is still available for review, never auto-replayed.
});

test('OpenCode background dispatch completion is not reported as worker completion', async (t) => {
  const f = await opencode(t);
  const db = new DatabaseSync(f.session.originalPath);
  const saved = JSON.parse(
    db.prepare('SELECT data FROM part WHERE id=?').get('prt_root_task').data,
  );
  saved.state = {
    ...saved.state,
    status: 'completed',
    output: 'Background worker started',
    metadata: { sessionId: 'builder', background: true },
  };
  db.prepare('UPDATE part SET data=? WHERE id=?').run(JSON.stringify(saved), 'prt_root_task');
  db.close();
  const b = await bundle(f);
  assert.equal(b.nodes.builder.reportedStatus, 'unknown');
});

test('OpenCode SQLite WAL changes are visible without writing the source database', async (t) => {
  const f = await opencode(t),
    writer = new DatabaseSync(f.session.originalPath);
  writer.exec('PRAGMA journal_mode=WAL');
  writer
    .prepare('UPDATE part SET data=? WHERE id=?')
    .run(JSON.stringify({ type: 'text', text: 'WAL_RECOVERY_SENTINEL' }), 'prt_review');
  const before = await fs.readFile(f.session.originalPath);
  try {
    const b = await bundle(f);
    assert.match(await b.snapshot('reviewer'), /WAL_RECOVERY_SENTINEL/);
    assert.deepEqual(await fs.readFile(f.session.originalPath), before);
  } finally {
    writer.close();
  }
});

test('new OpenCode messages remain available to the destination even when the upstream archive only knows old tables', async (t) => {
  const f = await opencode(t, 'v2');
  const prepared = await plan(f.session, resolveTarget('codex', {}));
  const parent = await fs.readFile(
    path.join(prepared.recovery.directory, 'coordinator.jsonl'),
    'utf8',
  );
  assert.match(parent, /Finish the feature and independent review/);
  assert.match(parent, /Build the feature/);
});

test('Gemini missing transcripts remain assignment-only records and malformed journals are flagged', async (t) => {
  const f = await gemini(t);
  const folder = path.join(path.dirname(f.session.originalPath), rootId);
  await fs.rm(path.join(folder, 'reviewer.jsonl'));
  await fs.appendFile(path.join(folder, 'builder.jsonl'), '{incomplete\n');
  const b = await bundle(f);
  assert.equal(b.nodes.reviewer.transcriptAvailable, false);
  assert.match(b.nodes.reviewer.assignments[0].prompt, /Review independently/);
  assert.equal(b.nodes.builder.transcriptComplete, false);
  assert.ok(b.manifest.warnings.some((item) => item.issue.includes('Unreadable JSON')));
});

test('duplicate Gemini session IDs cannot replace the selected coordinator history', async (t) => {
  const f = await gemini(t);
  await jsonl(path.join(path.dirname(f.session.originalPath), 'session-z-duplicate.jsonl'), [
    { sessionId: rootId, kind: 'subagent', directories: [f.cwd] },
    { id: 'wrong', type: 'user', content: 'WRONG_COORDINATOR_SENTINEL' },
  ]);
  const b = await bundle(f);
  const coordinator = await fs.readFile(path.join(b.result.directory, 'coordinator.jsonl'), 'utf8');
  assert.match(coordinator, /Finish the feature/);
  assert.ok(!coordinator.includes('WRONG_COORDINATOR_SENTINEL'));
  assert.ok(b.manifest.warnings.some((w) => /Duplicate Gemini/.test(w.issue)));
});

test('Codex recovery fails clearly when the selected thread metadata is missing', async (t) => {
  const f = await codex(t);
  await jsonl(f.session.originalPath, [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [] } },
  ]);
  await assert.rejects(
    buildRecovery(f.session, path.join(f.root, 'bundle')),
    /identify the selected session/,
  );
});

test('unrelated Gemini subagents cannot reparent a selected worker', async (t) => {
  const f = await gemini(t);
  await jsonl(path.join(path.dirname(f.session.originalPath), 'session-other-worker.jsonl'), [
    { sessionId: 'other-worker', kind: 'subagent', directories: [f.cwd] },
    {
      id: 'hijack',
      type: 'gemini',
      content: '',
      toolCalls: [
        {
          id: 'other-call',
          name: 'custom_reviewer',
          agentId: 'reviewer',
          args: { query: 'UNRELATED_ASSIGNMENT' },
        },
      ],
    },
  ]);
  const b = await bundle(f);
  assert.equal(b.nodes.reviewer.parentId, 'builder');
  assert.match(await b.snapshot('reviewer'), /REVIEW_SENTINEL/);
  assert.ok(!b.nodes['other-worker']);
});

test('OpenCode legacy recovery preserves explicitly selected metadata across duplicate IDs', async (t) => {
  const f = await opencode(t, 'legacy');
  await json(path.join(path.dirname(f.session.originalPath), 'z-duplicate.json'), {
    id: rootId,
    title: 'Wrong copy',
    directory: '/unrelated-project',
    parentID: 'unrelated',
  });
  const b = await bundle(f);
  assert.ok(b.manifest.warnings.some((w) => /Duplicate OpenCode/.test(w.issue)));
  assert.equal(b.nodes.builder.parentId, null);
  assert.match(await b.snapshot('reviewer'), /REVIEW_SENTINEL/);
  await fs.writeFile(f.session.originalPath, '{}');
  await assert.rejects(
    buildRecovery(f.session, path.join(f.root, 'invalid')),
    /identify the selected session/,
  );
});
