import { ORIGIN } from '../api/transport.js';
import { inspectCover, type CoverPayload } from '../artifacts/inspect-cover.js';
import { packProject, type ArchiveSnapshot } from '../artifacts/pack-project.js';
import { scanText } from '../filtering/scan-text.js';
import { loadProject } from '../project/load-project.js';
import { buildMetadata } from '../project/metadata.js';
import type { ProjectIdentity } from '../project/identity.js';
import type { ProjectMetadata } from '../project/types.js';
import { canonicalJSON, freezeRecursively, sha256 } from './consent.js';
import type { Review, ReviewFile } from './types.js';

export const PUBLICATION_NOTICE =
  'The selected source will be sent to Playground Vibes. The upload requests publication of the listing and browser preview after server checks pass and updates the linked project. Playground validates an uploaded browser build or builds supported source; apps needing a backend can receive a clearly labeled project overview. Playground keeps private Git history and may automatically improve supported browser projects; a later local upload replaces those server changes. Source downloads and remix permission are separate settings.';

export interface ArtifactHashes {
  readonly source: string;
  readonly build?: string;
  readonly cover?: string;
}

export interface UploadEntry extends ProjectMetadata {
  readonly source: string;
  readonly build?: string;
  readonly cover?: CoverPayload;
}

/** Private payload; only the review is returned to callers. */
export interface PreparedUpload {
  readonly review: Review;
  readonly entry: UploadEntry;
  readonly hashes: ArtifactHashes;
  readonly archives?: { source: ArchiveSnapshot; build?: ArchiveSnapshot; cover?: ArchiveSnapshot };
  readonly identity?: ProjectIdentity;
  previousIdentity: string;
}

/** Load, inspect, archive and freeze once so publication cannot reread changed source. */
export async function prepareUpload(
  cwd: string,
  configDir: string,
  accountId?: string,
): Promise<PreparedUpload> {
  const project = await loadProject(cwd, configDir);
  const { root, manifest, identity } = project;
  if (accountId && identity && accountId !== identity.account_id) {
    throw new Error('This project is linked to a different Playground account.');
  }
  const metadata = buildMetadata(manifest, identity ?? {}, root);
  await scanText(JSON.stringify(metadata), 'project metadata');
  await scanText(
    JSON.stringify({ accountId, projectId: identity?.project_id }),
    'upload destination',
  );

  const cover = project.coverPath ? await inspectCover(root, project.coverPath) : undefined;
  const source = await packProject(root);
  const build = project.buildRoot
    ? await packProject(project.buildRoot, { build: true, projectRoot: root })
    : undefined;
  const files: ReviewFile[] = [
    ...source.files.map((file) => ({ artifact: 'source' as const, ...file })),
    ...(build?.files.map((file) => ({ artifact: 'build' as const, ...file })) ?? []),
    ...(cover ? [{ artifact: 'cover' as const, ...cover.file }] : []),
  ];
  const projectBytes = source.bytes + (build?.bytes ?? 0) + (cover?.file.bytes ?? 0);
  if (projectBytes > 1024 * 1024 * 1024 || files.length > 500)
    throw new Error(
      'A project can contain up to 1 GiB and 500 files across source, build and cover.',
    );
  const multipart =
    (cover?.file.bytes ?? 0) > 3 * 1024 * 1024 ||
    !source.data ||
    (build && !build.data) ||
    source.bytes > 10 * 1024 * 1024 ||
    source.files.some((file) => file.bytes > 3 * 1024 * 1024) ||
    (build?.bytes ?? 0) > 10 * 1024 * 1024 ||
    (build?.files.some((file) => file.bytes > 3 * 1024 * 1024) ?? false);
  const entry: UploadEntry = {
    ...metadata,
    source: multipart ? '' : source.data,
    ...(build && !multipart ? { build: build.data } : {}),
    ...(cover && !multipart ? { cover: cover.payload } : {}),
  };
  const hashes: ArtifactHashes = {
    source: multipart ? source.archive.sha256 : sha256(source.data),
    ...(build ? { build: multipart ? build.archive.sha256 : sha256(build.data) } : {}),
    ...(cover ? { cover: multipart ? cover.file.sha256 : sha256(cover.payload.data) } : {}),
  };
  const warnings = [
    'Credential checks match literal patterns in each file’s UTF-8 representation; encoded values and compressed content are not inspected. Review all selected files and metadata before publishing.',
  ];
  if (!build)
    warnings.push('Source only: explicitly selected; no browser preview will be uploaded.');
  if (!manifest.date && !identity?.date)
    warnings.push('No original date supplied; the current date is used.');

  // Diagnostics are excluded: a retry can resolve a warning without changing any uploaded bytes.
  const digest = sha256(
    canonicalJSON({
      policy: 1,
      origin: ORIGIN,
      root,
      accountId: accountId ?? null,
      projectId: identity?.project_id ?? null,
      metadata,
      files,
      hashes,
      publication: PUBLICATION_NOTICE,
    }),
  );
  const review = freezeRecursively<Review>({
    digest,
    origin: ORIGIN,
    root,
    ...(accountId ? { accountId } : {}),
    ...(identity?.project_id ? { projectId: identity.project_id } : {}),
    title: metadata.title,
    summary: metadata.summary,
    metadata,
    files,
    excluded: [
      ...source.skipped.map((file) => ({ artifact: 'source' as const, ...file })),
      ...(build?.skipped.map((file) => ({ artifact: 'build' as const, ...file })) ?? []),
    ],
    bytes: source.bytes + (build?.bytes ?? 0) + (cover?.file.bytes ?? 0),
    warnings,
    publication: PUBLICATION_NOTICE,
  });
  return {
    review,
    entry: freezeRecursively(entry),
    hashes: freezeRecursively(hashes),
    ...(multipart
      ? {
          archives: {
            source: source.archive,
            ...(build ? { build: build.archive } : {}),
            ...(cover ? { cover: cover.snapshot } : {}),
          },
        }
      : {}),
    identity,
    previousIdentity: canonicalJSON(identity ?? {}),
  };
}
