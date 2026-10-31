import { spinner } from '@clack/prompts';

// Keep machine-readable output clean and never animate over an agent's terminal.
export function createProgress({
  output = process.stderr,
  enabled = Boolean(output.isTTY),
  delay = 150,
  makeSpinner = spinner,
} = {}) {
  return async function progress(message, operation) {
    if (!enabled) return operation();
    let indicator;
    const timer = setTimeout(() => {
      indicator = makeSpinner({
        output,
        withGuide: false,
        indicator: 'timer',
        onCancel: () => process.exit(130),
      });
      indicator.start(message);
    }, delay);
    try {
      return await operation();
    } finally {
      clearTimeout(timer);
      indicator?.clear();
    }
  };
}
