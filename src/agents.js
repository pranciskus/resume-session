export const tools = ['claude', 'codex', 'gemini', 'opencode'];
export const envKeys = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  gemini: 'GEMINI_CLI_HOME',
  opencode: 'XDG_DATA_HOME',
};

const commands = new Set(['list', 'source', 'target', 'share', 'drive']);
export function validTargetName(name) {
  return (
    typeof name === 'string' &&
    /^[\w.][\w.-]*$/.test(name) &&
    !['.', '..', '__proto__', 'prototype', 'constructor'].includes(name) &&
    !name.startsWith('rs_') &&
    !commands.has(name)
  );
}
