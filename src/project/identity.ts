import path from 'node:path';
import { ORIGIN } from '../api/transport.js';
import { readJSON, writeJSON } from '../storage/local-state.js';

/** Local link to an account and, after the first successful upload, a project. */
export interface ProjectIdentity {
  readonly version: 1;
  readonly origin: typeof ORIGIN;
  readonly account_id: string;
  readonly source_id: string;
  readonly date: string;
  readonly project_id?: string;
}

function identityPath(root: string): string {
  return path.join(root, '.playground', 'project.json');
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export async function readProjectIdentity(root: string): Promise<ProjectIdentity | undefined> {
  const value = await readJSON<unknown>(identityPath(root), {});
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Project identity must be an object.');
  }
  if (Object.keys(value).length === 0) return undefined;

  const identity = value as Record<string, unknown>;
  if (
    identity.version !== 1 ||
    identity.origin !== ORIGIN ||
    !nonemptyString(identity.account_id) ||
    !nonemptyString(identity.source_id) ||
    !nonemptyString(identity.date)
  ) {
    throw new Error('Unrecognized project identity. Preserve it and resolve the conflict.');
  }
  if (identity.project_id !== undefined && !nonemptyString(identity.project_id)) {
    throw new Error('Invalid linked project ID.');
  }
  // Retain unknown local fields so preparing an upload never silently rewrites them.
  return {
    ...identity,
    version: 1,
    origin: ORIGIN,
    account_id: identity.account_id,
    source_id: identity.source_id,
    date: identity.date,
    ...(identity.project_id !== undefined ? { project_id: identity.project_id } : {}),
  };
}

export function writeProjectIdentity(root: string, identity: ProjectIdentity): Promise<void> {
  return writeJSON(identityPath(root), identity);
}
