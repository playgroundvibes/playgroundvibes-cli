import { ORIGIN } from '../api/transport.js';
import { packProject } from '../artifacts/pack-project.js';
import { scanText } from '../filtering/scan-text.js';
import { loadProject } from '../project/load-project.js';
import { buildMetadata } from '../project/metadata.js';
import type { ProjectIdentity } from '../project/identity.js';
import type { ProjectMetadata } from '../project/types.js';
import { canonicalJSON, freezeRecursively, sha256 } from './consent.js';
import type { Review, ReviewFile } from './types.js';

export const PUBLICATION_NOTICE =
  'The selected source will be sent to Playground Vibes. A completed upload publishes the project listing and available browser preview immediately and updates the linked project. Playground keeps private Git history and may automatically improve supported browser projects; a later local upload replaces those server changes. Source downloads and remix permission are separate settings.';

export interface ArtifactHashes {
  readonly source: string;
  readonly build?: string;
}

export interface UploadEntry extends ProjectMetadata {
  readonly source: string;
  readonly build?: string;
}

/** Private payload; only the review is returned to callers. */
export interface PreparedUpload {
  readonly review: Review;
  readonly entry: UploadEntry;
  readonly hashes: ArtifactHashes;
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

  const source = await packProject(root);
  const build = project.buildRoot
    ? await packProject(project.buildRoot, { build: true, projectRoot: root })
    : undefined;
  const files: ReviewFile[] = [
    ...source.files.map((file) => ({ artifact: 'source' as const, ...file })),
    ...(build?.files.map((file) => ({ artifact: 'build' as const, ...file })) ?? []),
  ];
  const entry: UploadEntry = {
    ...metadata,
    source: source.data,
    ...(build ? { build: build.data } : {}),
  };
  const hashes: ArtifactHashes = {
    source: sha256(source.data),
    ...(build ? { build: sha256(build.data) } : {}),
  };
  const warnings = [
    'Secret scanning reduces risk; it cannot prove that every possible secret or private detail is absent. Review all selected files and metadata.',
  ];
  if (!build) warnings.push('Source only: no browser preview will be uploaded.');
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
    bytes: source.bytes + (build?.bytes ?? 0),
    warnings,
    publication: PUBLICATION_NOTICE,
  });
  return {
    review,
    entry: freezeRecursively(entry),
    hashes: freezeRecursively(hashes),
    identity,
    previousIdentity: canonicalJSON(identity ?? {}),
  };
}
