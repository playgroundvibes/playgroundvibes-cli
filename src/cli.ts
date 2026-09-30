#!/usr/bin/env node

import { parseArguments } from './cli/arguments.js';
import { executeCommand } from './cli/commands.js';
import { printError } from './cli/output.js';

const args = process.argv.slice(2);
try {
  const parsed = parseArguments(args);
  for (const warning of parsed.warnings ?? []) process.stderr.write(`Warning: ${warning}\n`);
  await executeCommand(parsed);
} catch (error) {
  printError(error, args.includes('--json'));
  process.exitCode = 1;
}
