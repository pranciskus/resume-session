import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  worker,
  plan,
  resolveTarget,
  agentArgs,
  launch,
  inFolder,
  filterSessions,
  sources,
  validateTarget,
} from '../src/core.js';
import { aliasCommand, detectAliasTool } from '../src/aliases.js';
import { splitArgs } from '../src/args.js';

test('agent flags pass through in order without requiring a separator', () => {
  assert.deepEqual(
    splitArgs([
      'any-alias',
      '--model',
      'sonnet',
      '--search',
      'login',
      '--add-dir',
      'path with spaces',
      '--verbose',
    ]),
    {
      args: ['any-alias', '--search', 'login'],
      extra: ['--model', 'sonnet', '--add-dir', 'path with spaces', '--verbose'],
    },
  );
  assert.deepEqual(
    splitArgs(['any-alias', '--session', 'source-id', '--', '--help', '--session', 'target-id']),
    {
      args: ['any-alias', '--session', 'source-id'],
      extra: ['--help', '--session', 'target-id'],
    },
  );
  assert.deepEqual(splitArgs(['source', 'add', 'work', '--tool', 'claude', '--root', '/profile']), {
    args: ['source', 'add', 'work', '--tool', 'claude', '--root', '/profile'],
    extra: [],
  });
});

test('infer aliases from commands, not names or words inside flags', () => {
  assert.equal(aliasCommand('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 claude --chrome'), 'claude');
  assert.equal(aliasCommand('env -u OLD_KEY PROFILE=work command claude --model sonnet'), 'claude');
  assert.equal(
    aliasCommand('"/path with spaces/codex" --model example'),
    '/path with spaces/codex',
  );
  assert.equal(aliasCommand('echo claude'), 'echo');
  assert.equal(aliasCommand('echo setup && claude'), undefined);
  assert.equal(aliasCommand('$SELECTED_AGENT --model example'), undefined);
});

test('folder filtering includes descendants, excludes siblings, and combines with text', () => {
  for (const api of [path.posix, path.win32]) {
    const root = api === path.win32 ? 'C:\\work\\repo' : '/work/repo';
    assert.equal(inFolder(root, root, api), true);
    assert.equal(inFolder(api.join(root, 'packages', 'one'), root, api), true);
    assert.equal(inFolder(root + '-other', root, api), false);
    assert.equal(inFolder(api.dirname(root), root, api), false);
    assert.equal(inFolder('', root, api), false);
  }
  assert.equal(inFolder('c:\\WORK\\Repo\\src', 'C:\\work\\repo', path.win32), true);
  assert.equal(inFolder('D:\\work\\repo', 'C:\\work\\repo', path.win32), false);
  const sessions = [
    { cwd: path.resolve('project one'), summary: 'fix login', account: {} },
    { cwd: path.resolve('project one', 'src'), summary: 'fix cache', account: {} },
    { cwd: path.resolve('project one-other'), summary: 'fix login', account: {} },
  ];
  assert.deepEqual(filterSessions(sessions, { folder: 'project one' }), sessions.slice(0, 2));
  assert.deepEqual(filterSessions(sessions, { folder: 'project one', search: 'LOGIN' }), [
    sessions[0],
  ]);
});

