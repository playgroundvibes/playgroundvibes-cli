import { runNode, runPackageBin } from './run-node.js';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--tests-only')) {
  throw new Error('Usage: node scripts/check.js [--tests-only]');
}

runNode(['scripts/build.js']);
runPackageBin('typescript', 'tsc', ['-p', 'test/types/tsconfig.json']);
// Node expands this glob on every supported platform, including Windows.
runNode(['--test', 'test/*.test.mjs']);
if (!args.includes('--tests-only')) runNode(['scripts/check-package.js']);
