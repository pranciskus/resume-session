export const resumeOptions = Object.fromEntries(
  ['help', 'json', 'dry-run', 'handoff', 'history-only', 'prepare', 'here', 'all']
    .map((key) => [key, { type: 'boolean' }])
    .concat(
      ['session', 'search', 'cwd', 'path', 'tool', 'root'].map((key) => [key, { type: 'string' }]),
    ),
);

// Resume consumes its own options; other flags and their values retain their
// order for the target agent. An explicit -- forwards everything after it.
export function splitArgs(raw) {
  const args = [],
    extra = [];
  let command;
  for (let index = 0; index < raw.length; index++) {
    const token = raw[index];
    if (token === '--') {
      extra.push(...raw.slice(index + 1));
      break;
    }
    const key = token.startsWith('--') ? token.slice(2).split('=')[0] : undefined;
    if (key && Object.hasOwn(resumeOptions, key)) {
      args.push(token);
      if (resumeOptions[key].type === 'string' && !token.includes('=') && index + 1 < raw.length)
        args.push(raw[++index]);
    } else if (
      !token.startsWith('-') &&
      (!command || ['source', 'target', 'drive'].includes(command))
    ) {
      command ||= token;
      args.push(token);
    } else {
      extra.push(token);
    }
  }
  return { args, extra };
}
