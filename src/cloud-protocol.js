export const MAX_BYTES = 32 * 1024 * 1024;
export const ID_PATTERN = /^rs_[A-Za-z0-9_-]{24}$/;
export const FORMAT = 'resume-handoff/1';

export class PayloadTooLargeError extends Error {
  constructor(limit) {
    const unit = limit >= 1024 * 1024 ? `${limit / 1024 / 1024} MiB` : `${limit} bytes`;
    super(`Handoff exceeds the ${unit} limit.`);
    this.name = 'PayloadTooLargeError';
    this.code = 'PAYLOAD_TOO_LARGE';
  }
}

export function endpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Set RESUME_SERVER to your handoff server URL.');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('RESUME_SERVER must be an origin without credentials, query, or path.');
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw new Error('Use HTTPS for a remote handoff server (HTTP is allowed only on localhost).');
  return url.origin;
}

export async function readLimited(stream, limit = MAX_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new PayloadTooLargeError(limit);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