async function fixture(t, tool, id = '11111111-1111-4111-8111-111111111111', options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = options.cwd || path.join(root, 'project with spaces');
  await fs.mkdir(cwd, { recursive: true });
  const timestamp = '2026-10-30T10:00:00.000Z';
  let relative, rows;
  if (tool === 'claude') {
    relative = `projects/project/${id}.jsonl`;
    rows = ['user', 'assistant'].map((role, index) => ({
      type: role,
      uuid: `m${index}`,
      parentUuid: index ? 'm0' : null,
      sessionId: id,
      cwd,
      timestamp,
      message: {
        role,
        content: [
          {
            type: 'text',
            text: index
              ? 'Investigated the issue. Next step: patch authentication and run tests. '.repeat(3)
              : 'Fix the login bug without changing public API.',
          },
        ],
      },
    }));
  } else if (tool === 'codex') {
    relative = `sessions/2026/10/30/rollout-2026-10-30T10-00-00-${id}.jsonl`;
    rows = [
      { type: 'session_meta', timestamp, payload: { id, cwd } },
      ...['user', 'assistant'].map((role) => ({
        type: 'response_item',
        timestamp,
        payload: {
          type: 'message',
          role,
          content: [
            {
              type: role === 'user' ? 'input_text' : 'output_text',
              text:
                role === 'user'
                  ? 'Fix the login bug without changing public API.'
                  : 'Investigated the issue. Next step: patch authentication and run tests.',
            },
          ],
        },
      })),
    ];
  } else if (tool === 'gemini') {
    relative = `.gemini/tmp/project/chats/session-${id}.jsonl`;
    rows = [
      { sessionId: id, projectHash: 'project', startTime: timestamp, lastUpdated: timestamp },
      {
        id: 'm1',
        timestamp,
        type: 'user',
        content: 'Fix the login bug without changing public API.',
      },
      {
        id: 'm2',
        timestamp,
        type: 'gemini',
        content: 'Next step: patch authentication and run tests.',
      },
    ];
    await fs.mkdir(path.join(root, '.gemini'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.gemini/projects.json'),
      JSON.stringify({ projects: { [cwd]: 'project' } }),
    );
  } else {
    relative = 'opencode/opencode.db';
    await fs.mkdir(path.join(root, 'opencode'));
    const db = new DatabaseSync(path.join(root, relative));
    db.exec(`CREATE TABLE project (id TEXT, worktree TEXT);
      CREATE TABLE session (id TEXT, project_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT, summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE todo (session_id TEXT, content TEXT, status TEXT, priority TEXT, position INTEGER);`);
    db.prepare('INSERT INTO project VALUES (?, ?)').run('p1', cwd);
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      'p1',
      'test',
      cwd,
      'Login task',
      '1.0',
      0,
      0,
      0,
      Date.now(),
      Date.now(),
    );
    for (const [index, role] of ['user', 'assistant'].entries()) {
      db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(
        `m${index}`,
        id,
        Date.now() + index,
        JSON.stringify({ role }),
      );
      db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(
        `part${index}`,
        `m${index}`,
        id,
        Date.now() + index,
        JSON.stringify({
          type: 'text',
          text: index
            ? 'Next step: patch authentication and run tests.'
            : 'Fix the login bug without changing public API.',
        }),
      );
    }
    db.close();
  }
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (rows) await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const account = { tool, root, label: 'test' };
  const sessions = await worker(account, 'list');
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, id);
  return { ...sessions[0], account, key: `${tool}:${file}:${id}` };
}

