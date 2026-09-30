import { constants } from 'node:fs';
import { lstat, open, readFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  prepareClaudeCommandPermission,
  type ClaudePermissionResult,
} from './claude-permissions.js';
import { prepareCodexCommandPermission, type CodexPermissionResult } from './codex-permissions.js';
import { ensureDirectory, errorCode } from './filesystem.js';
import { ensureGlobalCLI, type GlobalCLIResult, type SkillPackageManager } from './global-cli.js';

export type { ClaudePermissionResult } from './claude-permissions.js';
export type { CodexPermissionResult } from './codex-permissions.js';
export type { GlobalCLIResult, SkillPackageManager } from './global-cli.js';

export interface InstallSkillOptions {
  cwd?: string;
  directory?: string;
  /** Install to Claude's project skill directory unless directory is provided. */
  claude?: boolean;
  /** Install the global CLI dependency and allow its commands in local Claude settings. Requires claude. */
  allowClaudeCommands?: boolean;
  /** Install to Codex's project skill directory (.agents/skills) unless directory is provided. */
  codex?: boolean;
  /** Install the global CLI dependency and allow its commands in project Codex rules. Requires codex. */
  allowCodexCommands?: boolean;
  /** Override npm/pnpm selection when installing the global command dependency. */
  packageManager?: SkillPackageManager;
}

export interface InstallSkillResult {
  path: string;
  installed: boolean;
  claudePermissions?: ClaudePermissionResult;
  codexPermissions?: CodexPermissionResult;
  globalCLI?: GlobalCLIResult;
}

/** Return the absolute path of the skill shipped with this package. */
export function getSkillPath(): string {
  return fileURLToPath(new URL('../../skills/playground-upload', import.meta.url));
}

async function existingMatches(filename: string, contents: Buffer): Promise<void> {
  const info = await lstat(filename);
  if (info.isSymbolicLink()) throw new Error(`Refusing to replace a symbolic link: ${filename}`);
  if (!info.isFile()) throw new Error(`Refusing to overwrite an existing non-file: ${filename}`);
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await handle.stat()).isFile() || !(await handle.readFile()).equals(contents)) {
      throw new Error(`Refusing to overwrite a different existing skill: ${filename}`);
    }
  } finally {
    await handle.close();
  }
}

async function copySkill(destination: string, contents: Buffer): Promise<boolean> {
  await ensureDirectory(destination);
  const filename = path.join(destination, 'SKILL.md');

  let handle: FileHandle;
  try {
    handle = await open(
      filename,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o644,
    );
  } catch (error) {
    if (errorCode(error) !== 'EEXIST' && errorCode(error) !== 'ELOOP') throw error;
    await existingMatches(filename, contents);
    return false;
  }
  try {
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
  return true;
}

/** Install the skill; Claude/Codex permission setup also ensures its global CLI dependency. */
export async function installSkill({
  cwd = process.cwd(),
  directory,
  claude = false,
  allowClaudeCommands = false,
  codex = false,
  allowCodexCommands = false,
  packageManager,
}: InstallSkillOptions = {}): Promise<InstallSkillResult> {
  if (directory !== undefined && (typeof directory !== 'string' || !directory.trim())) {
    throw new TypeError('directory must be a non-empty path to the skill folder');
  }
  if (typeof claude !== 'boolean' || typeof allowClaudeCommands !== 'boolean') {
    throw new TypeError('claude and allowClaudeCommands must be booleans');
  }
  if (typeof codex !== 'boolean' || typeof allowCodexCommands !== 'boolean') {
    throw new TypeError('codex and allowCodexCommands must be booleans');
  }
  if (claude && codex) {
    throw new TypeError('claude and codex cannot be combined; install each separately');
  }
  if (allowClaudeCommands && !claude) {
    throw new TypeError('allowClaudeCommands requires claude: true');
  }
  if (allowCodexCommands && !codex) {
    throw new TypeError('allowCodexCommands requires codex: true');
  }
  if (packageManager !== undefined && packageManager !== 'npm' && packageManager !== 'pnpm') {
    throw new TypeError('packageManager must be npm or pnpm');
  }
  if (packageManager !== undefined && !allowClaudeCommands && !allowCodexCommands) {
    throw new TypeError('packageManager requires allowClaudeCommands or allowCodexCommands: true');
  }

  const root = path.resolve(cwd);
  const defaultDirectory = claude
    ? '.claude/skills/playground-upload'
    : '.agents/skills/playground-upload';
  const destination = path.resolve(root, directory ?? defaultDirectory);
  // Validate settings before writing the skill; do not grant permissions if copying fails.
  const permissionPlan = allowClaudeCommands
    ? await prepareClaudeCommandPermission(root)
    : undefined;
  const codexPlan = allowCodexCommands ? await prepareCodexCommandPermission(root) : undefined;
  const contents = await readFile(path.join(getSkillPath(), 'SKILL.md'));
  const installed = await copySkill(destination, contents);
  const result: InstallSkillResult = { path: destination, installed };
  if (permissionPlan) {
    result.globalCLI = await ensureGlobalCLI(packageManager);
    result.claudePermissions = await permissionPlan.apply();
  }
  if (codexPlan) {
    result.globalCLI = await ensureGlobalCLI(packageManager);
    result.codexPermissions = await codexPlan.apply();
  }
  return result;
}
