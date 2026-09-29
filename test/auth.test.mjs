import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAuth } from '../dist/auth/connection.js';
import {
  getConfigDir,
  readJSON,
  readPrivateJSON,
  writeJSON,
  withLock,
} from '../dist/storage/local-state.js';
import { APIError, ORIGIN, request } from '../dist/api/transport.js';

const token = 'pgimport_' + 'a'.repeat(64);
const sha = (value) => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'playground-auth-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    configDir: path.join(root, 'config'),
    credential: path.join(root, 'config', 'connection.json'),
  };
}

test('pairing stores a private token, sends only its hash, and whoami omits it', async (t) => {
  const { configDir, credential } = await fixture(t);
  const calls = [];
  const auth = createAuth({
    configDir,
    request: async (endpoint, body, suppliedToken) => {
      calls.push({ endpoint, body, suppliedToken });
      if (endpoint.endsWith('/pair-redeem'))
        return { account_id: 'account-1', expires_at: '2099-01-01T00:00:00Z' };
      if (endpoint.endsWith('/status'))
        return { status: 'connected', account_id: 'account-1', token: suppliedToken };
      if (endpoint.endsWith('/disconnect')) return { disconnected: true };
      throw new Error('Unexpected endpoint');
    },
  });
  assert.equal((await auth.connect('abcd-2345')).account_id, 'account-1');
  const saved = await readPrivateJSON(credential);
  assert.match(saved.token, /^pgimport_[a-f0-9]{64}$/);
  assert.equal(saved.origin, ORIGIN);
  assert.deepEqual(calls[0].body.code, 'ABCD2345');
  assert.equal(calls[0].body.token_hash, sha(saved.token));
  assert.equal(calls[0].suppliedToken, undefined);
  assert.equal(JSON.stringify(calls[0]).includes(saved.token), false);
  if (process.platform !== 'win32') assert.equal((await fs.stat(credential)).mode & 0o777, 0o600);
  assert.equal((await auth.whoami()).token, undefined);
  assert.equal((await auth.account()).token, saved.token);
  assert.deepEqual(await auth.logout(), { disconnected: true });
  await assert.rejects(fs.stat(credential), { code: 'ENOENT' });
});

test('retrying a lost pairing response reuses the pending token hash', async (t) => {
  const { configDir, credential } = await fixture(t);
  const hashes = [];
  const auth = createAuth({
    configDir,
    request: async (_endpoint, body) => {
      hashes.push(body.token_hash);
      if (hashes.length === 1) throw new Error('Simulated lost response');
      return { account_id: 'account-1' };
    },
  });
  await assert.rejects(auth.connect('ABCD2345'), /Simulated lost response/);
  const pending = await readPrivateJSON(path.join(configDir, 'pairing.json'));
  await auth.connect('ABCD2345');
  assert.equal(hashes[0], hashes[1]);
  assert.equal((await readPrivateJSON(credential)).token, pending.token);
  await assert.rejects(fs.stat(path.join(configDir, 'pairing.json')), { code: 'ENOENT' });
});

test('public connection results whitelist validated fields and omit nested server credential echoes', async (t) => {
  const { configDir, credential } = await fixture(t);
  await writeJSON(credential, { origin: ORIGIN, token, account_id: 'account-1' });
  const auth = createAuth({
    configDir,
    request: async () => ({
      status: 'connected',
      account_id: 'account-1',
      project_id: 'project-1',
      expires_at: null,
      token,
      access_token: token,
      account: { token },
      arbitraryServerField: 'not a public field',
    }),
  });
  const result = await auth.whoami();
  assert.deepEqual(result, {
    status: 'connected',
    account_id: 'account-1',
    project_id: 'project-1',
    expires_at: null,
  });
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(Object.isFrozen(result), true);
  const invalid = createAuth({
    configDir,
    request: async () => ({ status: 'connected', account_id: 'account-1', project_id: token }),
  });
  await assert.rejects(invalid.whoami(), /invalid project ID/);
});

test('invalid pairing codes fail without creating configuration or sending requests', async (t) => {
  const { configDir } = await fixture(t);
  const auth = createAuth({
    configDir,
    request: async () => {
      throw new Error('Must not be called');
    },
  });
  await assert.rejects(auth.connect('invalid-000'), /eight-character/);
  await assert.rejects(fs.stat(configDir), { code: 'ENOENT' });
});

test('server-connected status is authoritative and expiry is descriptive metadata', async (t) => {
  const { configDir, credential } = await fixture(t);
  await writeJSON(credential, { origin: ORIGIN, token, account_id: 'account-1' });
  let response = { status: 'connected', account_id: 'different-account' };
  const auth = createAuth({ configDir, request: async () => response });
  await assert.rejects(auth.account(), /account changed/);
  // Both supplied reference clients trust the status response, not a local clock.
  for (const expires_at of ['2000-01-01T00:00:00Z', 'unfamiliar server format', 0, null]) {
    response = { status: 'connected', account_id: 'account-1', expires_at };
    assert.equal((await auth.whoami()).expires_at, expires_at);
  }
  for (const expires_at of [{ unexpected: true }, NaN, token]) {
    response = { status: 'connected', account_id: 'account-1', expires_at };
    assert.equal((await auth.whoami()).expires_at, undefined);
  }
  response = { status: 'expired', account_id: 'account-1' };
  await assert.rejects(auth.account(), /account changed or is unavailable/);
});

