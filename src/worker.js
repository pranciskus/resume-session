// Each account gets a separate process: upstream parsers capture environment at import time.
import { adapters } from 'continues';
// Pinned continues version: its public adapter accepts config, but presets are internal.
const { getPreset } = await import(new URL('./config/index.js', import.meta.resolve('continues')));
process.once('message', async ({ action, tool, session }) => {
  try {
    const adapter = adapters[tool];
    if (!adapter) throw new Error(`Unsupported agent: ${tool}`);
    const config = getPreset('full');
    // Keep every parsed conversation message for the archive, while the entry
    // document stays bounded. Tool samples and compact summaries retain their
    // upstream limits; this is not a lossless native-session conversion.
    config.recentMessages = Number.MAX_SAFE_INTEGER;
    config.handoff.timelineWindow = 50;
    const result =
      action === 'list'
        ? await adapter.parseSessions({ lightweight: true })
        : await adapter.extractContext(
            {
              ...session,
              createdAt: new Date(session.createdAt),
              updatedAt: new Date(session.updatedAt),
            },
            config,
          );
    if (action === 'context' && typeof result.markdown === 'string') {
      // The upstream overview calls every directory a repository, including
      // research and Drive folders. Keep our generated heading neutral;
      // conversation messages themselves remain unchanged.
      result.markdown = result.markdown.replace(/^\| \*\*Repository\*\* \|/m, '| **Workspace** |');
    }
    process.send({ result }, () => process.disconnect());
  } catch (error) {
    process.send({ error: error.message }, () => process.disconnect());
  }
});
