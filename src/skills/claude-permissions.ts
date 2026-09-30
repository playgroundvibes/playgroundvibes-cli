import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { link, lstat, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { ensureDirectory, errorCode } from './filesystem.js';

/** Read-only commands Claude may run without asking. */
export const CLAUDE_ALLOW_PERMISSIONS: readonly string[] = Object.freeze([
  'Bash(playgroundvibes whoami:*)',
  'Bash(playgroundvibes --version)',
  'Bash(playgroundvibes --help)',
  'Bash(playgroundvibes skill path:*)',
]);

/**
 * Deploys always ask, so an agent cannot approve its own publication with the
 * printed `deploy --consent DIGEST` command. Ask rules take precedence over allow rules.
 */
export const CLAUDE_ASK_PERMISSIONS: readonly string[] = Object.freeze([
  'Bash(playgroundvibes deploy:*)',
]);

/** The broad rule written by 0.1.5 and earlier; it also allowed consented deploys. */
export const LEGACY_CLAUDE_COMMAND_PERMISSION = 'Bash(playgroundvibes:*)';

export interface ClaudePermissionResult {
  readonly path: string;
  /** True when settings were changed. */
  readonly added: boolean;
  readonly allow: readonly string[];
  readonly ask: readonly string[];
  /** Legacy rules removed from permissions.allow. */
  readonly removed: readonly string[];
}

export interface ClaudePermissionPlan {
  apply(): Promise<ClaudePermissionResult>;
}

type Settings = Record<string, unknown>;

interface SettingsSnapshot {
  readonly contents?: Buffer;
  readonly stat?: Stats;
  readonly settings: Settings;
}

function isObject(value: unknown): value is Settings {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseSettings(contents: Buffer): Settings {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents));
  } catch {
    throw new Error(
      'Claude settings must contain valid UTF-8 JSON. Existing settings were preserved.',
    );
  }
  if (!isObject(value)) throw new Error('Claude settings must be a JSON object.');
  if (value.permissions !== undefined) {
    if (!isObject(value.permissions))
      throw new Error('Claude settings permissions must be an object.');
    for (const name of ['allow', 'ask', 'deny']) {
      const rules = value.permissions[name];
      if (
        rules !== undefined &&
        (!Array.isArray(rules) || rules.some((rule) => typeof rule !== 'string'))
      ) {
        throw new Error(`Claude settings permissions.${name} must be an array of strings.`);
      }
    }
  }
  return value;
}

/** Validate existing ancestors without creating anything during preparation. */
async function checkDirectories(filename: string): Promise<void> {
  let directory = path.dirname(filename);
  while (true) {
    try {
      const stat = await lstat(directory);
      if (stat.isSymbolicLink()) throw new Error('Refusing symlinked Claude settings directories.');
      if (!stat.isDirectory()) throw new Error('A Claude settings parent is not a directory.');
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.mode === right.mode
  );
}

function settingsChanged(): Error {
  return new Error(
    'Claude settings changed during installation. Existing settings were preserved; retry the command.',
  );
}

async function readSettings(filename: string): Promise<SettingsSnapshot> {
  await checkDirectories(filename);
  let before: Stats;
  try {
    before = await lstat(filename);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { settings: {} };
    throw error;
  }
  if (before.isSymbolicLink()) throw new Error('Refusing a symlinked Claude settings file.');
  if (!before.isFile()) throw new Error('Expected a regular Claude settings file.');
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(before, opened)) throw settingsChanged();
    const contents = await handle.readFile();
    const after = await handle.stat();
    if (!sameFile(opened, after)) throw settingsChanged();
    return { contents, stat: after, settings: parseSettings(contents) };
  } finally {
    await handle.close();
  }
}

async function assertUnchanged(filename: string, original: SettingsSnapshot): Promise<void> {
  const current = await readSettings(filename);
  if (!original.stat && !current.stat) return;
  if (
    !original.stat ||
    !current.stat ||
    !sameFile(original.stat, current.stat) ||
    !original.contents!.equals(current.contents!)
  )
    throw settingsChanged();
}

async function writeSettings(
  filename: string,
  original: SettingsSnapshot,
  settings: Settings,
): Promise<void> {
  await ensureDirectory(path.dirname(filename));
  await assertUnchanged(filename, original);
  const temporary = path.join(
    path.dirname(filename),
    `.settings.local.json.playground-${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temporary, 'wx', original.stat ? original.stat.mode & 0o777 : 0o600);
    try {
      await handle.writeFile(JSON.stringify(settings, null, 2) + '\n', 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Catch edits made while staging the write. Editors do not share a lock with
    // this command, so replacement of an existing file is a best-effort check.
    await assertUnchanged(filename, original);
    if (original.stat) await rename(temporary, filename);
    else {
      // Installing a previously absent file must never overwrite a concurrent creator.
      try {
        await link(temporary, filename);
      } catch (error) {
        if (errorCode(error) === 'EEXIST') throw settingsChanged();
        throw error;
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Read and validate first; the installer applies permission changes only after installing the skill. */
export async function prepareClaudeCommandPermission(cwd: string): Promise<ClaudePermissionPlan> {
  const filename = path.resolve(cwd, '.claude/settings.local.json');
  const original = await readSettings(filename);
  const permissions = (original.settings.permissions ?? {}) as Settings;
  const allow = (permissions.allow ?? []) as string[];
  const ask = (permissions.ask ?? []) as string[];
  const removed = allow.includes(LEGACY_CLAUDE_COMMAND_PERMISSION)
    ? [LEGACY_CLAUDE_COMMAND_PERMISSION]
    : [];
  const keptAllow = allow.filter((rule) => rule !== LEGACY_CLAUDE_COMMAND_PERMISSION);
  const nextAllow = [
    ...keptAllow,
    ...CLAUDE_ALLOW_PERMISSIONS.filter((rule) => !allow.includes(rule)),
  ];
  const nextAsk = [...ask, ...CLAUDE_ASK_PERMISSIONS.filter((rule) => !ask.includes(rule))];
  const changed =
    removed.length > 0 || nextAllow.length !== allow.length || nextAsk.length !== ask.length;
  return {
    async apply(): Promise<ClaudePermissionResult> {
      await assertUnchanged(filename, original);
      if (changed) {
        await writeSettings(filename, original, {
          ...original.settings,
          permissions: { ...permissions, allow: nextAllow, ask: nextAsk },
        });
      }
      return {
        path: filename,
        added: changed,
        allow: CLAUDE_ALLOW_PERMISSIONS,
        ask: CLAUDE_ASK_PERMISSIONS,
        removed,
      };
    },
  };
}
