import fs from 'node:fs/promises';
import path from 'node:path';

export function safeRelative(name) {
  if (
    typeof name !== 'string' ||
    !name ||
    name.length > 1024 ||
    /[\\\x00-\x1f\x7f:<>"|?*]/.test(name) ||
    name.startsWith('/')
  )
    throw new Error('Unsafe checkpoint path.');
  for (const part of name.split('/')) {
    if (
      !part ||
      part === '.' ||
      part === '..' ||
      /[. ]$/.test(part) ||
      /^(\.git|\.resume)$/i.test(part) ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)
    )
      throw new Error(`Unsupported checkpoint path: ${name}`);
  }
  return name;
}
export function secretCheck(name, text) {
  if (
    /(^|\/)(\.env(?:\..*)?|id_rsa|id_ed25519|credentials\.json)$/i.test(name) &&
    !/\.(example|sample|template)$/i.test(name)
  )
    throw new Error(
      `Potential credential file ${name}; remove it from the checkpoint before sharing.`,
    );
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-ant-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})/.test(
      text,
    )
  )
    throw new Error(`Potential secret in ${name}; redact it before sharing.`);
}
export async function checkParents(root, relative) {
  let directory = root;
  for (const part of relative.split('/').slice(0, -1)) {
    directory = path.join(directory, part);
    try {
      if (!(await fs.lstat(directory)).isDirectory())
        throw new Error(`Unsafe parent directory for ${relative}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
