import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { APIError, ORIGIN, type JsonObject, type PlaygroundTransport } from '../api/transport.js';
import type { AuthSession, VerifiedAccount } from '../auth/types.js';
import {
  readProjectIdentity,
  writeProjectIdentity,
  type ProjectIdentity,
} from '../project/identity.js';
import { readPrivateJSON, withLock, writeJSON } from '../storage/local-state.js';
import { canonicalJSON, ConsentError, sha256 } from './consent.js';
import type { PreparedUpload } from './prepare.js';
import type { DeploymentResult, DeploymentStatus, Review } from './types.js';
import { buildUploadRequests } from './upload-requests.js';
import { multipartRequest } from './multipart.js';

async function verifyDestination(
  upload: PreparedUpload,
  auth: AuthSession,
): Promise<VerifiedAccount> {
  const account = await auth.account();
  if (account.account_id !== upload.review.accountId) {
    throw new ConsentError('The account changed. Prepare and approve the upload again.');
  }
  if (account.project_id && account.project_id !== upload.review.projectId) {
    throw new ConsentError('This connection is restricted to a different linked project.');
  }
  const currentIdentity = await readProjectIdentity(upload.review.root);
  if (canonicalJSON(currentIdentity ?? {}) !== upload.previousIdentity) {
    throw new ConsentError('The linked project changed. Prepare and approve the upload again.');
  }
  return account;
}

async function operationIdForReview(filename: string, digest: string): Promise<string> {
  const previous = await readPrivateJSON<unknown>(filename, null);
  if (
    previous &&
    typeof previous === 'object' &&
    'digest' in previous &&
    'operation' in previous &&
    previous.digest === digest &&
    typeof previous.operation === 'string' &&
    previous.operation
  ) {
    return previous.operation;
  }
  return randomUUID();
}

async function sendWithRetry(
  request: PlaygroundTransport,
  body: JsonObject,
  token: string,
): Promise<JsonObject> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request('/api/assistant/import', body, token);
    } catch (error) {
      // Network interruptions may have committed server-side. Reuse the operation ID and bytes.
      if (error instanceof APIError || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
}

export function readDeploymentStatus(value: JsonObject, projectId?: string): DeploymentStatus {
  const { status, id, version_id, url, preview, processing, published, publication, message } =
    value;
  if (
    (status !== 'imported' && status !== 'existing') ||
    typeof id !== 'string' ||
    !id ||
    typeof version_id !== 'string' ||
    !version_id ||
    typeof url !== 'string' ||
    !/^\/#project\/[^\s]+$/.test(url)
  ) {
    throw new Error('Upload completion could not be verified. Retry the same reviewed project.');
  }
  if (projectId && id !== projectId) {
    throw new Error(
      'The upload response does not match the reviewed project. The saved identity was preserved.',
    );
  }
  // The reference CLI treats these fields as optional display information.
  // Unknown optional shapes must not turn an acknowledged import into a failure.
  const processingStatus =
    processing &&
    typeof processing === 'object' &&
    !Array.isArray(processing) &&
    'status' in processing &&
    typeof processing.status === 'string' &&
    processing.status
      ? processing.status
      : undefined;
  // Do not forward arbitrary server fields into the public API or CLI output.
  return {
    status,
    id,
    version_id,
    url: ORIGIN + url,
    ...(typeof preview === 'string' ? { preview } : {}),
    ...(typeof published === 'boolean' ? { published } : {}),
    ...(typeof publication === 'string' ? { publication } : {}),
    ...(typeof message === 'string' && message.length <= 1500 ? { message } : {}),
    ...(processingStatus !== undefined
      ? {
          processing: {
            status: processingStatus,
            ...(processing &&
            typeof processing === 'object' &&
            'error' in processing &&
            typeof processing.error === 'string' &&
            processing.error.length <= 1000
              ? { error: processing.error }
              : {}),
          },
        }
      : {}),
  };
}

function deploymentResult(value: JsonObject, review: Review): DeploymentResult {
  return {
    ...readDeploymentStatus(value, review.projectId),
    digest: review.digest,
    files: review.files.length,
    bytes: review.bytes,
  };
}

/** Internal operation. The client checks its review capability and consent first. */
export function uploadPreparedProject(
  upload: PreparedUpload,
  auth: AuthSession,
  request: PlaygroundTransport,
): Promise<DeploymentResult> {
  return withLock(auth.configDir, async () => {
    const account = await verifyDestination(upload, auth);
    const { review, identity, entry } = upload;
    const binding: ProjectIdentity = {
      ...identity,
      version: 1,
      origin: ORIGIN,
      account_id: account.account_id,
      source_id: entry.source_id,
      date: entry.date,
    };
    const pendingFile = path.join(
      auth.configDir,
      `deploy-${sha256(review.root + '\n' + account.account_id)}.json`,
    );
    const operationId = await operationIdForReview(pendingFile, review.digest);

    // Persist before the first POST so a lost response is safely retryable.
    await writeProjectIdentity(review.root, binding);
    await writeJSON(pendingFile, { digest: review.digest, operation: operationId });
    upload.previousIdentity = canonicalJSON(binding);
    const parts = upload.archives
      ? [await multipartRequest(upload, operationId, request, account.token)]
      : buildUploadRequests(upload, operationId);
    let response: JsonObject = {};
    for (const part of parts) response = await sendWithRetry(request, part, account.token);
    const result = deploymentResult(response, review);
    await writeProjectIdentity(review.root, { ...binding, project_id: result.id });
    await fs.rm(pendingFile, { force: true });
    return result;
  });
}
