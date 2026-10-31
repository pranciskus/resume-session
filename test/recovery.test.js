import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildRecovery } from '../src/recovery.js';

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  await fs.mkdir(cwd);
  const id = '33333333-3333-4333-8333-333333333333';
  const account = { tool: 'claude', root: path.join(root, 'account'), label: 'previous' };
  const originalPath = path.join(account.root, 'projects', 'project', `${id}.jsonl`);
  const children = originalPath.replace(/\.jsonl$/, '') + '/subagents';
  await fs.mkdir(children, { recursive: true });
  let seq = 0;
  const row = (role, content, second = 0, extra = {}) => ({
    type: role,
    uuid: `r-${seq++}`,
    sessionId: id,
    cwd,
    timestamp: `2026-10-30T12:00:0${second}.000Z`,
    message: { role, content },
    ...extra,
  });
  const call = (id, name, prompt) => ({
    type: 'tool_use',
    id,
    name: 'Agent',
    input: { name, description: name, prompt },
  });
  const result = (callId, agentId) =>
    row('user', [{ type: 'tool_result', tool_use_id: callId, content: 'Spawned.' }], 0, {
      toolUseResult: { status: 'teammate_spawned', agentId },
    });
  const dispatch = row('assistant', [
    call('build-call', 'builder', 'Build the model; preserve existing valid outputs.'),
  ]);
  const parent = [
    row(
      'user',
      'Build and independently validate the model. Recover unfinished work without discarding the existing files.',
    ),
    dispatch,
    dispatch,
    result('build-call', 'build'),
    row('assistant', [
      call(
        'lost-call',
        'missing-worker',
        'Recover this assignment even when its transcript is missing.',
      ),
    ]),
    result('lost-call', 'lost'),
  ];
  const writeJsonl = async (file, rows) =>
    fs.writeFile(file, rows.map((item) => JSON.stringify(item)).join('\n') + '\n');
  await writeJsonl(originalPath, parent);
  const written = path.join(cwd, 'model.json');
  await fs.writeFile(written, 'already valid; do not overwrite');
  const builder = [
    row('user', 'Build the model.'),
    row(
      'assistant',
      [
        {
          type: 'tool_use',
          id: 'write-model',
          name: 'Write',
          input: {
            file_path: 'model.json',
            content: 'Historical file content; must not be written by resume.',
          },
        },
        call(
          'judge-call',
          'fresh-reviewer',
          'Independently validate the existing model; do not build it.',
        ),
      ],
      1,
    ),
    result('judge-call', 'judge'),
    row(
      'user',
      '<task-notification><task-id>judge</task-id><tool-use-id>judge-call</tool-use-id><status>completed</status><summary>Reviewer finished</summary></task-notification>',
      3,
    ),
    row('assistant', 'Partial model saved; waiting on review.', 3),
    { type: 'api-request-blob', content: 'PRIVATE_API_REQUEST_SENTINEL' },
    row('assistant', 'Usage limit reached', 4, { apiError: 'usage_limit_reached' }),
  ];
  await writeJsonl(path.join(children, 'agent-build.jsonl'), builder);
  await fs.appendFile(path.join(children, 'agent-build.jsonl'), '{truncated write\n');
  await fs.writeFile(
    path.join(children, 'agent-build.meta.json'),
    JSON.stringify({ name: 'builder', finished: true, permissionMode: 'bypassPermissions' }),
  );
  await writeJsonl(path.join(children, 'agent-judge.jsonl'), [
    row('user', 'Independent review assignment.'),
    row('assistant', 'Model checks passed: REVIEW_RESULT_SENTINEL.', 2),
  ]);
  await fs.writeFile(
    path.join(children, 'agent-judge.meta.json'),
    JSON.stringify({
      description: 'fresh-reviewer',
      parentAgentId: 'build',
      toolUseId: 'judge-call',
      finished: true,
    }),
  );
  return {
    root,
    children,
    cwd,
    written,
    session: { id, source: 'claude', cwd, originalPath, account },
  };
}

