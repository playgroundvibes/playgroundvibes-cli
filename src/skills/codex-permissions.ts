import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { ensureDirectory, errorCode } from './filesystem.js';

export const CODEX_RULES_FILE = '.codex/rules/playgroundvibes.rules';
/** Read-only commands run without prompting; every deploy prompts, so consent stays with the user. */
export const CODEX_COMMAND_RULES: readonly string[] = Object.freeze([
  'prefix_rule(pattern = ["playgroundvibes", "whoami"], decision = "allow")',
  'prefix_rule(pattern = ["playgroundvibes", "--version"], decision = "allow")',
  'prefix_rule(pattern = ["playgroundvibes", "--help"], decision = "allow")',
  'prefix_rule(pattern = ["playgroundvibes", "skill", "path"], decision = "allow")',
  'prefix_rule(pattern = ["playgroundvibes", "deploy"], decision = "prompt")',
]);

export interface CodexPermissionResult {
  readonly path: string;
  /** True when the rules file was written. */
  readonly added: boolean;
  /** True when the broad rules file written by 0.1.5 and earlier was replaced. */
  readonly replaced: boolean;
  readonly rules: readonly string[];
}

export interface CodexPermissionPlan {
  apply(): Promise<CodexPermissionResult>;
}

const CONTENTS = Buffer.from(
  [
    '# Added by @playgroundvibes/cli skill install --codex.',
    '# Lets Codex run read-only playgroundvibes commands. Every deploy prompts for approval.',
    ...CODEX_COMMAND_RULES,
    '',
  ].join('\n'),
  'utf8',
);

/** Written by 0.1.5 and earlier; it allowed consented deploys without prompting. */
const LEGACY_CONTENTS = Buffer.from(
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

type ExistingRules = 'current' | 'legacy' | 'absent';

/** Identifies a current, legacy, or absent rules file; refuses other contents. */
async function existingRules(filename: string): Promise<ExistingRules> {
  let info;
  try {
    info = await lstat(filename);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'absent';
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error(`Refusing a symlinked Codex rules file: ${filename}`);
  if (!info.isFile()) throw new Error(`Expected a regular Codex rules file: ${filename}`);
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const contents = await handle.readFile();
    if (contents.equals(CONTENTS)) return 'current';
    if (contents.equals(LEGACY_CONTENTS)) return 'legacy';
    throw new Error(`Refusing to overwrite different existing Codex rules: ${filename}`);
  } finally {
    await handle.close();
  }
}

/** Replace the legacy file atomically, refusing if it changed since it was checked. */
async function replaceLegacy(filename: string): Promise<void> {
  const temporary = path.join(path.dirname(filename), `.playgroundvibes.rules.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o644);
    try {
      await handle.writeFile(CONTENTS);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if ((await existingRules(filename)) !== 'legacy') {
      throw new Error(
        `Codex rules changed during installation. Existing rules were preserved: ${filename}`,
      );
    }
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Read and validate first; the installer applies the rules file only after installing the skill. */
export async function prepareCodexCommandPermission(cwd: string): Promise<CodexPermissionPlan> {
  const filename = path.resolve(cwd, CODEX_RULES_FILE);
  await checkDirectories(filename);
  const existing = await existingRules(filename);
  return {
    async apply(): Promise<CodexPermissionResult> {
      let added = false;
      if (existing === 'legacy') {
        await replaceLegacy(filename);
        return { path: filename, added: true, replaced: true, rules: CODEX_COMMAND_RULES };
      }
      if (existing === 'absent') {
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
          if ((await existingRules(filename)) !== 'current') {
            throw new Error(`Refusing to overwrite different existing Codex rules: ${filename}`);
          }
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
      return { path: filename, added, replaced: false, rules: CODEX_COMMAND_RULES };
    },
  };
}
