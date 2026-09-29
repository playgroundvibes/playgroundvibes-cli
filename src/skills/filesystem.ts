import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';

export function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

/** Create skill/configuration directories without traversing symbolic links. */
export async function ensureDirectory(directory: string): Promise<void> {
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
