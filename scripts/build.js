import { chmod, rm } from 'node:fs/promises';
import { runPackageBin } from './run-node.js';

const root = new URL('../', import.meta.url);

// Check formatting before changing an existing build.
runPackageBin('prettier', 'prettier', ['--check', '.']);

// Moved or deleted source modules must never survive in an npm tarball.
await rm(new URL('dist/', root), { recursive: true, force: true });
runPackageBin('typescript', 'tsc', ['-p', 'tsconfig.json']);
await chmod(new URL('dist/cli.js', root), 0o755);
