import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { getConfigDir, readPrivateJSON, writeJSON, withLock } from '../storage/local-state.js';
import { APIError, ORIGIN, request as defaultRequest, type JsonObject } from '../api/transport.js';
import type {
  AuthOptions,
  AuthSession,
  ConnectResult,
  ConnectionInfo,
  LogoutResult,
  VerifiedAccount,
} from './types.js';

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const isToken = (value: unknown): value is string =>
  typeof value === 'string' && /^pgimport_[a-f0-9]{64}$/.test(value);
const isObject = (value: unknown): value is JsonObject =>
  !!value && typeof value === 'object' && !Array.isArray(value);

interface StoredCredential {
  readonly origin: typeof ORIGIN;
  readonly token: string;
  readonly account_id: string;
}

function identifier(value: unknown, field: string, token: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.includes(token) ||
    /pg(?:import|sync)_[a-f0-9]{64}/.test(value)
  ) {
    throw new Error(`Playground returned an invalid ${field}. Connect again.`);
  }
  return value;
}

function expiry(value: unknown, token: string): string | number | null | undefined {
  if (value === null || value === undefined) return value;
  // Status is authoritative on the server. Expiry is optional display metadata,
  // so neither an unfamiliar format nor this computer's clock denies access.
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (
    typeof value === 'string' &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    !value.includes(token) &&
    !/pg(?:import|sync)_[a-f0-9]{64}/.test(value)
  )
    return value;
  return undefined;
}

/** Copy only validated public fields; never spread an arbitrary server response. */
function connectionInfo(value: unknown, token: string, requireStatus: boolean): ConnectionInfo {
  if (
    !isObject(value) ||
    (requireStatus && value.status !== 'connected') ||
    (value.status !== undefined && value.status !== 'connected')
  ) {
    throw new Error('Playground returned an invalid connected account.');
  }
  const accountId = identifier(value.account_id, 'account ID', token);
  const expiresAt = expiry(value.expires_at, token);
  const projectId =
    value.project_id === undefined || value.project_id === null
      ? value.project_id
      : identifier(value.project_id, 'project ID', token);
  return Object.freeze({
    status: 'connected',
    account_id: accountId,
    ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
    ...(projectId !== undefined ? { project_id: projectId } : {}),
  });
}

export function createAuth(options: AuthOptions = {}): AuthSession {
  const configDir = getConfigDir(options.configDir);
  const request = options.request ?? defaultRequest;
  const credentialFile = path.join(configDir, 'connection.json');

  async function credentials(): Promise<StoredCredential> {
    const saved = await readPrivateJSON<unknown>(credentialFile, null);
    if (!isObject(saved) || saved.origin !== ORIGIN || !isToken(saved.token)) {
      throw new Error(
        'Connect first: run playgroundvibes login, then playgroundvibes connect CODE.',
      );
    }
    return {
      origin: ORIGIN,
      token: saved.token,
      account_id: identifier(saved.account_id, 'saved account ID', saved.token),
    };
  }

  async function account(): Promise<VerifiedAccount> {
    const saved = await credentials();
    const state = await request('/api/assistant/status', {}, saved.token);
    if (!isObject(state) || state.status !== 'connected' || state.account_id !== saved.account_id) {
      throw new Error('The connected Playground account changed or is unavailable. Connect again.');
    }
    return Object.freeze({ ...connectionInfo(state, saved.token, true), token: saved.token });
  }

  /**
   * Verify saved credentials before pairing. Returns the connection when they are
   * still valid, or null when there are none or the server rejects them. Any other
   * failure is thrown so an undecidable check never replaces a working credential.
   */
  async function existingConnection(): Promise<ConnectionInfo | null> {
    const saved = await readPrivateJSON<unknown>(credentialFile, null);
    if (saved === null) return null;
    let current: StoredCredential;
    try {
      current = await credentials();
    } catch {
      return null; // Unusable local file; pairing replaces it.
    }
    let state: JsonObject;
    try {
      state = await request('/api/assistant/status', {}, current.token);
    } catch (error) {
      if (error instanceof APIError && (error.status === 401 || error.status === 403)) return null;
      throw new Error(
        'Could not verify the existing Playground connection, so it was kept and the pairing code was not used. ' +
          'Try again, or run playgroundvibes logout before connecting.',
        { cause: error },
      );
    }
    if (!isObject(state) || state.status !== 'connected' || state.account_id !== current.account_id)
      return null;
    return connectionInfo(state, current.token, true);
  }

  async function connect(input: string): Promise<ConnectResult> {
    const code = typeof input === 'string' ? input.trim().toUpperCase().replace(/-/g, '') : '';
    if (!/^[A-Z2-9]{8}$/.test(code))
      throw new Error('Use the eight-character pairing code from Playground.');
    return withLock(configDir, async () => {
      const existing = await existingConnection();
      if (existing) return Object.freeze({ ...existing, already_connected: true as const });
      const pendingFile = path.join(configDir, 'pairing.json');
      const prior = await readPrivateJSON<unknown>(pendingFile, null);
      const token =
        isObject(prior) && prior.code_hash === sha(code) && isToken(prior.token)
          ? prior.token
          : 'pgimport_' + randomBytes(32).toString('hex');
      // Persist before redemption so an interrupted request reuses the same hash.
      await writeJSON(pendingFile, { code_hash: sha(code), token });
      const linked = await request('/api/assistant/pair-redeem', {
        code,
        token_hash: sha(token),
        label: ('CLI on ' + os.hostname()).slice(0, 80),
      });
      const connection = connectionInfo(linked, token, false);
      await writeJSON(credentialFile, { origin: ORIGIN, token, account_id: connection.account_id });
      await fs.rm(pendingFile, { force: true });
      return connection;
    });
  }

  async function whoami(): Promise<ConnectionInfo> {
    return withLock(configDir, async () => {
      const verified = await account();
      return connectionInfo(verified, verified.token, true);
    });
  }

  async function logout(): Promise<LogoutResult> {
    return withLock(configDir, async () => {
      const saved = await readPrivateJSON<unknown>(credentialFile, null);
      if (saved !== null) {
        const current = await credentials();
        try {
          await request('/api/assistant/disconnect', {}, current.token);
        } catch (error) {
          if (!error || typeof error !== 'object' || !('status' in error) || error.status !== 401)
            throw error;
        }
        await fs.rm(credentialFile, { force: true });
      }
      return { disconnected: true };
    });
  }

  return Object.freeze({ configDir, connect, whoami, logout, account });
}
