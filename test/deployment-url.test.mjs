import assert from 'node:assert/strict';
import test from 'node:test';
import { readDeploymentStatus } from '../dist/publishing/upload.js';

const receipt = {
  status: 'existing',
  id: 'project-fixture',
  version_id: 'version-fixture',
  published: true,
  publication: 'published',
};

test('current and legacy published receipts return production URLs with version queries intact', () => {
  for (const prefix of ['/project/', '/#project/']) {
    for (const query of ['', '?version=version-fixture']) {
      const result = readDeploymentStatus({ ...receipt, url: prefix + receipt.id + query });
      assert.equal(result.url, 'https://playgroundvibes.com/project/' + receipt.id + query);
      assert.equal(result.published, true);
    }
  }
});

test('private and processing hash links preserve owner access and selected versions', () => {
  for (const publication of ['private', 'processing']) {
    const url = '/#project/project-fixture?version=version-fixture';
    const result = readDeploymentStatus({ ...receipt, published: false, publication, url });
    assert.equal(result.url, 'https://playgroundvibes.com' + url);
  }
});

test('invalid and external receipt URLs still fail completion verification', () => {
  for (const url of [
    'https://playgroundvibes.com/project/project-fixture',
    '//example.com/project/project-fixture',
    '/project/',
    '/project/project-fixture/other',
    '/#project/project-fixture#other',
    '/project/project-fixture?version=bad value',
    '/maker/project-fixture',
  ]) {
    assert.throws(
      () => readDeploymentStatus({ ...receipt, url }),
      /Upload completion could not be verified/,
      url,
    );
  }
});
