import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPlaygroundClient } from '../dist/index.js';

const sha = (value) => createHash('sha256').update(value).digest('hex');

// Contract fixture derived from the supplied owner's bin/playgroundvibes.mjs:
// pairing at lines 105–112, status/logout at 33–38/115, import at 62–90.
// All HTTP is replaced here; the real transport serializes the request bodies.
test('wire requests retain the owner CLI protocol and never send local review or consent fields', async (t) => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'playground-protocol-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'app');
  const configDir = path.join(base, 'private');
  await fs.mkdir(path.join(root, '.playground'), { recursive: true });
  await fs.writeFile(path.join(root, 'main.ts'), 'export const greeting = "hello";\n');
  await fs.writeFile(
    path.join(root, '.playground', 'manifest.json'),
    JSON.stringify({
      title: 'Wire contract',
      summary: 'An offline protocol fixture.',
      date: '2020-01-01',
    }),
  );
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    calls.push({ url, body, authorization: options.headers.Authorization });
    let response;
    if (url === 'https://playgroundvibes.com/api/assistant/pair-redeem') {
      response = { account_id: 'protocol-account' };
    } else if (url === 'https://playgroundvibes.com/api/assistant/status') {
      assert.deepEqual(body, {});
      response = { status: 'connected', account_id: 'protocol-account' };
    } else if (url === 'https://playgroundvibes.com/api/assistant/import') {
      response = {
        status: 'imported',
        id: 'protocol-project',
        version_id: 'protocol-version',
        url: '/#project/protocol-project',
        preview: null,
        processing: {},
      };
    } else if (url === 'https://playgroundvibes.com/api/assistant/disconnect') {
      assert.deepEqual(body, {});
      response = { disconnected: true };
    } else {
      assert.fail(`Unexpected endpoint: ${url}`);
    }
    return new Response(JSON.stringify(response), { status: 200 });
  });
  const client = createPlaygroundClient({ cwd: root, configDir });
  await client.connect('abcd-2345');
  const credential = JSON.parse(await fs.readFile(path.join(configDir, 'connection.json'), 'utf8'));
  assert.deepEqual(calls[0].body, {
    code: 'ABCD2345',
    token_hash: sha(credential.token),
    label: ('CLI on ' + os.hostname()).slice(0, 80),
  });
  assert.equal(calls[0].authorization, undefined);
  const review = await client.prepare();
  await client.deploy(review, { consent: review.digest });
  const upload = calls.find((call) => call.url.endsWith('/import')).body;
  assert.deepEqual(Object.keys(upload).sort(), [
    'artifact_hashes',
    'more_artifacts',
    'operation_id',
    'projects',
    'version',
  ]);
  assert.equal(upload.version, 1);
  assert.equal(upload.more_artifacts, false);
  assert.match(upload.operation_id, /^[0-9a-f-]{36}$/);
  assert.equal(upload.projects.length, 1);
  const entry = upload.projects[0];
  assert.deepEqual(Object.keys(entry).sort(), [
    'category',
    'date',
    'license',
    'remix',
    'source',
    'source_id',
    'summary',
    'title',
  ]);
  assert.deepEqual(upload.artifact_hashes, { source: sha(entry.source) });
  assert.equal(Buffer.from(entry.source, 'base64').subarray(0, 2).toString(), 'PK');
  assert.equal(entry.source_id, review.metadata.source_id);
  for (const localField of [
    'review',
    'consent',
    'digest',
    'root',
    'accountId',
    'excluded',
    'warnings',
  ]) {
    assert.equal(Object.hasOwn(upload, localField), false);
    assert.equal(Object.hasOwn(entry, localField), false);
  }
  await client.logout();
  for (const call of calls.slice(1)) assert.equal(call.authorization, `Bearer ${credential.token}`);
  assert.equal(calls.at(-1).url, 'https://playgroundvibes.com/api/assistant/disconnect');
});
