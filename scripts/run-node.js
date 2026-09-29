import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

export function runNode(args) {
  execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
}

// Resolve the installed entry point without relying on npm, shell shims, or hoisting.
export function runPackageBin(packageName, binName, args) {
  const manifestPath = require.resolve(`${packageName}/package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[binName];
  runNode([resolve(dirname(manifestPath), entry), ...args]);
}
