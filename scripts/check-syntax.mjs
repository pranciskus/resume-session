import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
for (const directory of ['bin', 'src', 'scripts']) {
  for (const name of await fs.readdir(directory, { recursive: true })) {
    if (/\.(js|mjs)$/.test(name))
      execFileSync(process.execPath, ['--check', `${directory}/${name}`], { stdio: 'inherit' });
  }
}
