import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapContextStrings, PROJECT_ROOT } from '../src/context-paths.js';

test('path remapping preserves sibling and unrelated paths', () => {
  const input = [
    '/work/job',
    '/work/job/notes.md',
    'Read `/work/job`.',
    'cd /work/job; cat /work/job/notes.md',
    '/work/job-backup',
    '/work/jobs',
    '/other/work/job',
    'https://host/work/job',
    '/work/job.txt',
  ];
  assert.deepEqual(mapContextStrings(input, '/work/job', PROJECT_ROOT), [
    PROJECT_ROOT,
    PROJECT_ROOT + '/notes.md',
    `Read \`${PROJECT_ROOT}\`.`,
    `cd ${PROJECT_ROOT}; cat ${PROJECT_ROOT}/notes.md`,
    ...input.slice(4),
  ]);
});

test('path mapping preserves structured Windows context and literal replacement characters', () => {
  const value = {
    content: 'C:\\Work\\job\\notes.md',
    nested: ['C:\\Work\\job-backup', 'cwd="C:\\Work\\job"'],
    count: 3,
  };
  const portable = mapContextStrings(value, 'C:\\Work\\job', PROJECT_ROOT);
  const restored = mapContextStrings(portable, PROJECT_ROOT, 'D:\\Team $&\\job');
  assert.equal(restored.content, 'D:\\Team $&\\job\\notes.md');
  assert.equal(restored.nested[0], value.nested[0]);
  assert.equal(restored.nested[1], 'cwd="D:\\Team $&\\job"');
  assert.equal(restored.count, 3);
  assert.equal(value.content, 'C:\\Work\\job\\notes.md');
});

test('filesystem-root workspaces retain the path separator without rewriting URLs', () => {
  assert.equal(mapContextStrings('/notes.txt', '/', PROJECT_ROOT), PROJECT_ROOT + '/notes.txt');
  assert.equal(
    mapContextStrings('C:\\notes.txt', 'C:\\', PROJECT_ROOT),
    PROJECT_ROOT + '\\notes.txt',
  );
  assert.equal(
    mapContextStrings('https://example.com/notes', '/', PROJECT_ROOT),
    'https://example.com/notes',
  );
});
