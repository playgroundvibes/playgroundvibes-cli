import type { ExcludedFile, Review } from '../publishing/types.js';
import { ScanError } from '../filtering/index.js';

const help = `Usage: playgroundvibes [--config-dir DIR] <command> [options]

Commands:
  login [--no-browser]     Open Playground Vibes to obtain a connection code
  connect CODE            Save the account connection for this computer
  whoami                  Show the connected account
  logout                  Remove the saved account connection
  deploy [--dry-run] [--json] [--consent SHA256]
                          Review this project's files and publish with consent
  skill path              Print the bundled agent skill directory
  skill install [--path DIR]
                          Install the skill (default: .agents/skills/playground-upload)

Options:
  --config-dir DIR        Use a different private configuration directory
  -h, --help              Show this help
  -v, --version           Show the package version

Deploy reads .playground/manifest.json in the current project. --dry-run scans
and reviews files offline without credentials, configuration writes, or uploads.
Unsupported binary/archive files and cover_file are blocked; exclude unneeded
assets explicitly in .playgroundignore before reviewing again.
Review the complete included files, exclusions, destination, and account before
publishing. Interactive deploy requires typing PUBLISH. Noninteractive deploy
and --json require --consent with the exact account-bound review digest.
There is no --yes option. A changed project or account requires a fresh review.

Deployment sends source and optional browser build files to Playground Vibes.
A completed import publishes the listing and available browser preview;
source download and remix permission are separate choices.
Playground keeps private Git history and may improve supported browser projects.
A later local upload replaces those server changes.

Requires Node.js 22+. Installing the package does not install its skill or upload
a project. Run "playgroundvibes skill install" to add the skill explicitly.
`;

export function printHelp(): void {
  process.stdout.write(help);
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value ?? null)}\n`);
}

function formatExclusion(file: ExcludedFile): string {
  const provenance = [
    `source: ${JSON.stringify(file.source)}`,
    `rule: ${JSON.stringify(file.rule)}`,
  ];
  if (file.ignoreFile) {
    let location = JSON.stringify(file.ignoreFile);
    if (file.line !== undefined) location += `:${file.line}`;
    provenance.push(`file: ${location}`);
  }
  const description = `  [${file.artifact}] ${JSON.stringify(file.path)}: ${JSON.stringify(file.reason)}`;
  return `${description} (${provenance.join('; ')})`;
}

/** Print every selected file, exclusion, and final metadata value without truncation. */
export function printReview(review: Review, dryRun: boolean, asJson: boolean): void {
  if (asJson) {
    printJson({ type: 'review', dryRun, review });
    return;
  }
  const lines = [
    dryRun ? 'Offline deployment review (no upload)' : 'Deployment review (no upload yet)',
    `Destination: ${review.origin}`,
    `Account: ${JSON.stringify(review.accountId ?? 'not resolved during offline review')}`,
    `Project: ${JSON.stringify(review.projectId ?? 'new project')}`,
    `Local folder: ${JSON.stringify(review.root)}`,
    `Title: ${JSON.stringify(review.title)}`,
    `Summary: ${JSON.stringify(review.summary)}`,
    '',
    'Final project metadata:',
    JSON.stringify(review.metadata, null, 2),
    '',
    `Included files (${review.files.length}, ${review.bytes} bytes):`,
    ...review.files.map(
      (file) =>
        `  [${file.artifact}] ${JSON.stringify(file.path)} (${file.bytes} bytes; SHA256 ${file.sha256})`,
    ),
    '',
    `Excluded paths (${review.excluded.length}):`,
    ...(review.excluded.length ? review.excluded.map(formatExclusion) : ['  None']),
    '',
    'Source and any browser build files above will be sent to Playground Vibes.',
    'A completed import publishes the listing and available browser preview.',
    'Source download and remix permission are separate choices.',
    `Publication: ${review.publication}`,
    ...review.warnings.map((warning) => `Warning: ${JSON.stringify(warning)}`),
    '',
    `Review digest: ${review.digest}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

export function printError(error: unknown, asJson: boolean): void {
  let message = error instanceof Error ? error.message : String(error);
  if (
    error instanceof ScanError &&
    error.findings.some((finding) =>
      ['inspection/unsupported-file-type', 'inspection/binary-or-archive'].includes(finding.rule),
    )
  ) {
    message +=
      ' This release cannot inspect that file type. Exclude unneeded assets in .playgroundignore, then review again.';
  }
  if (asJson) printJson({ type: 'error', error: message });
  else process.stderr.write(`Error: ${message}\n`);
}