for (const source of ['claude', 'codex', 'gemini', 'opencode']) {
  test(`${source}: discover, extract and hand off to each other agent`, async (t) => {
    const session = await fixture(t, source);
    for (const target of ['claude', 'codex', 'gemini', 'opencode'].filter((x) => x !== source)) {
      const result = await plan(session, resolveTarget(target, {}));
      assert.equal(result.mode, 'handoff');
      const content = await fs.readFile(result.file, 'utf8');
      assert.match(content, /login bug/);
      assert.match(content, /patch authentication/);
      const archive = JSON.parse(await fs.readFile(result.historyFile, 'utf8'));
      assert.ok(archive.messages.some((m) => m.content.includes('login bug')));
      assert.ok(result.args.at(-1).includes(path.basename(result.file)));
    }
  });
}
test('long handoffs preserve early requirements and long messages in an archive', async (t) => {
  const session = await fixture(t, 'claude');
  const tail = Array.from({ length: 70 }, (_, index) => ({
    type: 'user',
    uuid: `later-${index}`,
    sessionId: session.id,
    cwd: session.cwd,
    timestamp: '2026-10-30T12:00:00.000Z',
    message: {
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            index === 69
              ? 'x'.repeat(12000) + 'END_OF_LONG_MESSAGE'
              : `Follow-up conversation message ${index}`,
        },
      ],
    },
  }));
  await fs.appendFile(
    session.originalPath,
    tail.map((row) => JSON.stringify(row)).join('\n') + '\n',
  );
  const result = await plan(session, resolveTarget('codex', {}));
  const archive = JSON.parse(await fs.readFile(result.historyFile, 'utf8'));
  assert.equal(archive.messages.length, 72);
  assert.match(archive.messages[0].content, /without changing public API/);
  assert.ok(archive.messages.at(-1).content.endsWith('END_OF_LONG_MESSAGE'));
  const brief = await fs.readFile(result.file, 'utf8');
  assert.match(brief, /72 parsed messages/);
  assert.ok(brief.includes(path.basename(result.historyFile)));
  assert.ok(!brief.includes('Follow-up conversation message 0\n'));
});
test('accounts: native only when target storage matches; alias gets portable context', async (t) => {
  const session = await fixture(t, 'claude');
  const target = {
    ...resolveTarget('claude', {}),
    env: { CLAUDE_CONFIG_DIR: session.account.root },
  };
  const native = await plan(session, target);
  assert.equal(native.mode, 'native');
  assert.deepEqual(native.args, ['--resume', session.id]);
  assert.equal(
    (await plan(session, resolveTarget('claude', {}), { dryRun: true })).mode,
    'handoff',
  );
  assert.equal(
    (
      await plan(
        session,
        resolveTarget('custom-alias', {
          targets: { 'custom-alias': { tool: 'claude', shell: true } },
        }),
        { dryRun: true },
      )
    ).mode,
    'handoff',
  );
  assert.deepEqual(await fs.readdir(session.cwd), []);
});
test('configured target account homes are discoverable without duplicate source registration', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-profiles-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const claudeRoot = path.join(root, 'work-claude');
  const config = {
    targets: {
      work: { tool: 'claude', env: { CLAUDE_CONFIG_DIR: claudeRoot } },
      extra: { tool: 'opencode', env: { OPENCODE_DB: path.join(root, 'custom.db') } },
    },
    sources: [{ tool: 'claude', root: claudeRoot, label: 'explicit' }],
  };
  const found = await sources(config, root);
  assert.equal(found.filter((s) => s.root === claudeRoot).length, 1);
  assert.equal(found.find((s) => s.root === claudeRoot).label, 'explicit');
  assert.equal(found.find((s) => s.label === 'extra').db, path.join(root, 'custom.db'));
  delete config.sources;
  assert.equal((await sources(config, root)).find((s) => s.label === 'work').root, claudeRoot);
});
test('native Gemini selects exact ID, and handoffs stay interactive', () => {
  assert.deepEqual(agentArgs('gemini', 'abc'), ['--resume', 'abc']);
  assert.deepEqual(agentArgs('gemini', null, 'hello'), ['--prompt-interactive', 'hello']);
  assert.deepEqual(agentArgs('opencode', null, 'hello'), ['--prompt', 'hello']);
  assert.deepEqual(agentArgs('claude', null, 'hello'), ['--', 'hello']);
  assert.deepEqual(agentArgs('codex', null, 'hello'), ['--', 'hello']);
  assert.throws(() => resolveTarget('claude;echo', {}));
});
test('launch preserves argv and exit status', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-launch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'stub.cjs'),
    output = path.join(root, 'result.json');
  await fs.writeFile(
    script,
    'require("fs").writeFileSync(process.env.RESULT, JSON.stringify(process.argv.slice(2))); process.exitCode=7;',
  );
  const args = ['spaces here', '$(touch unwanted)', 'a&b', 'quote"test'];
  assert.equal(
    await launch({
      cwd: root,
      target: { command: process.execPath, env: { RESULT: output } },
      args: [script, ...args],
    }),
    7,
  );
  assert.deepEqual(JSON.parse(await fs.readFile(output)), args);
});
test('old target CLIs fail before launching a handoff; current flags are accepted', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-capabilities-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const command = path.join(root, 'cli.cjs');
  await fs.writeFile(
    command,
    'if(process.argv.includes("--help")) console.log(process.env.TEST_HELP); else require("fs").writeFileSync("launched", "yes");',
  );
  const target = {
    tool: 'gemini',
    command: process.execPath,
    args: [command],
    env: { TEST_HELP: '--prompt [text]' },
  };
  const launchPlan = { target, cwd: root, mode: 'handoff', args: [command, 'context'] };
  await assert.rejects(launch(launchPlan), /does not support --prompt-interactive/);
  assert.deepEqual(await fs.readdir(root), ['cli.cjs']);
  target.env.TEST_HELP = '--prompt-interactive [text] --resume [id]';
  await validateTarget(launchPlan);
  await validateTarget({ ...launchPlan, mode: 'native' });
  target.tool = 'opencode';
  await assert.rejects(validateTarget(launchPlan), /does not support --prompt/);
  target.env.TEST_HELP = '--prompt [text] --session [id]';
  await validateTarget(launchPlan);
  await validateTarget({ ...launchPlan, mode: 'native' });
});

