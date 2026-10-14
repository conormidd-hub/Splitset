// Starts the Expo web dev server from the app folder on the port the Claude preview tool
// assigns via PORT (see the repo-root .claude/launch.json). Without PORT, Expo picks its default.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = ['expo', 'start', '--web'];
if (process.env.PORT) args.push('--port', process.env.PORT);
const result = spawnSync('npx', args, { cwd: appDir, stdio: 'inherit', env: process.env, shell: process.platform === 'win32' });
process.exit(result.status ?? 1);
