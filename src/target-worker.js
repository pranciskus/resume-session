import { parentPort, workerData } from 'node:worker_threads';
import { resolveTarget } from './core.js';
try {
  parentPort.postMessage({
    target: resolveTarget(workerData.name, workerData.config, { inspectKnown: true }),
  });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
