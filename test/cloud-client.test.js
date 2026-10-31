import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { upload, download } from '../src/cloud.js';

async function server(t, handler) {
  const instance = createServer(handler);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(
    () =>
      new Promise((resolve) => {
        instance.close(resolve);
        instance.closeAllConnections();
      }),
  );
  return {
    server: `http://127.0.0.1:${instance.address().port}`,
    token: 'synthetic-client-test-token',
  };
}

test('invalid upload receipts fail clearly before an ID is accepted', async (t) => {
  let mutate = (value) => value;
  const settings = await server(t, async (req, res) => {
    const digest = createHash('sha256');
    for await (const chunk of req) digest.update(chunk);
    const value = mutate({
      id: 'rs_' + 'a'.repeat(24),
      sha256: digest.digest('hex'),
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    res.end(JSON.stringify(value));
  });
  for (const change of [
    () => null,
    (value) => ({ ...value, id: [value.id] }),
    (value) => ({ ...value, id: 'bad-id' }),
    (value) => ({ ...value, expiresAt: 'not-a-date' }),
    (value) => ({ ...value, sha256: '0'.repeat(64) }),
  ]) {
    mutate = change;
    await assert.rejects(upload(settings, { text: 'synthetic' }), /invalid handoff receipt/);
  }
  mutate = (value) => value;
  assert.match((await upload(settings, {})).id, /^rs_/);
});

test('redirects cannot forward the team token to a second endpoint', async (t) => {
  let received = 0;
  const destination = await server(t, (_req, res) => {
    received++;
    res.end('{}');
  });
  const origin = await server(t, (_req, res) => {
    res.writeHead(307, { Location: destination.server + '/capture' });
    res.end();
  });
  await assert.rejects(download(origin, 'rs_' + 'a'.repeat(24)), /fetch failed/);
  assert.equal(received, 0);
});

test('server errors cannot inject terminal control sequences', async (t) => {
  const settings = await server(t, (_req, res) => {
    res.writeHead(503);
    res.end(JSON.stringify({ error: 'Busy\u001b[2J\nretry later' }));
  });
  await assert.rejects(
    download(settings, 'rs_' + 'a'.repeat(24)),
    (error) => /Busy/.test(error.message) && !/[\x00-\x1f]/.test(error.message),
  );
});
