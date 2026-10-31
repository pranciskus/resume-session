// Real CLI captures against fictional histories only. See docs/screenshots.md.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repo = fileURLToPath(new URL('..', import.meta.url));
const requireTools = createRequire(
  path.resolve(process.argv[2] || '/tmp/resume-release-tools', 'package.json'),
);
const { chromium } = requireTools('playwright');
const root = await fs.mkdtemp('/tmp/resume-demo-');
const home = path.join(root, 'home'),
  cwd = path.join(home, 'projects', 'atlas');
const out = path.join(repo, 'docs', 'images');
const cli = path.join(repo, 'bin', 'resume.js');
await fs.mkdir(cwd, { recursive: true });
await fs.mkdir(out, { recursive: true });
const personal = path.join(home, '.claude'),
  work = path.join(home, '.claude-work');
const codex = path.join(home, '.codex'),
  open = path.join(home, '.local', 'share');
const config = path.join(home, 'resume.json');
const ids = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
];
const timestamp = '2026-10-01T10:00:00.000Z';
const jsonl = async (file, rows) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  await fs.utimes(file, new Date(timestamp), new Date(timestamp));
};
const row = (role, content, extra = {}) => ({
  type: role,
  cwd,
  sessionId: ids[0],
  timestamp,
  message: { role, content },
  ...extra,
});
const call = (id, name, prompt) => ({
  type: 'tool_use',
  id,
  name: 'Agent',
  input: { name, description: name, prompt },
});
const result = (id, agent, status = 'teammate_spawned') =>
  row('user', [{ type: 'tool_result', tool_use_id: id, content: `agentId: ${agent}` }], {
    toolUseResult: { agentId: agent, status },
  });
const parent = path.join(personal, 'projects', 'atlas', ids[0] + '.jsonl');
const workers = parent.replace(/\.jsonl$/, '') + '/subagents';
const assignments = [
  ['api', 'Finish the billing API. Reuse the saved implementation; validate idempotency.'],
  ['tests', 'Run independent billing tests and report remaining failures.'],
  ['docs', 'Document the billing API after the contract is verified.'],
];
await jsonl(parent, [
  row('user', 'Ship billing API, tests and docs.'),
  ...assignments.flatMap(([name, prompt]) => [
    row('assistant', [call(name + '-call', name, prompt)]),
    result(name + '-call', name),
  ]),
  row('assistant', [call('review-call', 'review', 'Review the final API contract independently.')]),
  row(
    'assistant',
    'Implementation is saved. Tests hit a quota limit; documentation is still pending.',
  ),
]);
for (const [name, prompt] of assignments) {
  const rows = [
    row('user', prompt),
    row(
      'assistant',
      name === 'api'
        ? 'Implementation saved in src/billing.js. Validate before reuse.'
        : name === 'tests'
          ? 'Test plan saved; execution was interrupted.'
          : 'Documentation outline saved; awaiting the final contract.',
    ),
  ];
  if (name === 'tests')
    rows.push(row('assistant', 'Weekly limit reached', { apiError: 'usage_limit_reached' }));
  await jsonl(path.join(workers, `agent-${name}.jsonl`), rows);
}
await fs.appendFile(
  parent,
  JSON.stringify(
    row(
      'user',
      '<task-notification><task-id>api</task-id><status>completed</status><summary>Implementation saved</summary></task-notification>',
      { timestamp: '2026-10-01T10:01:00.000Z' },
    ),
  ) + '\n',
);
await jsonl(path.join(work, 'projects', 'atlas', ids[1] + '.jsonl'), [
  row('user', 'Fix OAuth callback validation.', { sessionId: ids[1] }),
  row('assistant', 'Reproduce the callback mismatch, then add regression coverage.', {
    sessionId: ids[1],
  }),
]);
await jsonl(
  path.join(personal, 'projects', 'atlas-old', '66666666-6666-4666-8666-666666666666.jsonl'),
  [
    row('user', 'Outside the current folder: should never appear.', {
      cwd: cwd + '-old',
      sessionId: '66666666-6666-4666-8666-666666666666',
    }),
  ],
);
await jsonl(
  path.join(codex, 'sessions', '2026', '10', '01', `rollout-2026-10-01T10-00-00-${ids[2]}.jsonl`),
  [
    { type: 'session_meta', timestamp, payload: { id: ids[2], cwd } },
    {
      type: 'event_msg',
      timestamp,
      payload: { type: 'user_message', message: 'Add retry coverage for webhook delivery.' },
    },
    {
      type: 'response_item',
      timestamp,
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Add retry coverage for webhook delivery.' }],
      },
    },
  ],
);
await fs.mkdir(path.join(home, '.gemini'), { recursive: true });
await fs.writeFile(
  path.join(home, '.gemini', 'projects.json'),
  JSON.stringify({ projects: { [cwd]: 'atlas' } }),
);
await jsonl(path.join(home, '.gemini', 'tmp', 'atlas', 'chats', `session-${ids[3]}.jsonl`), [
  { sessionId: ids[3], projectHash: 'atlas', startTime: timestamp, lastUpdated: timestamp },
  { id: 'g1', timestamp, type: 'user', content: 'Explain the invoice event flow.' },
]);
await fs.mkdir(path.join(open, 'opencode'), { recursive: true });
const db = new DatabaseSync(path.join(open, 'opencode', 'opencode.db'));
db.exec(
  'CREATE TABLE project (id TEXT, worktree TEXT); CREATE TABLE session (id TEXT, project_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT, summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER, time_created INTEGER, time_updated INTEGER); CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE todo (session_id TEXT, content TEXT, status TEXT, priority TEXT, position INTEGER);',
);
db.prepare('INSERT INTO project VALUES (?, ?)').run('atlas', cwd);
db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
  ids[4],
  'atlas',
  'accessibility',
  cwd,
  'Polish invoice form accessibility',
  '1.0',
  0,
  0,
  0,
  Date.parse(timestamp),
  Date.parse(timestamp),
);
db.close();
await fs.writeFile(
  config,
  JSON.stringify({
    sources: [
      { tool: 'claude', root: personal, label: 'personal' },
      { tool: 'claude', root: work, label: 'work' },
    ],
  }),
);
await fs.writeFile(path.join(home, '.bashrc'), "alias my-ai='claude --model sonnet'\n");
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  SHELL: '/bin/bash',
  RESUME_CONFIG: config,
  TERM: 'xterm-256color',
  FORCE_COLOR: '1',
  NO_COLOR: '',
};
for (const key of [
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'GEMINI_CLI_HOME',
  'XDG_DATA_HOME',
  'OPENCODE_DB',
  'ZDOTDIR',
])
  delete env[key];
