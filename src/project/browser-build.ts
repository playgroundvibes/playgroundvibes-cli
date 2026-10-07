import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { JsonObject } from '../api/transport.js';
import { resolveProjectPath } from '../filtering/collect-files.js';

const COMMON_BUILD_DIRECTORIES = ['dist', 'build', 'out'] as const;

function missingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Inspect only paths inside the selected project; do not read or follow symlinked output. */
async function browserBuildDirectory(root: string, candidate: string): Promise<string | undefined> {
  try {
    const directory = await resolveProjectPath(root, candidate);
    if (!(await lstat(directory)).isDirectory()) return undefined;
    const index = await resolveProjectPath(root, path.join(directory, 'index.html'));
    return (await lstat(index)).isFile() ? directory : undefined;
  } catch (error) {
    if (missingPath(error)) return undefined;
    throw error;
  }
}

function explicitBuildPath(value: unknown, manifestPath: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(
      'build_dir must be a nonempty path without surrounding whitespace or control characters.',
    );
  }
  return path.resolve(path.dirname(manifestPath), value);
}

/** Prefer supplied browser output; otherwise let the processor prepare the saved source. */
export async function resolveBrowserBuild(
  root: string,
  manifest: JsonObject,
  manifestPath: string,
): Promise<string | undefined> {
  if (manifest.source_only !== undefined && typeof manifest.source_only !== 'boolean') {
    throw new Error('source_only must be true or false.');
  }
  if (manifest.source_only === true) {
    if (Object.hasOwn(manifest, 'build_dir')) {
      throw new Error(
        'source_only: true cannot be combined with build_dir. Choose one publication mode.',
      );
    }
    return undefined;
  }

  if (manifest.build_dir !== undefined) {
    const directory = await browserBuildDirectory(
      root,
      explicitBuildPath(manifest.build_dir, manifestPath),
    );
    return directory;
  }

  const candidates: string[] = [];
  for (const name of COMMON_BUILD_DIRECTORIES) {
    const directory = await browserBuildDirectory(root, name);
    if (directory) candidates.push(directory);
  }
  if (candidates.length === 1) return candidates[0];
  // Ambiguous output is also recoverable from source; do not guess which build
  // the creator intended or require them to resolve it before uploading.
  return undefined;
}
