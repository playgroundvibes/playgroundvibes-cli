import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export type SkillPackageManager = 'npm' | 'pnpm';

export interface GlobalCLIResult {
  readonly packageManager: SkillPackageManager;
  readonly version: string;
  readonly installed: boolean;
}

const PACKAGE_NAME = '@playgroundvibes/cli';
const PUBLIC_REGISTRY = 'https://registry.npmjs.org/';
const MAX_COMMAND_OUTPUT = 1024 * 1024;

interface CommandOptions {
  readonly install?: boolean;
  readonly windowsScript?: boolean;
}

class CommandFailure extends Error {
  constructor(
    executable: string,
    readonly exitCode: number | null,
    readonly output: string,
  ) {
    super(
      `${executable} did not complete successfully. Check its installation, permissions, and configuration.`,
    );
  }
}

function runCommand(
  executable: string,
  args: string[],
  cwd: string,
  options: CommandOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    // .cmd files require cmd.exe. Every script name and argument here is a fixed
    // command/flag or the validated package version; no path enters command text.
    const windowsScript = process.platform === 'win32' && options.windowsScript;
    const command = windowsScript ? process.env.ComSpec || 'cmd.exe' : executable;
    const commandArgs = windowsScript ? ['/d', '/s', '/c', [executable, ...args].join(' ')] : args;
    const child = spawn(command, commandArgs, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.install ? 300_000 : 30_000,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (options.install) process.stderr.write(chunk);
      else {
        size += chunk.length;
        if (size > MAX_COMMAND_OUTPUT) {
          oversized = true;
          child.kill();
        } else chunks.push(chunk);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (options.install) process.stderr.write(chunk);
    });
    child.once('error', () =>
      reject(new Error(`Could not run ${executable}. Check that it is installed and on PATH.`)),
    );
    child.once('close', (code, signal) => {
      if (oversized) reject(new Error('Package-manager output exceeded the permitted size.'));
      else if (code !== 0 || signal)
        reject(new CommandFailure(executable, code, Buffer.concat(chunks).toString('utf8').trim()));
      else resolve(Buffer.concat(chunks).toString('utf8').trim());
    });
  });
}

function runManager(
  manager: SkillPackageManager,
  args: string[],
  cwd: string,
  install = false,
): Promise<string> {
  const executable = process.platform === 'win32' ? `${manager}.cmd` : manager;
  return runCommand(executable, args, cwd, { install, windowsScript: true });
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function ownVersion(): Promise<string> {
  const manifest: unknown = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  if (
    !object(manifest) ||
    manifest.name !== PACKAGE_NAME ||
    typeof manifest.version !== 'string' ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      manifest.version,
    )
  ) {
    throw new Error('The installed Playground package has an invalid name or version.');
  }
  return manifest.version;
}

async function globalPackage(
  manager: SkillPackageManager,
  cwd: string,
): Promise<{ version: string; directory: string } | undefined> {
  let output: string;
  let missingOnly = false;
  try {
    output = await runManager(
      manager,
      ['list', '--global', '--depth', '0', '--json', PACKAGE_NAME],
      cwd,
    );
  } catch (error) {
    // npm ls reports a missing filtered package as status 1 with valid JSON.
    // Accept that status only after confirming the inventory has no target.
    if (manager !== 'npm' || !(error instanceof CommandFailure) || error.exitCode !== 1)
      throw error;
    output = error.output;
    missingOnly = true;
  }
  let inventory: unknown;
  try {
    inventory = JSON.parse(output);
  } catch {
    throw new Error(`${manager} returned invalid global package inventory.`);
  }
  if (manager === 'pnpm' && !Array.isArray(inventory))
    throw new Error('pnpm returned invalid global package inventory.');
  const entries: unknown[] = manager === 'pnpm' ? (inventory as unknown[]) : [inventory];
  const matches: unknown[] = [];
  for (const entry of entries) {
    if (
      !object(entry) ||
      entry.error !== undefined ||
      (Array.isArray(entry.problems) && entry.problems.length)
    )
      throw new Error(`${manager} returned invalid global package inventory.`);
    if (entry.dependencies === undefined) {
      if (manager === 'npm' && typeof entry.name !== 'string' && typeof entry.path !== 'string')
        throw new Error('npm returned invalid global package inventory.');
      continue;
    }
    if (!object(entry.dependencies))
      throw new Error(`${manager} returned invalid global package inventory.`);
    if (entry.dependencies[PACKAGE_NAME] !== undefined)
      matches.push(entry.dependencies[PACKAGE_NAME]);
  }
  if (matches.length === 0) return undefined;
  if (missingOnly || matches.length !== 1)
    throw new Error(
      `${manager} could not unambiguously verify its global Playground installation.`,
    );
  const dependency = matches[0];
  if (!object(dependency) || typeof dependency.version !== 'string')
    throw new Error(`${manager} returned invalid global package inventory.`);
  const directory =
    manager === 'pnpm'
      ? dependency.path
      : path.join(await runManager(manager, ['root', '--global'], cwd), PACKAGE_NAME);
  if (typeof directory !== 'string' || !path.isAbsolute(directory))
    throw new Error(`${manager} did not identify an absolute global package location.`);
  return { version: dependency.version, directory };
}

