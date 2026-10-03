/** Validated commands. Parsing finishes before any account or project operation. */
export interface DeployArguments {
  name: 'deploy';
  dryRun: boolean;
  json: boolean;
  consent?: string;
  noWait?: boolean;
}

export type CLICommand =
  | { name: 'help' | 'version' | 'whoami' | 'logout' | 'skill-path' }
  | { name: 'login'; noBrowser: boolean }
  | { name: 'connect'; code: string }
  | { name: 'status'; wait: boolean; json: boolean; versionId?: string }
  | {
      name: 'skill-install';
      directory?: string;
      claude: boolean;
      allowClaudeCommands: boolean;
      codex: boolean;
      allowCodexCommands: boolean;
      packageManager?: 'npm' | 'pnpm';
      /** Pairing code redeemed before installing, so the CLI starts connected. */
      pairingCode?: string;
    }
  | DeployArguments;

export interface CLIArguments {
  configDir?: string;
  command: CLICommand;
  /** Unrecognized --options that were ignored rather than treated as errors. */
  warnings?: string[];
}

/** Ignore unrecognized long options with a warning; anything else is still an error. */
function ignoreUnknown(argument: string, command: string, warnings: string[]): void {
  if (!argument.startsWith('--') || argument === '--') {
    throw new Error(`Unexpected argument for ${command}: ${argument}`);
  }
  warnings.push(`Ignoring unrecognized option for ${command}: ${argument}`);
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

function requireNoArguments(args: string[], command: string, warnings: string[]): void {
  for (const argument of args) ignoreUnknown(argument, command, warnings);
}

function parseSkill(args: string[], warnings: string[]): CLICommand {
  const [action, ...rest] = args;
  if (action === 'path') {
    requireNoArguments(rest, 'skill path', warnings);
    return { name: 'skill-path' };
  }
  if (action !== 'install')
    throw new Error(
      'Expected "skill path" or "skill install [--path DIR] [--claude|--codex] [--allow-claude-commands|--allow-codex-commands] [--package-manager npm|pnpm] [--pairing-code CODE]".',
    );
  let directory: string | undefined;
  let claude = false;
  let allowClaudeCommands = false;
  let codex = false;
  let allowCodexCommands = false;
  let packageManager: 'npm' | 'pnpm' | undefined;
  let pairingCode: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (argument === '--claude') {
      if (claude) throw new Error('--claude may only be specified once.');
      claude = true;
    } else if (argument === '--allow-claude-commands') {
      if (allowClaudeCommands)
        throw new Error('--allow-claude-commands may only be specified once.');
      allowClaudeCommands = true;
    } else if (argument === '--codex') {
      if (codex) throw new Error('--codex may only be specified once.');
      codex = true;
    } else if (argument === '--allow-codex-commands') {
      if (allowCodexCommands) throw new Error('--allow-codex-commands may only be specified once.');
      allowCodexCommands = true;
    } else if (argument === '--path' || argument.startsWith('--path=')) {
      if (directory !== undefined) throw new Error('--path may only be specified once.');
      const parsed = takeValue(rest, index, '--path');
      directory = parsed.value;
      index = parsed.index;
    } else if (argument === '--package-manager' || argument.startsWith('--package-manager=')) {
      if (packageManager !== undefined)
        throw new Error('--package-manager may only be specified once.');
      const parsed = takeValue(rest, index, '--package-manager');
      if (parsed.value !== 'npm' && parsed.value !== 'pnpm') {
        throw new Error('--package-manager must be npm or pnpm.');
      }
      packageManager = parsed.value;
      index = parsed.index;
    } else if (argument === '--pairing-code' || argument.startsWith('--pairing-code=')) {
      if (pairingCode !== undefined) throw new Error('--pairing-code may only be specified once.');
      const parsed = takeValue(rest, index, '--pairing-code');
      if (!/^[A-Z2-9]{8}$/.test(parsed.value.trim().toUpperCase().replace(/-/g, ''))) {
        throw new Error('--pairing-code must be the eight-character pairing code from Playground.');
      }
      pairingCode = parsed.value;
      index = parsed.index;
    } else {
      ignoreUnknown(argument, 'skill install', warnings);
    }
  }
  if (claude && codex) {
    throw new Error('--claude and --codex cannot be combined; run skill install once for each.');
  }
  if (allowClaudeCommands && !claude) {
    throw new Error('--allow-claude-commands requires --claude.');
  }
  if (allowCodexCommands && !codex) {
    throw new Error('--allow-codex-commands requires --codex.');
  }
  if (packageManager !== undefined && !claude && !codex) {
    throw new Error('--package-manager requires --claude or --codex.');
  }
  return {
    name: 'skill-install',
    directory,
    claude,
    allowClaudeCommands,
    codex,
    allowCodexCommands,
    packageManager,
    pairingCode,
  };
}

