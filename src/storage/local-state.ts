import fs from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function hasCode(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === code;
}

export function getConfigDir(override?: string): string {
  const selected = override || process.env.PLAYGROUND_CONFIG_DIR;
  if (selected) return path.resolve(selected);
  const base =
    process.env.XDG_CONFIG_HOME ||
    (process.platform === 'win32'
      ? process.env.LOCALAPPDATA || os.homedir()
      : path.join(os.homedir(), '.config'));
  return path.resolve(base, 'playground-vibes', 'cli');
}

// macOS exposes system-managed aliases for its temporary directories. Resolve
// only these known aliases; user-created symlinks are still rejected below.
async function canonicalPath(file: string): Promise<string> {
  const resolved = path.resolve(file);
  if (process.platform === 'darwin') {
    for (const alias of ['/var', '/tmp']) {
      if (resolved === alias || resolved.startsWith(alias + path.sep)) {
        const target = await fs.realpath(alias);
        if (target === '/private' + alias) return target + resolved.slice(alias.length);
      }
    }
  }
  return resolved;
}

async function checkAncestors(file: string, allowMissing = false): Promise<void> {
  let cursor = path.dirname(file);
  while (true) {
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink())
        throw new Error('Refusing symlinked Playground settings directories.');
      if (!stat.isDirectory()) throw new Error('A Playground settings parent is not a directory.');
    } catch (error) {
      if (!allowMissing || !hasCode(error, 'ENOENT')) throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

async function checkLeaf(file: string): Promise<void> {
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) throw new Error('Refusing a symlinked Playground settings file.');
    if (!stat.isFile()) throw new Error('Expected a regular Playground settings file.');
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
}

function assertPrivate(stat: Stats): void {
  if (
    process.platform !== 'win32' &&
    ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
  ) {
    throw new Error(
      'Playground credentials must belong to you and have private permissions (0600).',
    );
  }
}

async function readFileJSON<T>(
  file: string,
  fallback: T | undefined,
  privateFile: boolean,
): Promise<T> {
  const resolved = await canonicalPath(file);
  try {
    await checkAncestors(resolved);
    await checkLeaf(resolved);
    const handle = await fs.open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('Expected a regular Playground settings file.');
      if (privateFile) assertPrivate(stat);
      const content = await handle.readFile('utf8');
      try {
        return JSON.parse(content) as T;
      } catch {
        throw new Error(
          'Playground settings contain invalid JSON. Repair or remove the settings file before retrying.',
        );
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (hasCode(error, 'ENOENT') && fallback !== undefined) return fallback;
    throw error;
  }
}

export function readJSON<T>(file: string, fallback?: T): Promise<T> {
  return readFileJSON(file, fallback, false);
}

export function readPrivateJSON<T>(file: string, fallback?: T): Promise<T> {
  return readFileJSON(file, fallback, true);
}

async function ensureDirectory(directory: string): Promise<void> {
  // Check before mkdir as well, so a symlink cannot redirect directory creation.
  await checkAncestors(path.join(directory, '.settings-check'), true);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await checkAncestors(path.join(directory, '.settings-check'));
}

export async function writeJSON(file: string, value: unknown): Promise<void> {
  const resolved = await canonicalPath(file);
  const directory = path.dirname(resolved);
  await ensureDirectory(directory);
  await checkLeaf(resolved);
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) throw new Error('Playground settings must contain a JSON value.');
  const temporary = resolved + '.' + randomUUID();
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(serialized + '\n', 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await checkAncestors(resolved);
    await checkLeaf(resolved);
    await fs.rename(temporary, resolved);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function withLock<T>(configDir: string, action: () => Promise<T>): Promise<T> {
  const directory = await canonicalPath(configDir);
  await ensureDirectory(directory);
  const lock = path.join(directory, 'command.lock');
  try {
    await fs.mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (hasCode(error, 'EEXIST')) {
      throw new Error(
        `Another Playground command is running. If it crashed and no command is active, remove ${lock} and retry.`,
      );
    }
    throw error;
  }
  try {
    return await action();
  } finally {
    await fs.rmdir(lock);
  }
}
