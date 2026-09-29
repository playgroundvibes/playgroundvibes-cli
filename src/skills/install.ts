import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface InstallSkillOptions {
  cwd?: string;
  directory?: string;
}

export interface InstallSkillResult {
  path: string;
  installed: boolean;
}

/** Return the absolute path of the skill shipped with this package. */
export function getSkillPath(): string {
  return fileURLToPath(new URL('../../skills/playground-upload', import.meta.url));
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

async function ensureDirectory(directory: string): Promise<void> {
  const parent = path.dirname(directory);
  if (parent !== directory) await ensureDirectory(parent);

  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    try {
      await mkdir(directory);
    } catch (mkdirError) {
      if (errorCode(mkdirError) !== 'EEXIST') throw mkdirError;
    }
    info = await lstat(directory);
  }
  if (info.isSymbolicLink()) {
    throw new Error(`Refusing to install through a symbolic link: ${directory}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`Skill destination ancestor is not a directory: ${directory}`);
  }
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

/** Install the skill explicitly; preserve an existing skill's local edits. */
export async function installSkill({
  cwd = process.cwd(),
  directory,
}: InstallSkillOptions = {}): Promise<InstallSkillResult> {
  if (directory !== undefined && (typeof directory !== 'string' || !directory.trim())) {
    throw new TypeError('directory must be a non-empty path to the skill folder');
  }
  const destination = path.resolve(cwd, directory ?? '.agents/skills/playground-upload');
  const contents = await readFile(path.join(getSkillPath(), 'SKILL.md'));
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
    return { path: destination, installed: false };
  }
  try {
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
  return { path: destination, installed: true };
}
