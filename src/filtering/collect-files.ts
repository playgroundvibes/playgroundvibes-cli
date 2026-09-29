import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { INSPECTION_LIMITS } from './limits.js';
import { rejectInspection } from './findings.js';
import { inspectFileContents } from './inspect-file.js';
import {
  builtInExclusion,
  matchIgnoreFiles,
  parseIgnoreFile,
  safePath,
  structuralExclusion,
  type ExclusionMatch,
  type IgnoreScope,
} from './path-exclusions.js';

export interface FileSummary {
  /** Relative to the source or browser-build artifact. */
  path: string;
  bytes: number;
  sha256: string;
}

export interface FileExclusion extends ExclusionMatch {
  /** Relative to the selected project, including the build directory when applicable. */
  path: string;
}

export interface InspectedFile extends FileSummary {
  /** The exact bytes scanned; archive generation must use these without rereading. */
  contents: Buffer;
}

export interface CollectionOptions {
  build?: boolean;
  projectRoot?: string;
}

export interface FileCollection {
  files: InspectedFile[];
  bytes: number;
  skipped: FileExclusion[];
}

export async function resolveProjectPath(root: string, candidate: string): Promise<string> {
  root = path.resolve(root);
  if ((await fs.lstat(root)).isSymbolicLink())
    throw new Error('Project paths cannot contain symlinks.');
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  const outside =
    relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
  if (outside) throw new Error('Paths must stay inside the selected project.');

  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if ((await fs.lstat(current)).isSymbolicLink())
      throw new Error('Project paths cannot contain symlinks.');
  }
  return resolved;
}

export async function readRegularFile(file: string): Promise<Buffer> {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Expected a regular file.');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function relativePath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

export async function collectFiles(
  root: string,
  { build = false, projectRoot = root }: CollectionOptions = {},
): Promise<FileCollection> {
  projectRoot = path.resolve(projectRoot);
  root = await resolveProjectPath(projectRoot, path.resolve(root));
  if (!(await fs.lstat(root)).isDirectory())
    throw new Error('The selected artifact must be a directory.');

  const files: InspectedFile[] = [];
  const skipped: FileExclusion[] = [];
  const inspected = new Map<string, Buffer>();
  const fileLimit = build ? INSPECTION_LIMITS.buildFileBytes : INSPECTION_LIMITS.sourceFileBytes;
  const totalLimit = build ? INSPECTION_LIMITS.buildTotalBytes : INSPECTION_LIMITS.sourceTotalBytes;
  const countLimit = build ? INSPECTION_LIMITS.buildFileCount : INSPECTION_LIMITS.sourceFileCount;
  let bytes = 0;

  async function inspectFile(file: string): Promise<Buffer> {
    const previous = inspected.get(file);
    if (previous) return previous;
    const displayPath = relativePath(projectRoot, file);
    await resolveProjectPath(projectRoot, file);
    if ((await fs.lstat(file)).size > fileLimit)
      rejectInspection(displayPath, 'inspection/file-size-limit');
    const contents = await readRegularFile(file);
    if (contents.length > fileLimit) rejectInspection(displayPath, 'inspection/file-size-limit');
    await inspectFileContents(contents, displayPath);
    inspected.set(file, contents);
    return contents;
  }

  async function readIgnoreFile(
    file: string,
    source: IgnoreScope['source'],
  ): Promise<IgnoreScope | undefined> {
    const displayPath = relativePath(projectRoot, file);
    try {
      await resolveProjectPath(projectRoot, file);
      const contents = await readRegularFile(file);
      return parseIgnoreFile(contents.toString('utf8'), {
        source,
        directory: path.dirname(file),
        file: displayPath,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  const projectIgnore = await readIgnoreFile(
    path.join(projectRoot, '.playgroundignore'),
    'playgroundignore',
  );

  async function walk(directory: string, inheritedGitRules: IgnoreScope[]): Promise<void> {
    await resolveProjectPath(projectRoot, directory);
    const gitRules = [...inheritedGitRules];
    if (!build) {
      const localRules = await readIgnoreFile(path.join(directory, '.gitignore'), 'gitignore');
      if (localRules) gitRules.push(localRules);
    }

    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of children) {
      const fullPath = path.join(directory, entry.name);
      const artifactPath = relativePath(root, fullPath);
      const projectPath = relativePath(projectRoot, fullPath);
      if (!safePath(artifactPath)) {
        skipped.push({
          path: projectPath,
          source: 'built-in',
          rule: 'unsafe-path',
          reason: 'unsafe path',
        });
        continue;
      }

      const structural = structuralExclusion(artifactPath, entry.isSymbolicLink(), build);
      let excluded = builtInExclusion(artifactPath);
      if (entry.isSymbolicLink()) excluded ??= structural;
      excluded ??=
        projectIgnore && matchIgnoreFiles(fullPath, entry.isDirectory(), [projectIgnore]);
      excluded ??= matchIgnoreFiles(fullPath, entry.isDirectory(), gitRules);
      excluded ??= structural;
      if (excluded) {
        skipped.push({ path: projectPath, ...excluded });
        continue;
      }

      if (entry.isDirectory()) {
        await walk(fullPath, gitRules);
        continue;
      }
      if (!entry.isFile()) {
        skipped.push({
          path: projectPath,
          source: 'built-in',
          rule: 'nonregular-file',
          reason: 'not a regular file',
        });
        continue;
      }
      const contents = await inspectFile(fullPath);
      bytes += contents.length;
      if (bytes > totalLimit || files.length >= countLimit) {
        throw new Error('Project exceeds the ' + (build ? 'browser build' : 'source') + ' limits.');
      }
      files.push({
        path: artifactPath,
        bytes: contents.length,
        sha256: createHash('sha256').update(contents).digest('hex'),
        contents,
      });
    }
  }

  await walk(root, []);
  if (!files.length) throw new Error('No eligible files to upload.');
  if (build && !files.some((file) => file.path === 'index.html')) {
    throw new Error('The browser build must contain index.html at its root.');
  }
  return { files, bytes, skipped };
}