delete env.NO_COLOR;
const run = (args) =>
  execFileSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8' });
const shorten = (text) =>
  text
    .replaceAll('/private' + root + '/home', '~')
    .replaceAll(root + '/home', '~')
    .replace(/handoff-[0-9a-f-]{36}/g, 'handoff-DEMO');
const prompt = (command) => `\x1b[38;2;0;117;105m~/projects/atlas\x1b[0m $ ${command}\r\n\r\n`;
const screens = [];
let browser;
try {
  await fs.utimes(parent, new Date('2026-10-01T10:10:00Z'), new Date('2026-10-01T10:10:00Z'));
  const sessions = JSON.parse(run(['list', '--json']));
  if (sessions.length !== 5 || sessions.some((s) => s.cwd !== cwd))
    throw new Error(
      'Demo folder isolation failed: ' +
        JSON.stringify(sessions.map((s) => ({ source: s.source, cwd: s.cwd, id: s.id }))),
    );
  const picker = execFileSync(
    'python3',
    [path.join(repo, 'scripts', 'demo-capture.py'), process.execPath, cli, 'codex'],
    { cwd, env, encoding: 'utf8' },
  );
  screens.push({ name: 'picker', ansi: prompt('resume codex') + shorten(picker) });
  screens.push({
    name: 'accounts',
    ansi: prompt('resume list --search claude') + shorten(run(['list', '--search', 'claude'])),
  });
  const prepared = JSON.parse(run(['codex', '--session', ids[0], '--prepare', '--json']));
  const prepareText = `Prepared handoff: ${prepared.file}\nWorker recovery plan: ${prepared.recovery.instructions} (${prepared.recovery.count} worker/dispatch records)\n`;
  screens.push({
    name: 'handoff',
    ansi:
      prompt(`SESSION=${ids[0]}\r\n$ resume codex --session "$SESSION" --prepare`) +
      shorten(prepareText).replaceAll('~/projects/atlas/', '') +
      '\r\n\x1b[38;2;0;117;105m$ ls .resume/\x1b[0m\r\n' +
      shorten((await fs.readdir(path.join(cwd, '.resume'))).join('\n')),
  });
  const aliasPlan = JSON.parse(run(['my-ai', '--session', ids[0], '--verbose', '--dry-run']));
  const projection = {
    command: aliasPlan.target.command,
    shell: aliasPlan.target.shell,
    forwarded: aliasPlan.args.slice(0, -2),
  };
  screens.push({
    name: 'aliases',
    ansi:
      prompt(
        '# Save in ~/.bashrc or ~/.zshrc\r\nalias my-ai=\'claude --model sonnet\'\r\n\r\n$ resume my-ai --session "$SESSION" --verbose --dry-run',
      ) +
      '\x1b[90m# Launch-plan excerpt (handoff prompt omitted)\x1b[0m\r\n' +
      JSON.stringify(projection, null, 2),
  });
  const manifest = JSON.parse(await fs.readFile(prepared.recovery.manifest, 'utf8'));
  const lines = manifest.agents.map(
    (a) =>
      `${String(a.name).padEnd(12)} ${a.reportedStatus.padEnd(20)} ${a.transcriptAvailable ? 'saved transcript' : 'assignment only'}`,
  );
  screens.push({
    name: 'recovery',
    ansi:
      prompt('# Saved subagent work from the selected session') +
      'WORKER       HISTORICAL STATUS    RECOVERED CONTEXT\r\n' +
      lines.join('\r\n') +
      `\r\n\r\n${manifest.transcriptCount} transcript snapshots / ${manifest.dispatchOnlyCount} unconfirmed dispatch\r\n\r\n` +
      '\x1b[90m# Verify existing outputs. Recreate only unfinished workers.\r\n# Saved context transfers; running processes do not.\x1b[0m',
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2,
  });
  for (const screen of screens) {
    await page.setContent(
      '<html><head></head><body><section><header><div class="controls"><i></i><i></i><i></i></div><span>atlas</span></header><div id="terminal"></div></section></body></html>',
    );
    await page.addStyleTag({ path: requireTools.resolve('@xterm/xterm/css/xterm.css') });
    await page.addStyleTag({
      content: `*{box-sizing:border-box}body{margin:0;background:transparent;font-family:-apple-system,BlinkMacSystemFont,sans-serif}section{width:1088px;border:1px solid #d2d2d7;border-radius:12px;overflow:hidden;background:#fff}header{height:40px;background:#f5f5f7;border-bottom:1px solid #e5e5e7;position:relative;display:flex;align-items:center;justify-content:center}.controls{position:absolute;left:16px;display:flex;gap:8px}i{width:11px;height:11px;border-radius:50%;background:#ff5f57}i:nth-child(2){background:#febc2e}i:nth-child(3){background:#28c840}header span{font-size:12px;color:#6e6e73;font-weight:500}#terminal{padding:24px}.xterm-viewport{overflow:hidden!important}`,
    });
    await page.addScriptTag({ path: requireTools.resolve('@xterm/xterm') });
    await page.evaluate(async ({ ansi }) => {
      const term = new Terminal({
        cols: 104,
        rows: 40,
        fontSize: 16,
        lineHeight: 1.4,
        fontFamily: 'Menlo, monospace',
        cursorBlink: false,
        disableStdin: true,
        convertEol: true,
        theme: {
          background: '#ffffff',
          foreground: '#1d1d1f',
          cyan: '#007569',
          green: '#007569',
          brightBlack: '#6e6e73',
        },
      });
      term.open(document.querySelector('#terminal'));
      await new Promise((resolve) => term.write(ansi + '\x1b[?25l', resolve));
      let last = 0;
      for (let i = 0; i < 40; i++)
        if (term.buffer.active.getLine(i)?.translateToString(true).trim()) last = i;
      term.resize(104, last + 2);
    }, screen);
    await page.locator('section').screenshot({ path: path.join(out, screen.name + '.png') });
    console.log('Rendered', screen.name);
  }
} finally {
  await browser?.close();
  await fs.rm(root, { recursive: true, force: true });
}
