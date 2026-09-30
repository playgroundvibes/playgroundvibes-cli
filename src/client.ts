import path from 'node:path';
import { ORIGIN, request, type PlaygroundTransport } from './api/transport.js';
import { createAuth } from './auth/connection.js';
import type { ConnectResult, ConnectionInfo, LogoutResult } from './auth/types.js';
import { ConsentError } from './publishing/consent.js';
import { prepareUpload, type PreparedUpload } from './publishing/prepare.js';
import type { DeploymentConsent, DeploymentResult, Review } from './publishing/types.js';
import { uploadPreparedProject } from './publishing/upload.js';

export interface ClientOptions {
  readonly cwd?: string;
  readonly configDir?: string;
  /** Optional transport for embedding and offline tests; the default targets Playground only. */
  readonly request?: PlaygroundTransport;
}

export interface PlaygroundClient {
  readonly loginUrl: string;
  connect(code: string): Promise<ConnectResult>;
  whoami(): Promise<ConnectionInfo>;
  logout(): Promise<LogoutResult>;
  /** Inspect locally, without credentials, network requests or persistent writes. */
  inspect(): Promise<Review>;
  /** Verify the account and retain the inspected bytes privately in this client. */
  prepare(): Promise<Review>;
  /** Publish a review from this client after obtaining the user's explicit consent. */
  deploy(review: Review, approval: DeploymentConsent): Promise<DeploymentResult>;
}

/** Coordinate authentication, inspection and consent without an unreviewed upload API. */
export function createPlaygroundClient(options: ClientOptions = {}): PlaygroundClient {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const sendRequest = options.request ?? request;
  const auth = createAuth({ configDir: options.configDir, request: sendRequest });
  const prepared = new WeakMap<Review, PreparedUpload>();

  return Object.freeze({
    loginUrl: ORIGIN + '/#new',
    connect: auth.connect,
    whoami: auth.whoami,
    logout: auth.logout,
    async inspect(): Promise<Review> {
      return (await prepareUpload(cwd, auth.configDir)).review;
    },
    async prepare(): Promise<Review> {
      const account = await auth.account();
      const upload = await prepareUpload(cwd, auth.configDir, account.account_id);
      if (account.project_id && account.project_id !== upload.review.projectId) {
        throw new ConsentError('This connection is restricted to a different linked project.');
      }
      prepared.set(upload.review, upload);
      return upload.review;
    },
    async deploy(review: Review, approval: DeploymentConsent): Promise<DeploymentResult> {
      const upload = prepared.get(review);
      if (!upload || !review.accountId || !approval || approval.consent !== review.digest)
        throw new ConsentError();
      const result = await uploadPreparedProject(upload, auth, sendRequest);
      prepared.delete(review);
      return result;
    },
  });
}