test('CLI defaults to current folder; --all and --path are explicit overrides', async (t) => {
  const first = await fixture(t, 'claude');
  const second = await fixture(t, 'codex', '22222222-2222-4222-8222-222222222222');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-home-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const config = path.join(home, 'config.json');
  await fs.writeFile(config, JSON.stringify({ sources: [first.account, second.account] }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, RESUME_CONFIG: config };
  for (const key of [
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'GEMINI_CLI_HOME',
    'XDG_DATA_HOME',
    'OPENCODE_DB',
  ])
    delete env[key];
  const cli = fileURLToPath(new URL('../bin/resume.js', import.meta.url));
  const run = async (args) =>
    JSON.parse(
      (await promisify(execFile)(process.execPath, [cli, ...args], { env, cwd: first.cwd })).stdout,
    );
  assert.deepEqual(
    (await run(['list', '--json'])).map((s) => s.id),
    [first.id],
  );
  assert.equal((await run(['list', '--json', '--all'])).length, 2);
  assert.deepEqual(
    (await run(['list', '--json', '--path', second.cwd])).map((s) => s.id),
    [second.id],
  );
  const preview = await run(['codex', '--session', first.id, '--dry-run']);
  assert.equal(preview.mode, 'handoff');
  assert.deepEqual(await fs.readdir(first.cwd), []);
  await assert.rejects(run(['codex', '--session', second.id, '--dry-run']), /Session not found/);
  // Embedders can call the library from stdin/eval without leaking Node-only
  // parent flags such as --input-type into the file-based parser worker.
  const core = new URL('../src/core.js', import.meta.url).href;
  const inline = `import {worker} from ${JSON.stringify(core)}; console.log(JSON.stringify(await worker(${JSON.stringify(first.account)}, 'list')));`;
  const parsed = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '-e', inline],
    { env, cwd: first.cwd },
  );
  assert.equal(JSON.parse(parsed.stdout)[0].id, first.id);
});

test('same-folder chats from previous accounts remain selectable after changing active account', async (t) => {
  const old = await fixture(t, 'claude');
  const current = await fixture(t, 'claude', '22222222-2222-4222-8222-222222222222', {
    cwd: old.cwd,
  });
  old.account.label = 'previous-account';
  current.account.label = 'current-account';
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-account-switch-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const config = path.join(home, 'config.json');
  await fs.writeFile(
    config,
    JSON.stringify({
      sources: [old.account, current.account],
      targets: { clauded: { tool: 'claude', shell: true } },
    }),
  );
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    RESUME_CONFIG: config,
    CLAUDE_CONFIG_DIR: current.account.root,
  };
  for (const key of ['CODEX_HOME', 'GEMINI_CLI_HOME', 'XDG_DATA_HOME', 'OPENCODE_DB'])
    delete env[key];
  const cli = fileURLToPath(new URL('../bin/resume.js', import.meta.url));
  const run = async (args) =>
    JSON.parse(
      (await promisify(execFile)(process.execPath, [cli, ...args], { env, cwd: old.cwd })).stdout,
    );
  const listed = await run(['list', '--json']);
  assert.deepEqual(new Set(listed.map((s) => s.id)), new Set([old.id, current.id]));
  for (const session of listed) {
    const aliasPlan = await run(['clauded', '--session', session.key, '--dry-run']);
    assert.equal(aliasPlan.target.name, 'clauded');
    assert.equal(aliasPlan.mode, 'handoff');
    assert.deepEqual(aliasPlan.target.env, {}); // Never restore the source account's login environment.
    assert.equal(await fs.realpath(aliasPlan.cwd), await fs.realpath(old.cwd));
  }
  assert.equal((await run(['claude', '--session', old.id, '--dry-run'])).mode, 'handoff');
  assert.equal((await run(['claude', '--session', current.id, '--dry-run'])).mode, 'native');
});

