import { createHash } from 'node:crypto';
import { lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  readRegularFile,
  resolveProjectPath,
  type FileSummary,
} from '../filtering/collect-files.js';
import { snapshotPath } from './snapshots.js';
import type { ArchiveSnapshot } from './pack-project.js';
import { MIB } from '../filtering/limits.js';
import { inspectFileContents } from '../filtering/inspect-file.js';

const MAX_COVER_BYTES = 20 * MIB;
const COVER_MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
});

export interface CoverPayload {
  readonly mime: string;
  readonly data: string;
}

export interface InspectedCover {
  readonly payload: CoverPayload;
  readonly snapshot: ArchiveSnapshot;
  readonly file: FileSummary;
}

async function eligibleCoverPath(
  root: string,
  filename: string,
): Promise<{ absolute: string; relative: string; mime: string }> {
  const absolute = path.resolve(filename);
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  await resolveProjectPath(root, absolute);
  const mime = COVER_MIME_TYPES[path.extname(absolute).toLowerCase()];
  if (!mime)
    throw new Error('cover_file must select a PNG, JPEG, or WebP image of at most 20 MiB.');
  if (!(await lstat(absolute)).isFile()) throw new Error('cover_file must select a regular file.');
  return { absolute, relative, mime };
}

/** Resolve the explicit manifest-relative selection without reading its contents. */
export async function resolveCoverPath(
  root: string,
  manifestPath: string,
  value: unknown,
): Promise<string> {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(
      'cover_file must be a nonempty path without surrounding whitespace or control characters.',
    );
  }
  return (await eligibleCoverPath(root, path.resolve(path.dirname(manifestPath), value))).absolute;
}

/** Inspect once and retain these exact cover bytes for review and transport. */
export async function inspectCover(root: string, filename: string): Promise<InspectedCover> {
  const { absolute, relative, mime } = await eligibleCoverPath(root, filename);
  if ((await lstat(absolute)).size > MAX_COVER_BYTES) throw new Error('cover_file exceeds 20 MiB.');
  const contents = await readRegularFile(absolute);
  if (contents.length > MAX_COVER_BYTES) throw new Error('cover_file exceeds 20 MiB.');
  await inspectFileContents(contents, relative);
  const snapshot = {
    path: snapshotPath(),
    bytes: contents.length,
    sha256: createHash('sha256').update(contents).digest('hex'),
  };
  await writeFile(snapshot.path, contents, { flag: 'wx', mode: 0o600 });
  return {
    snapshot,
    payload: { mime, data: contents.toString('base64') },
    file: {
      path: relative,
      bytes: contents.length,
      sha256: createHash('sha256').update(contents).digest('hex'),
    },
  };
}
