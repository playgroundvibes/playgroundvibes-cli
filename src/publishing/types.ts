import type { ProjectMetadata } from '../project/types.js';
import type { ExclusionMatch } from '../filtering/path-exclusions.js';

export type ArtifactKind = 'source' | 'build';

export interface ReviewFile {
  readonly artifact: ArtifactKind;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** An immutable description of exactly the bytes and metadata selected for upload. */
export interface Review {
  readonly digest: string;
  readonly origin: string;
  readonly root: string;
  readonly accountId?: string;
  readonly projectId?: string;
  readonly title: string;
  readonly summary: string;
  readonly metadata: ProjectMetadata;
  readonly files: readonly ReviewFile[];
  readonly excluded: readonly ExcludedFile[];
  readonly bytes: number;
  readonly warnings: readonly string[];
  readonly publication: string;
}

export interface ExcludedFile extends Readonly<ExclusionMatch> {
  readonly artifact: ArtifactKind;
  readonly path: string;
}

/** The caller must obtain user approval before supplying the reviewed digest. */
export interface DeploymentConsent {
  readonly consent: string;
}

export interface DeploymentResult {
  readonly status: 'imported' | 'existing';
  readonly id: string;
  readonly version_id: string;
  readonly url: string;
  readonly preview?: string;
  readonly processing?: { readonly status: string };
  readonly digest: string;
  readonly files: number;
  readonly bytes: number;
}
