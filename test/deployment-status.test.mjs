import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForDeployment } from '../dist/cli/deployment-status.js';
import { parseArguments } from '../dist/cli/arguments.js';

const pending = {
  status: 'imported',
  id: 'project',
  version_id: 'version',
  url: 'https://playgroundvibes.com/#project/project',
  published: false,
  publication: 'processing',
  processing: { status: 'queued' },
};
test('waiting follows server publication without uploading or declaring queued builds ready', async () => {
  const progress = [],
    states = [
      { ...pending, processing: { status: 'validating' } },
      {
        ...pending,
        published: true,
        publication: 'published',
        preview: 'overview',
        processing: { status: 'complete' },
      },
    ];
  const result = await waitForDeployment(
    pending,
    async () => states.shift(),
    (s) => progress.push(s.processing.status),
    { intervalMs: 0 },
  );
  assert.equal(result.published, true);
  assert.equal(result.preview, 'overview');
  assert.deepEqual(progress, ['queued', 'validating']);
  const failed = {
    ...pending,
    publication: 'failed',
    processing: { status: 'failed', error: 'Build needs attention' },
  };
  assert.equal(
    (
      await waitForDeployment(
        pending,
        async () => failed,
        () => {},
        { intervalMs: 0 },
      )
    ).published,
    false,
  );
  let reads = 0;
  const expired = await waitForDeployment(
    pending,
    async () => {
      reads++;
      return pending;
    },
    () => {},
    { timeoutMs: 0 },
  );
  assert.equal(reads, 0);
  assert.equal(expired.publication, 'processing');
  assert.match(expired.message, /status --wait/);
});
test('status and upload waiting flags parse independently of publication consent', () => {
  assert.deepEqual(
    parseArguments(['status', '--wait', '--json', '--version-id', 'version']).command,
    { name: 'status', wait: true, json: true, versionId: 'version' },
  );
  assert.equal(parseArguments(['deploy', '--no-wait']).command.noWait, true);
  assert.throws(() => parseArguments(['status', '--version-id']), /requires a value/);
});
