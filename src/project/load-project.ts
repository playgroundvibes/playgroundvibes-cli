import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { JsonObject } from '../api/transport.js';
import { readRegularFile, resolveProjectPath } from '../filtering/collect-files.js';
import { readProjectIdentity, type ProjectIdentity } from './identity.js';

const MAX_MANIFEST_BYTES = 256 * 1024;

export interface LoadedProject {
  readonly root: string;
  readonly manifest: JsonObject;
  readonly identity?: ProjectIdentity;
  readonly buildRoot?: string;
}

async function validateProjectRoot(cwd: string, configDir: string): Promise<string> {
  const root = await fs.realpath(cwd);
  const home = await fs.realpath(os.homedir());
  if (root === path.parse(root).root || root === home) {
    throw new Error('Select one project, not the home or filesystem root.');
  }
  const configRoot = await fs.realpath(configDir).catch(() => path.resolve(configDir));
  const relative = path.relative(root, configRoot);
  const outsideProject =
    relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
  if (!outsideProject)
    throw new Error('Keep the private Playground configuration outside the selected project.');
  return root;
}

async function readManifest(filename: string): Promise<JsonObject> {
  if ((await fs.stat(filename)).size > MAX_MANIFEST_BYTES)
    throw new Error('Project manifest exceeds 256 KiB.');
  const bytes = await readRegularFile(filename);
  if (bytes.length > MAX_MANIFEST_BYTES) throw new Error('Project manifest exceeds 256 KiB.');
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as JsonObject;
  } catch {
    throw new Error('Use a valid UTF-8 JSON object in .playground/manifest.json.');
  }
}

/** Resolve only project-local paths. Manifest contents remain untrusted until metadata validation. */
export async function loadProject(cwd: string, configDir: string): Promise<LoadedProject> {
  const root = await validateProjectRoot(cwd, configDir);
  const manifestPath = await resolveProjectPath(root, '.playground/manifest.json');
  const manifest = await readManifest(manifestPath);
  if (manifest.source_dir !== undefined && typeof manifest.source_dir !== 'string') {
    throw new Error('source_dir must be a path.');
  }
  const sourceRoot = path.resolve(path.dirname(manifestPath), manifest.source_dir ?? '..');
  if (sourceRoot !== root) throw new Error('source_dir must select the current project root.');
  if (manifest.cover_file !== undefined) {
    throw new Error(
      'Binary cover images cannot be fully inspected by this release. Remove cover_file and exclude the image with .playgroundignore before continuing.',
    );
  }

  let buildRoot: string | undefined;
  if (manifest.build_dir !== undefined) {
    if (typeof manifest.build_dir !== 'string' || !manifest.build_dir)
      throw new Error('build_dir must be a path.');
    buildRoot = await resolveProjectPath(
      root,
      path.resolve(path.dirname(manifestPath), manifest.build_dir),
    );
  }
  return { root, manifest, identity: await readProjectIdentity(root), buildRoot };
}
