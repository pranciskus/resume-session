import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateCheckpoint, restoreCheckpoint } from '../src/checkpoint.js';

function checkpoint() {
  return {
    format: 'resume-handoff/1',
    workspace: { kind: 'git', identity: null, head: 'a'.repeat(40), base: 'a'.repeat(40), cwd: '' },
    session: { source: 'codex', markdown: 'Continue the research.', messages: [] },
    recovery: { count: 0, warnings: 0, artifacts: [] },
    files: [],
  };
}
const file = (name) => ({ path: name, data: '', executable: false });

test('checkpoint validation rejects malformed records and conflicting portable paths', () => {
  const invalid = [
    (value) => {
      value.files = [null];
    },
    ...['a<b', 'a>b', 'a\"b', 'a|b', 'a?b', 'a*b'].map((name) => (value) => {
      value.files = [file(name)];
    }),
    (value) => {
      value.files = [file('report'), file('report/notes')];
    },
    (value) => {
      value.files = [file('Report'), file('report/notes')];
    },
    (value) => {
      value.files = [file('café'), file('cafe\u0301')];
    },
    (value) => {
      value.files = [{ ...file('notes'), deleted: 'yes' }];
    },
    (value) => {
      value.recovery.count = -1;
    },
    (value) => {
      value.recovery.artifacts = [{ path: 'worker.json', text: '{' }];
    },
    (value) => {
      value.recovery.artifacts = [{ path: 'worker.jsonl', text: '{}\nnot-json' }];
    },
    (value) => {
      value.recovery.artifacts = [
        { path: 'a', text: '' },
        { path: 'a/b', text: '' },
      ];
    },
    (value) => {
      value.ancestry = [null];
    },
  ];
  for (const mutate of invalid) {
    const value = checkpoint();
    mutate(value);
    assert.throws(
      () => validateCheckpoint(value),
      (error) => error instanceof Error && !(error instanceof TypeError),
    );
  }
});

test('checkpoint validation preserves valid file-directory transitions', () => {
  for (const files of [
    [{ path: 'notes', deleted: true }, file('notes/summary')],
    [{ path: 'notes/summary', deleted: true }, file('notes')],
  ]) {
    const value = checkpoint();
    value.files = files;
    assert.equal(validateCheckpoint(value), value);
  }
});

test('deeply nested conversation and recovery packets fail before recursive mapping', () => {
  let nested = {};
  for (let i = 0; i < 140; i++) nested = { child: nested };
  const value = checkpoint();
  value.session.messages.push(nested);
  assert.throws(() => validateCheckpoint(value), /nesting/);
  value.session.messages = [];
  value.recovery.artifacts.push({ path: 'worker.json', text: JSON.stringify(nested) });
  assert.throws(() => validateCheckpoint(value), /nesting/);
  value.recovery.artifacts = [];
  value.session.messages.push(value);
  assert.throws(() => validateCheckpoint(value), /serializable/);
});

test('invalid inherited recovery is rejected before a history-only workspace is created', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-invalid-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const value = checkpoint();
  value.ancestry = [
    {
      id: 'rs_' + 'a'.repeat(24),
      session: value.session,
      recovery: { count: 1, warnings: 0, artifacts: [{ path: 'worker.json', text: '{' }] },
    },
  ];
  await assert.rejects(
    restoreCheckpoint(
      value,
      root,
      'rs_' + 'b'.repeat(24),
      { tool: 'codex', args: [] },
      { stateRoot: path.join(root, 'state'), historyOnly: true },
    ),
    /Invalid recovery JSON/,
  );
  assert.deepEqual(await fs.readdir(root), []);
});

test('whitespace-only recovery JSONL lines restore successfully', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-jsonl-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const value = checkpoint();
  value.recovery.artifacts = [{ path: 'worker.jsonl', text: '{}\n  \n{}\n' }];
  const result = await restoreCheckpoint(
    value,
    root,
    'rs_' + 'w'.repeat(24),
    { tool: 'codex', args: [] },
    { stateRoot: root, historyOnly: true },
  );
  const text = await fs.readFile(
    path.join(path.dirname(result.file), 'agents', 'worker.jsonl'),
    'utf8',
  );
  assert.equal(text, '{}\n{}\n');
});
