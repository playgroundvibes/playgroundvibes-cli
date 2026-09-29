import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function releaseInfo(version, releaseTag) {
  if (
    typeof version !== 'string' ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      version,
    )
  ) {
    throw new Error('Package version must be a valid release version.');
  }
  if (releaseTag !== `v${version}`)
    throw new Error('The Git tag must exactly match v followed by the package version.');
  return {
    file: `playgroundvibes-cli-${version}.tgz`,
    tag: version.split('+')[0].includes('-') ? 'next' : 'latest',
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const result = releaseInfo(manifest.version, process.env.RELEASE_TAG);
  if (!process.env.GITHUB_OUTPUT)
    throw new Error('GITHUB_OUTPUT is required in the publishing workflow.');
  appendFileSync(process.env.GITHUB_OUTPUT, `file=${result.file}\ntag=${result.tag}\n`);
}