test(
  'zsh alias expands while preserving literal handoff arguments',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-alias-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const script = path.join(root, 'stub.cjs'),
      output = path.join(root, 'result.json');
    await fs.writeFile(
      script,
      'require("fs").writeFileSync(process.env.RESULT, JSON.stringify(process.argv.slice(2)));',
    );
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    await fs.writeFile(
      path.join(root, '.zshrc'),
      `alias demo=${quote(`${quote(process.execPath)} ${quote(script)} --existing-flag`)}\n`,
    );
    const args = ['spaces here', '$(touch unwanted)', 'a&b', 'quote"test'];
    assert.equal(
      await launch({
        cwd: root,
        target: {
          command: 'demo',
          shell: true,
          env: { SHELL: '/bin/zsh', ZDOTDIR: root, RESULT: output },
        },
        args,
      }),
      0,
    );
    assert.deepEqual(JSON.parse(await fs.readFile(output)), ['--existing-flag', ...args]);
  },
);

test(
  'arbitrary shell aliases are detected and preserve alias plus forwarded flags end-to-end',
  { skip: process.platform === 'win32' },
  async (t) => {
    const source = await fixture(t, 'codex');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-alias-detect-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const shell = process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
    const output = path.join(root, 'received.json');
    const stub = path.join(root, 'claude');
    await fs.writeFile(
      stub,
      '#!/usr/bin/env node\nrequire("fs").writeFileSync(process.env.RESULT, JSON.stringify({args:process.argv.slice(2),teams:process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS}));\n',
      { mode: 0o755 },
    );
    const startup = process.platform === 'darwin' ? '.zshrc' : '.bashrc';
    await fs.writeFile(
      path.join(root, startup),
      "alias review-buddy='CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 claude --dangerously-skip-permissions --chrome'\nalias second-entry='review-buddy --verbose'\nalias codex='claude --model configured'\n",
    );
    const config = path.join(root, 'config.json');
    await fs.writeFile(config, JSON.stringify({ sources: [source.account] }));
    const env = {
      ...process.env,
      SHELL: shell,
      HOME: root,
      ZDOTDIR: root,
      RESUME_CONFIG: config,
      RESULT: output,
      PATH: root + path.delimiter + process.env.PATH,
    };
    for (const key of [
      'CLAUDE_CONFIG_DIR',
      'CODEX_HOME',
      'GEMINI_CLI_HOME',
      'XDG_DATA_HOME',
      'OPENCODE_DB',
    ])
      delete env[key];
    assert.equal(
      detectAliasTool('review-buddy', ['claude', 'codex', 'gemini', 'opencode'], { env }),
      'claude',
    );
    assert.equal(detectAliasTool('second-entry', ['claude', 'codex'], { env }), 'claude');
    assert.throws(() => resolveTarget('clauded', {}, { env }), /Cannot determine/); // No naming shortcut.
    const override = resolveTarget('codex', {}, { env, inspectKnown: true });
    assert.equal(override.tool, 'claude');
    assert.equal(override.shell, true);
    const cli = fileURLToPath(new URL('../bin/resume.js', import.meta.url));
    await promisify(execFile)(
      process.execPath,
      [
        cli,
        'review-buddy',
        '--session',
        source.id,
        '--model',
        'sonnet',
        '--add-dir',
        'path with spaces',
      ],
      { cwd: source.cwd, env },
    );
    const received = JSON.parse(await fs.readFile(output, 'utf8'));
    assert.equal(received.teams, '1');
    assert.deepEqual(received.args.slice(0, -1), [
      '--dangerously-skip-permissions',
      '--chrome',
      '--model',
      'sonnet',
      '--add-dir',
      'path with spaces',
      '--',
    ]);
    assert.match(received.args.at(-1), /Continue the session described in \.resume\/handoff-/);
  },
);