test('account and project identifiers remain opaque while controls and credentials are refused', async (t) => {
  const { configDir, credential } = await fixture(t);
  const accountId = 'account:namespace/' + 'a'.repeat(220) + '.region@example';
  const projectId = 'project:namespace/path.version';
  let response = { status: 'connected', account_id: accountId, project_id: projectId };
  const auth = createAuth({ configDir, request: async () => response });
  assert.equal((await auth.connect('ABCD2345')).account_id, accountId);
  assert.equal((await auth.whoami()).project_id, projectId);
  assert.equal((await readPrivateJSON(credential)).account_id, accountId);
  for (const invalid of ['', '   ', 'project\ncontrol', token]) {
    response = { status: 'connected', account_id: accountId, project_id: invalid };
    await assert.rejects(auth.whoami(), /invalid project ID/);
  }
});

test('logout removes revoked credentials but preserves them after transient failures', async (t) => {
  const { configDir, credential } = await fixture(t);
  await writeJSON(credential, { origin: ORIGIN, token, account_id: 'account-1' });
  let status = 503;
  const auth = createAuth({
    configDir,
    request: async () => {
      throw new APIError('Service unavailable', status);
    },
  });
  await assert.rejects(auth.logout(), { status: 503 });
  assert.equal((await readPrivateJSON(credential)).token, token);
  status = 401;
  assert.deepEqual(await auth.logout(), { disconnected: true });
  await assert.rejects(fs.stat(credential), { code: 'ENOENT' });
});

test(
  'ordinary JSON reads allow project identity permissions; credential reads require privacy',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { credential } = await fixture(t);
    await writeJSON(credential, { account_id: 'account-1' });
    await fs.chmod(credential, 0o644);
    assert.deepEqual(await readJSON(credential), { account_id: 'account-1' });
    await assert.rejects(readPrivateJSON(credential), /private permissions/);
  },
);

test(
  'state reads and writes reject file and directory symlinks',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { root, credential } = await fixture(t);
    await writeJSON(credential, { account_id: 'account-1' });
    const link = path.join(root, 'linked.json');
    await fs.symlink(credential, link);
    await assert.rejects(readJSON(link), /symlinked/);
    await assert.rejects(writeJSON(link, {}), /symlinked/);
    const linkedDirectory = path.join(root, 'linked-config');
    await fs.symlink(path.dirname(credential), linkedDirectory);
    await assert.rejects(readJSON(path.join(linkedDirectory, 'connection.json')), /symlinked/);
    await assert.rejects(writeJSON(path.join(linkedDirectory, 'new.json'), {}), /symlinked/);
    assert.deepEqual(await readJSON(credential), { account_id: 'account-1' });
  },
);

test('configuration locks exclude concurrent commands and release after failure', async (t) => {
  const { configDir } = await fixture(t);
  let release;
  let entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const first = withLock(configDir, async () => {
    entered();
    await gate;
    return 42;
  });
  await started;
  try {
    await assert.rejects(
      withLock(configDir, async () => {}),
      /Another Playground command/,
    );
  } finally {
    release();
  }
  assert.equal(await first, 42);
  await assert.rejects(
    withLock(configDir, async () => {
      throw new Error('Simulated failure');
    }),
    /Simulated failure/,
  );
  assert.equal(await withLock(configDir, async () => 'released'), 'released');
});

test('configuration override resolves to an absolute directory', () => {
  assert.equal(getConfigDir('local-playground-config'), path.resolve('local-playground-config'));
});

test('transport pins allowed endpoints, limits request sizes, and never surfaces echoed credentials', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ error: `Rejected credential ${token}` }), { status: 401 });
  });
  await assert.rejects(
    request('/api/assistant/status?redirect=elsewhere', {}, token),
    /Unsupported/,
  );
  await assert.rejects(
    request('/api/assistant/import', { data: 'x'.repeat(16 * 1024 * 1024) }, token),
    /16 MiB/,
  );
  assert.equal(calls.length, 0);
  await assert.rejects(request('/api/assistant/status', {}, token), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.message.includes(token), false);
    return true;
  });
  assert.equal(calls[0].url, ORIGIN + '/api/assistant/status');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${token}`);
});

test('transport rejects oversized and non-object successful responses', async (t) => {
  let response = 'x'.repeat(256 * 1024 + 1);
  t.mock.method(globalThis, 'fetch', async () => new Response(response, { status: 200 }));
  await assert.rejects(request('/api/assistant/status', {}), /bounded Playground response/);
  response = '[]';
  await assert.rejects(request('/api/assistant/status', {}), /unexpected response/);
  response = JSON.stringify({ status: 'connected', account_id: 'account-1' });
  assert.deepEqual(await request('/api/assistant/status', {}), {
    status: 'connected',
    account_id: 'account-1',
  });
});