function parseDeploy(args: string[], warnings: string[]): DeployArguments {
  let dryRun = false;
  let json = false;
  let consent: string | undefined;
  let noWait = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--dry-run') {
      if (dryRun) throw new Error('--dry-run may only be specified once.');
      dryRun = true;
    } else if (argument === '--json') {
      if (json) throw new Error('--json may only be specified once.');
      json = true;
    } else if (argument === '--consent' || argument.startsWith('--consent=')) {
      if (consent !== undefined) throw new Error('--consent may only be specified once.');
      const parsed = takeValue(args, index, '--consent');
      consent = parsed.value;
      index = parsed.index;
    } else if (argument === '--no-wait') noWait = true;
    else ignoreUnknown(argument, 'deploy', warnings);
  }
  if (dryRun && consent !== undefined)
    throw new Error('--dry-run cannot be combined with --consent.');
  return { name: 'deploy', dryRun, json, consent, ...(noWait ? { noWait: true } : {}) };
}

/** Parse flags and positional arguments without reading files or starting I/O. */
export function parseArguments(args: string[]): CLIArguments {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    return { command: { name: 'help' } };
  }
  const parsed = parseGlobals(args);
  const warnings: string[] = [];
  const positional = [...parsed.args];
  while (positional[0]?.startsWith('--') && positional[0] !== '--version') {
    ignoreUnknown(positional.shift()!, 'playgroundvibes', warnings);
  }
  const [name, ...rest] = positional;
  let command: CLICommand;
  switch (name) {
    case '--version':
    case '-v':
      requireNoArguments(rest, name, warnings);
      command = { name: 'version' };
      break;
    case 'skill':
      command = parseSkill(rest, warnings);
      break;
    case 'login': {
      let noBrowser = false;
      for (const argument of rest) {
        if (argument === '--no-browser' && !noBrowser) noBrowser = true;
        else if (argument === '--no-browser' || !argument.startsWith('--')) {
          throw new Error('Usage: playgroundvibes login [--no-browser]');
        } else ignoreUnknown(argument, name, warnings);
      }
      command = { name, noBrowser };
      break;
    }
    case 'connect': {
      const positional: string[] = [];
      for (const argument of rest) {
        if (argument.startsWith('--')) ignoreUnknown(argument, name, warnings);
        else positional.push(argument);
      }
      if (positional.length !== 1 || !positional[0] || positional[0].startsWith('-')) {
        throw new Error('Usage: playgroundvibes connect CODE');
      }
      command = { name, code: positional[0] };
      break;
    }
    case 'whoami':
    case 'logout':
      requireNoArguments(rest, name, warnings);
      command = { name };
      break;
    case 'deploy':
      command = parseDeploy(rest, warnings);
      break;
    case 'status': {
      let wait = false,
        json = false,
        versionId: string | undefined;
      for (let index = 0; index < rest.length; index++) {
        const argument = rest[index]!;
        if (argument === '--wait') wait = true;
        else if (argument === '--json') json = true;
        else if (argument === '--version-id' || argument.startsWith('--version-id=')) {
          const parsed = takeValue(rest, index, '--version-id');
          versionId = parsed.value;
          index = parsed.index;
        } else ignoreUnknown(argument, 'status', warnings);
      }
      command = { name: 'status', wait, json, ...(versionId ? { versionId } : {}) };
      break;
    }
    default:
      throw new Error(`Unknown command: ${name ?? '(missing)'}. Run playgroundvibes --help.`);
  }
  return { configDir: parsed.configDir, command, warnings };
}
