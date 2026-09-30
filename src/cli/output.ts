import type { ExcludedFile, Review } from '../publishing/types.js';

const help = `Usage: playgroundvibes [--config-dir DIR] <command> [options]

Commands:
  login [--no-browser]     Open Playground Vibes to obtain a connection code
  connect CODE            Save the account connection for this computer
  whoami                  Show the connected account
  logout                  Remove the saved account connection
  deploy [--dry-run] [--json] [--consent SHA256]
                          Review this project's files and publish with consent
  skill path              Print the bundled agent skill directory
  skill install [--path DIR] [--claude|--codex]
                [--allow-claude-commands|--allow-codex-commands]
                [--package-manager npm|pnpm]
                          Install the skill (default: .agents/skills/playground-upload)

Options:
  --config-dir DIR        Use a different private configuration directory
  -h, --help              Show this help
  -v, --version           Show the package version

Deploy reads .playground/manifest.json in the current project. --dry-run scans
and reviews files offline without credentials, configuration writes, or uploads.
Build the browser app first. Set build_dir relative to .playground/, or let the
CLI select one of dist/, build/, or out/ containing index.html. Missing or
ambiguous builds require correction. Set source_only: true in the manifest only
when intentionally publishing without a browser preview. The CLI does not run builds.
All file types and extensions are accepted for regular files under the original
bundle's path exclusions and size limits. Checks match only its literal credential patterns
in each file's UTF-8 representation; encoded and compressed content is not inspected.
PNG/JPEG/WebP cover_file images up to 3 MiB are supported. Explicit covers do not
apply source/build exclusions or ignore rules. Review these selections carefully.
Source limits are 50 MiB per file/total and 2,000 files; builds allow 3 MiB per file,
10 MiB total, and 150 files. ZIPs are limited to 10 MiB and requests to 16 MiB.
Review the complete included files, exclusions, destination, and account before
publishing. Interactive deploy requires typing PUBLISH. Noninteractive deploy
and --json require --consent with the exact account-bound review digest.
There is no --yes option. A changed project or account requires a fresh review.

Deployment sends source, optional browser build files, and a selected cover to Playground Vibes.
A completed import publishes the listing and available browser preview;
source download and remix permission are separate choices.
Playground keeps private Git history and may improve supported browser projects.
A later local upload replaces those server changes.

Requires Node.js 22+. Installing the package does not install its skill or upload
a project. Run "playgroundvibes skill install" to add the skill explicitly.

skill install --claude uses .claude/skills/playground-upload unless --path is set.
In a terminal, it asks whether to enable commands for the current project [y/N].
Accepting ensures the same package version is installed globally, then merges
Bash(playgroundvibes:*) into the project's .claude/settings.local.json.
Declining or running without a terminal installs only the skill.
With --claude, --allow-claude-commands enables setup without prompting.
Setup uses the invoking npm/pnpm automatically; --package-manager npm|pnpm
overrides that choice and requires --claude or --codex.

skill install --codex uses .agents/skills/playground-upload (where Codex reads
project skills) unless --path is set, and asks the same [y/N] question. Accepting
ensures the global CLI, then writes .codex/rules/playgroundvibes.rules with
prefix_rule(pattern = ["playgroundvibes"], decision = "allow"). An existing
different rules file is preserved and reported. Codex loads project rules only
for trusted projects. --allow-codex-commands enables setup without prompting.
This permission setup does not grant publication consent.

Unrecognized --options are ignored with a warning instead of failing.
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
    'Source, browser build files, and any selected cover above will be sent to Playground Vibes.',
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
  const message = error instanceof Error ? error.message : String(error);
  if (asJson) printJson({ type: 'error', error: message });
  else process.stderr.write(`Error: ${message}\n`);
}
