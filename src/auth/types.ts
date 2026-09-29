import type { PlaygroundTransport } from '../api/transport.js';

/** Public, verified connection information. Credentials are never included. */
export interface ConnectionInfo {
  readonly status: 'connected';
  readonly account_id: string;
  readonly expires_at?: string | number | null;
  readonly project_id?: string | null;
}

export interface LogoutResult {
  readonly disconnected: true;
}

/** Internal account data used by the publishing pipeline, never public output. */
export interface VerifiedAccount extends ConnectionInfo {
  readonly token: string;
}

export interface AuthOptions {
  readonly configDir?: string;
  readonly request?: PlaygroundTransport;
}

/** Internal authentication boundary shared by the CLI and publishing client. */
export interface AuthSession {
  readonly configDir: string;
  connect(code: string): Promise<ConnectionInfo>;
  whoami(): Promise<ConnectionInfo>;
  logout(): Promise<LogoutResult>;
  account(): Promise<VerifiedAccount>;
}
