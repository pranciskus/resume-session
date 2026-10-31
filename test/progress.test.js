import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { createProgress } from '../src/progress.js';

test('slow operations clear progress before returning or reporting errors', async () => {
  for (const fail of [false, true]) {
    const events = [];
    const error = new Error('Cannot read session');
    const progress = createProgress({
      enabled: true,
      delay: 0,
      makeSpinner: () => ({
        start: (message) => events.push(message),
        clear: () => events.push('clear'),
      }),
    });
    const result = progress('Reading session', async () => {
      await wait(20);
      if (fail) throw error;
      return 42;
    });
    if (fail) await assert.rejects(result, (e) => e === error);
    else assert.equal(await result, 42);
    assert.deepEqual(events, ['Reading session', 'clear']);
  }
});

test('fast operations do not flash a spinner after completion', async () => {
  let created = false;
  const progress = createProgress({
    enabled: true,
    delay: 0,
    makeSpinner: () => {
      created = true;
    },
  });
  assert.equal(await progress('Reading', () => 42), 42);
  await wait(20);
  assert.equal(created, false);
});

test('non-terminal and explicitly disabled progress never renders', async () => {
  for (const options of [{ output: { isTTY: false } }, { enabled: false }]) {
    const progress = createProgress({
      ...options,
      delay: 0,
      makeSpinner: () => assert.fail('Unexpected spinner'),
    });
    assert.equal(
      await progress('Reading', async () => {
        await wait(20);
        return 42;
      }),
      42,
    );
  }
});
