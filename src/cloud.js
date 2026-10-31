import { createHash } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { endpoint, MAX_BYTES, ID_PATTERN, readLimited } from './cloud-protocol.js';

export function cloudSettings(config = {}, env = process.env) {
  const server = endpoint(env.RESUME_SERVER || config.cloud?.server);
  const token = env.RESUME_TOKEN;
  if (!token || token.length < 32)
    throw new Error('Set RESUME_TOKEN to the team server access token (at least 32 characters).');
  return { server, token };
}
async function request(settings, suffix, options = {}) {
  const response = await fetch(`${endpoint(settings.server)}/v1/handoffs${suffix}`, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(60000),
    headers: { Authorization: `Bearer ${settings.token}`, ...options.headers },
  });
  if (!response.ok) {
    const body = await readLimited(response.body, 8192);
    let detail;
    try {
      detail = JSON.parse(body).error;
    } catch {}
    throw new Error(
      typeof detail === 'string' && detail
        ? detail.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
        : `Handoff server returned HTTP ${response.status}.`,
    );
  }
  return response;
}
export async function upload(settings, checkpoint) {
  const plain = Buffer.from(JSON.stringify(checkpoint));
  if (plain.length > MAX_BYTES)
    throw new Error('Handoff exceeds 32 MiB. Remove large artifacts and retry.');
  const body = await promisify(gzip)(plain);
  if (body.length > MAX_BYTES) throw new Error('Compressed handoff exceeds 32 MiB.');
  const response = await request(settings, '', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  });
  let result;
  try {
    result = JSON.parse(await readLimited(response.body, 8192));
  } catch {
    throw new Error('Server returned an invalid handoff receipt.');
  }
  if (
    typeof result?.id !== 'string' ||
    !ID_PATTERN.test(result.id) ||
    typeof result.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(result.expiresAt)) ||
    result.sha256 !== createHash('sha256').update(body).digest('hex')
  )
    throw new Error('Server returned an invalid handoff receipt.');
  return result;
}
export async function download(settings, id) {
  if (!ID_PATTERN.test(id)) throw new Error('Invalid cloud handoff ID.');
  const response = await request(settings, `/${id}`);
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body.cancel();
    throw new Error('Handoff exceeds 32 MiB.');
  }
  const body = await readLimited(response.body);
  if (response.headers.get('x-content-sha256') !== createHash('sha256').update(body).digest('hex'))
    throw new Error('Handoff integrity check failed.');
  return JSON.parse(await promisify(gunzip)(body, { maxOutputLength: MAX_BYTES }));
}
export async function revoke(settings, id) {
  if (!ID_PATTERN.test(id)) throw new Error('Invalid cloud handoff ID.');
  await request(settings, `/${id}`, { method: 'DELETE' });
}