async function normalizedDirectory(directory: string): Promise<string> {
  const resolved = await realpath(directory).catch(() => path.resolve(directory));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function globalBin(manager: SkillPackageManager, cwd: string): Promise<string> {
  let directory: string;
  try {
    const location = await runManager(
      manager,
      manager === 'pnpm' ? ['bin', '--global'] : ['prefix', '--global'],
      cwd,
    );
    if (!path.isAbsolute(location)) throw new Error();
    directory =
      manager === 'npm' && process.platform !== 'win32' ? path.join(location, 'bin') : location;
  } catch {
    throw new Error(
      manager === 'pnpm'
        ? 'pnpm global commands are not configured. Run pnpm setup yourself, reopen the terminal, and retry; Claude permissions were not added.'
        : 'Could not locate npm global commands. Check npm prefix --global and your PATH, then retry; Claude permissions were not added.',
    );
  }
  const expected = await normalizedDirectory(directory);
  const pathEntries = await Promise.all(
    (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(normalizedDirectory),
  );
  if (!pathEntries.includes(expected))
    throw new Error(
      `The ${manager} global command directory is not on PATH. Add ${directory} to PATH yourself and reopen the terminal before retrying; Claude permissions were not added.`,
    );
  return directory;
}

async function verifyGlobalCLI(
  manager: SkillPackageManager,
  version: string,
  binDirectory: string,
  cwd: string,
): Promise<void> {
  const installed = await globalPackage(manager, cwd);
  if (!installed || installed.version !== version)
    throw new Error(
      `The ${manager} global installation of ${PACKAGE_NAME}@${version} could not be verified.`,
    );
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(path.join(installed.directory, 'package.json'), 'utf8'));
  } catch {
    throw new Error('The global Playground package manifest could not be read.');
  }
  if (
    !object(manifest) ||
    manifest.name !== PACKAGE_NAME ||
    manifest.version !== version ||
    !object(manifest.bin) ||
    (manifest.bin.playgroundvibes !== './dist/cli.js' &&
      manifest.bin.playgroundvibes !== 'dist/cli.js')
  )
    throw new Error('The global Playground package does not match this installer.');
  const filename = process.platform === 'win32' ? 'playgroundvibes.cmd' : 'playgroundvibes';
  const executable = path.join(binDirectory, filename);
  if (!(await stat(executable).catch(() => undefined))?.isFile())
    throw new Error(
      'The global playgroundvibes command is missing. Reinstall it with your selected package manager.',
    );
  // On Windows the current directory selects this exact global .cmd wrapper,
  // while keeping arbitrary directory names out of cmd.exe command text.
  const actualVersion =
    process.platform === 'win32'
      ? await runCommand(`.\\${filename}`, ['--version'], binDirectory, { windowsScript: true })
      : await runCommand(executable, ['--version'], cwd);
  if (actualVersion !== version)
    throw new Error(
      'The global playgroundvibes command reports a different version. Reinstall it before granting Claude command permissions.',
    );
}

/** Ensure the exact running release has a usable global command before granting command permission. */
export async function ensureGlobalCLI(
  packageManager?: SkillPackageManager,
): Promise<GlobalCLIResult> {
  if (packageManager !== undefined && packageManager !== 'npm' && packageManager !== 'pnpm')
    throw new TypeError('packageManager must be npm or pnpm');
  const manager =
    packageManager ?? (/^pnpm\//.test(process.env.npm_config_user_agent ?? '') ? 'pnpm' : 'npm');
  const version = await ownVersion();
  const directory = await mkdtemp(path.join(tmpdir(), 'playground-global-cli-'));
  try {
    const binDirectory = await globalBin(manager, directory);
    const current = await globalPackage(manager, directory);
    const installed = current?.version !== version;
    if (installed) {
      await runManager(
        manager,
        [
          manager === 'pnpm' ? 'add' : 'install',
          '--global',
          `${PACKAGE_NAME}@${version}`,
          '--ignore-scripts',
          `--registry=${PUBLIC_REGISTRY}`,
        ],
        directory,
        true,
      );
    }
    await verifyGlobalCLI(manager, version, binDirectory, directory);
    return { packageManager: manager, version, installed };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
