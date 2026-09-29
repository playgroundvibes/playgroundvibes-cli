/** Validated commands. Parsing finishes before any account or project operation. */
export interface DeployArguments {
  name: 'deploy';
  dryRun: boolean;
  json: boolean;
  consent?: string;
}

export type CLICommand =
  | { name: 'help' | 'version' | 'whoami' | 'logout' | 'skill-path' }
  | { name: 'login'; noBrowser: boolean }
  | { name: 'connect'; code: string }
  | { name: 'skill-install'; directory?: string }
  | DeployArguments;

export interface CLIArguments {
  configDir?: string;
  command: CLICommand;
}

function takeValue(args: string[], index: number, flag: string): { value: string; index: number } {
  const argument = args[index]!;
  const value = argument.startsWith(`${flag}=`) ? argument.slice(flag.length + 1) : args[++index];
  if (!value || (!argument.includes('=') && value.startsWith('-'))) {
    throw new Error(`${flag} requires a value.`);
  }
  return { value, index };
}

function parseGlobals(args: string[]): { configDir?: string; args: string[] } {
  let configDir: string | undefined;
  const remaining: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--config-dir' || argument.startsWith('--config-dir=')) {
      if (configDir !== undefined) throw new Error('--config-dir may only be specified once.');
      const parsed = takeValue(args, index, '--config-dir');
      configDir = parsed.value;
      index = parsed.index;
    } else {
      remaining.push(argument);
    }
  }
  return { configDir, args: remaining };
}

function requireNoArguments(args: string[], command: string): void {
  if (args.length > 0) throw new Error(`Unexpected argument for ${command}: ${args[0]}`);
}

function parseSkill(args: string[]): CLICommand {
  const [action, ...rest] = args;
  if (action === 'path') {
    requireNoArguments(rest, 'skill path');
    return { name: 'skill-path' };
  }
  if (action !== 'install')
    throw new Error('Expected "skill path" or "skill install [--path DIR]".');
  let directory: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (argument !== '--path' && !argument.startsWith('--path=')) {
      throw new Error(`Unexpected argument for skill install: ${argument}`);
    }
    if (directory !== undefined) throw new Error('--path may only be specified once.');
    const parsed = takeValue(rest, index, '--path');
    directory = parsed.value;
    index = parsed.index;
  }
  return { name: 'skill-install', directory };
}

function parseDeploy(args: string[]): DeployArguments {
  let dryRun = false;
  let json = false;
  let consent: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--dry-run' && !dryRun) dryRun = true;
    else if (argument === '--json' && !json) json = true;
    else if (argument === '--consent' || argument.startsWith('--consent=')) {
      if (consent !== undefined) throw new Error('--consent may only be specified once.');
      const parsed = takeValue(args, index, '--consent');
      consent = parsed.value;
      index = parsed.index;
    } else throw new Error(`Unexpected argument for deploy: ${argument}`);
  }
  if (dryRun && consent !== undefined)
    throw new Error('--dry-run cannot be combined with --consent.');
  return { name: 'deploy', dryRun, json, consent };
}

/** Parse flags and positional arguments without reading files or starting I/O. */
export function parseArguments(args: string[]): CLIArguments {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    return { command: { name: 'help' } };
  }
  const parsed = parseGlobals(args);
  const [name, ...rest] = parsed.args;
  let command: CLICommand;
  switch (name) {
    case '--version':
    case '-v':
      requireNoArguments(rest, name);
      command = { name: 'version' };
      break;
    case 'skill':
      command = parseSkill(rest);
      break;
    case 'login':
      if (rest.length > 1 || (rest.length === 1 && rest[0] !== '--no-browser')) {
        throw new Error('Usage: playgroundvibes login [--no-browser]');
      }
      command = { name, noBrowser: rest.includes('--no-browser') };
      break;
    case 'connect':
      if (rest.length !== 1 || !rest[0] || rest[0].startsWith('-')) {
        throw new Error('Usage: playgroundvibes connect CODE');
      }
      command = { name, code: rest[0] };
      break;
    case 'whoami':
    case 'logout':
      requireNoArguments(rest, name);
      command = { name };
      break;
    case 'deploy':
      command = parseDeploy(rest);
      break;
    default:
      throw new Error(`Unknown command: ${name ?? '(missing)'}. Run playgroundvibes --help.`);
  }
  return { configDir: parsed.configDir, command };
}
