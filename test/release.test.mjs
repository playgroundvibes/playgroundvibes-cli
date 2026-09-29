import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseInfo } from '../scripts/release-info.js';

test('stable tags publish the matching artifact to latest', () => {
  assert.deepEqual(releaseInfo('1.2.3', 'v1.2.3'), {
    file: 'playgroundvibes-cli-1.2.3.tgz',
    tag: 'latest',
  });
});
test('prereleases never replace latest', () => {
  assert.equal(releaseInfo('1.2.3-beta.1', 'v1.2.3-beta.1').tag, 'next');
});
test('a mismatched release tag or invalid version is refused', () => {
  assert.throws(() => releaseInfo('1.2.3', 'v9.0.0'), /exactly match/);
  assert.throws(() => releaseInfo('bad\nversion', 'vbad\nversion'), /valid release version/);
});
