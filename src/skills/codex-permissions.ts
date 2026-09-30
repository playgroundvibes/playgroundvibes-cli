import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { ensureDirectory, errorCode } from './filesystem.js';

export const CODEX_RULES_FILE = '.codex/rules/playgroundvibes.rules';
export const CODEX_COMMAND_RULE = 'prefix_rule(pattern = ["playgroundvibes"], decision = "allow")';

export interface CodexPermissionResult {
  readonly path: string;
  readonly added: boolean;
  readonly rule: string;
}

export interface CodexPermissionPlan {
  apply(): Promise<CodexPermissionResult>;
}

const CONTENTS = Buffer.from(
  [
    '# Added by @playgroundvibes/cli skill install --codex.',
    '# Lets Codex run the global playgroundvibes command. Publishing still requires review and consent.',
    'prefix_rule(',
    '    pattern = ["playgroundvibes"],',
    '    decision = "allow",',
    '    justification = "Playground Vibes CLI; uploads still require an approved review digest",',
    ')',
    '',
  ].join('\n'),
  'utf8',
);

/** Validate existing ancestors without creating anything during preparation. */
async function checkDirectories(filename: string): Promise<void> {
  let directory = path.dirname(filename);
  while (true) {
    try {
      const stat = await lstat(directory);
      if (stat.isSymbolicLink()) throw new Error('Refusing symlinked Codex rules directories.');
      if (!stat.isDirectory()) throw new Error('A Codex rules parent is not a directory.');
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

/** Returns true when an identical rules file exists, false when absent; refuses other contents. */
async function existingRules(filename: string): Promise<boolean> {
  let info;
  try {
    info = await lstat(filename);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error(`Refusing a symlinked Codex rules file: ${filename}`);
  if (!info.isFile()) throw new Error(`Expected a regular Codex rules file: ${filename}`);
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await handle.readFile()).equals(CONTENTS)) {
      throw new Error(`Refusing to overwrite different existing Codex rules: ${filename}`);
    }
  } finally {
    await handle.close();
  }
  return true;
}

/** Read and validate first; the installer applies the rules file only after installing the skill. */
export async function prepareCodexCommandPermission(cwd: string): Promise<CodexPermissionPlan> {
  const filename = path.resolve(cwd, CODEX_RULES_FILE);
  await checkDirectories(filename);
  const alreadyAllowed = await existingRules(filename);
  return {
    async apply(): Promise<CodexPermissionResult> {
      let added = false;
      if (!alreadyAllowed) {
        await ensureDirectory(path.dirname(filename));
        let handle;
        try {
          handle = await open(
            filename,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
            0o644,
          );
        } catch (error) {
          if (errorCode(error) !== 'EEXIST') throw error;
          await existingRules(filename);
        }
        if (handle) {
          try {
            await handle.writeFile(CONTENTS);
          } finally {
            await handle.close();
          }
          added = true;
        }
      }
      return { path: filename, added, rule: CODEX_COMMAND_RULE };
    },
  };
}