test(
  'bash alias expands from shell startup with literal arguments',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-bash-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const script = path.join(root, 'stub.cjs'),
      output = path.join(root, 'result.json');
    await fs.writeFile(
      script,
      'require("fs").writeFileSync(process.env.RESULT, JSON.stringify(process.argv.slice(2)));',
    );
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    await fs.writeFile(
      path.join(root, '.bashrc'),
      `alias demo=${quote(`${quote(process.execPath)} ${quote(script)} --existing-flag`)}\n`,
    );
    const args = ['spaces here', '$(touch unwanted)', 'a&b', 'quote"test'];
    assert.equal(
      await launch({
        cwd: root,
        target: {
          command: 'demo',
          shell: true,
          env: { SHELL: '/bin/bash', HOME: root, RESULT: output },
        },
        args,
      }),
      0,
    );
    assert.deepEqual(JSON.parse(await fs.readFile(output)), ['--existing-flag', ...args]);
  },
);

test(
  'Windows npm-style cmd shim preserves arguments',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resume cmd-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const script = path.join(root, 'stub.cjs'),
      output = path.join(root, 'result.json'),
      command = path.join(root, 'agent.cmd');
    await fs.writeFile(
      script,
      'require("fs").writeFileSync(process.env.RESULT, JSON.stringify(process.argv.slice(2))); process.exitCode=7;',
    );
    await fs.writeFile(command, `@"${process.execPath}" "${script}" %*\r\n`);
    const args = ['spaces here', 'a&b', 'quote"test', '%RESUME_TEST_SECRET%', 'bang!test'];
    assert.equal(
      await launch({
        cwd: root,
        target: { command, env: { RESULT: output, RESUME_TEST_SECRET: 'must-not-expand' } },
        args,
      }),
      7,
    );
    assert.deepEqual(JSON.parse(await fs.readFile(output)), args);
  },
);

test(
  'PowerShell target receives literal args and reports missing commands',
  { skip: process.platform !== 'win32' },
  async () => {
    const args = ['spaces here', '$(Write-Output injected)', 'a&b', 'quote"test'];
    const core = new URL('../src/core.js', import.meta.url).href;
    const script = `import {launch} from ${JSON.stringify(core)}; process.exitCode=await launch(${JSON.stringify({ cwd: process.cwd(), target: { command: 'Write-Output', shell: true }, args })});`;
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--input-type=module',
      '-e',
      script,
    ]);
    assert.deepEqual(stdout.trim().split(/\r?\n/), args);
    assert.notEqual(
      await launch({
        cwd: process.cwd(),
        target: { command: 'resumeMissingCommand72b9', shell: true },
        args: [],
      }),
      0,
    );
  },
);

test(
  'PowerShell alias detection reads the actual command definition',
  { skip: process.platform !== 'win32' },
  () => {
    assert.equal(detectAliasTool('echo', ['write-output']), 'write-output');
    assert.equal(detectAliasTool('gci', ['get-childitem']), 'get-childitem');
    assert.equal(detectAliasTool('resumeMissingAlias72b9', ['claude', 'codex']), undefined);
  },
);

test(
  'local handoff refuses a symlinked private context directory',
  { skip: process.platform === 'win32' },
  async (t) => {
    const session = await fixture(t, 'claude');
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-outside-'));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    await fs.symlink(outside, path.join(session.cwd, '.resume'));
    await assert.rejects(plan(session, resolveTarget('codex', {})), /Unsafe parent/);
    assert.deepEqual(await fs.readdir(outside), []);
  },
);
