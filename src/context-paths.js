export const PROJECT_ROOT = '{{RESUME_PROJECT_ROOT}}';

function replaceRoot(text, from, to) {
  if (!from || from === to) return text;
  // Tokens are explicit. Source paths need boundaries: /work/job must never
  // rewrite /work/job-backup, /work/jobs, or /other/work/job.
  if (from === PROJECT_ROOT) return text.split(from).join(to);
  let output = '',
    cursor = 0;
  for (let index = text.indexOf(from); index !== -1; index = text.indexOf(from, cursor)) {
    const end = index + from.length;
    const before = text[index - 1],
      after = text[end];
    const startsUrl = before === ':' && /[A-Za-z][A-Za-z0-9+.-]*:$/.test(text.slice(0, index));
    const startBoundary = !startsUrl && (index === 0 || /[\s"'`(\[<{=:]/.test(before));
    const rootSeparator = /[/\\]$/.test(from) ? from.at(-1) : '';
    const endBoundary =
      rootSeparator ||
      end === text.length ||
      /[/\\\s"'`)\]}>;,!?]/.test(after) ||
      (after === ':' && /\d/.test(text[end + 1] || '')) ||
      (after === '.' && (end + 1 === text.length || /[\s"'`)]/.test(text[end + 1])));
    const replacement =
      to +
      (rootSeparator && end < text.length && !/[\s"'`)\]}>;,!?]/.test(after) ? rootSeparator : '');
    output += text.slice(cursor, index) + (startBoundary && endBoundary ? replacement : from);
    cursor = end;
  }
  return output + text.slice(cursor);
}

export function mapContextStrings(value, from, to) {
  if (typeof value === 'string') return replaceRoot(value, from, to);
  if (Array.isArray(value)) return value.map((item) => mapContextStrings(item, from, to));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, mapContextStrings(item, from, to)]),
    );
  }
  return value;
}
