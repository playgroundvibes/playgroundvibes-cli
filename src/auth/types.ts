import type { PlaygroundTransport } from '../api/transport.js';

/** Public, verified connection information. Credentials are never included. */
export interface ConnectionInfo {
  readonly status: 'connected';
  readonly account_id: string;
  readonly expires_at?: string | number | null;
  readonly project_id?: string | null;
}

/**
 * Result of `connect(code)`. `already_connected` is set when saved credentials
 * were still valid: they were kept and the pairing code was not redeemed.
 */
export interface ConnectResult extends ConnectionInfo {
  readonly already_connected?: true;
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
  connect(code: string): Promise<ConnectResult>;
  whoami(): Promise<ConnectionInfo>;
  logout(): Promise<LogoutResult>;
  account(): Promise<VerifiedAccount>;
}
