#!/usr/bin/env node

import { parseArguments } from './cli/arguments.js';
import { executeCommand } from './cli/commands.js';
import { printError } from './cli/output.js';

const args = process.argv.slice(2);
try {
  await executeCommand(parseArguments(args));
} catch (error) {
  printError(error, args.includes('--json'));
  process.exitCode = 1;
}