test('recover a nested team with quota failure, completion evidence, and a missing transcript', async (t) => {
  const fixture = await setup(t);
  const destination = path.join(fixture.root, 'recovered');
  const result = await buildRecovery(fixture.session, destination);
  assert.equal(result.count, 3);
  const manifest = JSON.parse(await fs.readFile(result.manifest, 'utf8'));
  const byId = Object.fromEntries(manifest.agents.map((agent) => [agent.id, agent]));
  assert.equal(byId.build.assignments.length, 1); // Repeated coordinator records do not become repeated workers.
  assert.equal(byId.build.reportedStatus, 'blocked_quota'); // finished:true must not override a real error.
  assert.equal(byId.build.liveState, 'not_checked');
  assert.equal(byId.build.transcriptComplete, false);
  assert.deepEqual(byId.build.children, ['judge']);
  assert.equal(byId.judge.parentId, 'build');
  assert.equal(byId.judge.reportedStatus, 'reported_finished');
  assert.equal(byId.judge.recoveryAction, 'verify_outputs_before_reusing');
  assert.equal(byId.lost.transcriptAvailable, false);
  assert.match(byId.lost.assignments[0].prompt, /transcript is missing/);
  assert.ok(manifest.warnings.some((warning) => warning.issue.includes('Unreadable JSON')));
  assert.equal(byId.build.observedFiles[0].exists, true);
  assert.equal(byId.build.observedFiles[0].path, fixture.written);
  const snapshot = await fs.readFile(path.join(destination, byId.build.transcript), 'utf8');
  assert.match(snapshot, /usage_limit_reached/);
  assert.match(snapshot, /Historical file content/);
  assert.ok(!snapshot.includes('PRIVATE_API_REQUEST_SENTINEL'));
  assert.equal(await fs.readFile(fixture.written, 'utf8'), 'already valid; do not overwrite');
  const judgePacket = await fs.readFile(path.join(destination, byId.judge.packet), 'utf8');
  assert.match(judgePacket, /Independently validate/);
  assert.match(judgePacket, /REVIEW_RESULT_SENTINEL/);
  assert.ok(!JSON.stringify(manifest).includes('bypassPermissions'));
  assert.match(await fs.readFile(result.instructions, 'utf8'), /do not restart every worker/);
});

test('activity after a completion report is not treated as still completed', async (t) => {
  const fixture = await setup(t);
  const file = path.join(fixture.children, 'agent-judge.jsonl');
  await fs.appendFile(
    file,
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-10-30T12:00:09.000Z',
      message: { content: 'Working on a follow-up; not finished yet.' },
    }) + '\n',
  );
  const recovery = await buildRecovery(fixture.session, path.join(fixture.root, 'recovered'));
  const manifest = JSON.parse(await fs.readFile(recovery.manifest, 'utf8'));
  assert.equal(manifest.agents.find((agent) => agent.id === 'judge').reportedStatus, 'unknown');
});

test('prepare writes recovery artifacts without launching an agent', async (t) => {
  const fixture = await setup(t);
  const home = path.join(fixture.root, 'home');
  await fs.mkdir(home);
  const command = path.join(fixture.root, 'must-not-run.cjs');
  await fs.writeFile(
    command,
    'require("fs").writeFileSync("unexpected-launch", "bad"); process.exitCode=99;',
  );
  const configFile = path.join(home, 'config.json');
  await fs.writeFile(
    configFile,
    JSON.stringify({
      sources: [fixture.session.account],
      targets: {
        codex: { tool: 'codex', command: process.execPath, args: [command], shell: false },
      },
    }),
  );
  const env = { ...process.env, HOME: home, USERPROFILE: home, RESUME_CONFIG: configFile };
  for (const key of [
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'GEMINI_CLI_HOME',
    'XDG_DATA_HOME',
    'OPENCODE_DB',
  ])
    delete env[key];
  const cli = fileURLToPath(new URL('../bin/resume.js', import.meta.url));
  const run = async (flags) =>
    JSON.parse(
      (
        await promisify(execFile)(
          process.execPath,
          [cli, 'codex', '--session', fixture.session.id, ...flags],
          { env, cwd: fixture.cwd },
        )
      ).stdout,
    );
  await run(['--dry-run']);
  await assert.rejects(fs.stat(path.join(fixture.cwd, '.resume')), { code: 'ENOENT' });
  const prepared = await run(['--prepare', '--json']);
  assert.equal(prepared.recovery.count, 3);
  assert.match(await fs.readFile(prepared.file, 'utf8'), /Worker recovery plan:/);
  await assert.rejects(fs.stat(path.join(fixture.cwd, 'unexpected-launch')), { code: 'ENOENT' });
});

test('ordinary sessions do not get an empty recovery directory', async (t) => {
  const fixture = await setup(t);
  const target = path.join(fixture.root, 'not-created');
  const originalPath = path.join(fixture.root, 'ordinary-codex.jsonl');
  await fs.writeFile(
    originalPath,
    [
      {
        type: 'session_meta',
        payload: { id: fixture.session.id, cwd: fixture.cwd, source: 'cli' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Plan the workshop.' }],
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  );
  const session = {
    ...fixture.session,
    source: 'codex',
    originalPath,
    account: { ...fixture.session.account, tool: 'codex' },
  };
  assert.equal(await buildRecovery(session, target), undefined);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});
