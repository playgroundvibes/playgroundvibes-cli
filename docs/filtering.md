# Filtering and inspection

File selection and credential checks follow the owner’s original Node bundle. Every regular file format and extension is eligible, subject to its path exclusions and size limits. Each selected file is checked through `Buffer.toString('utf8')`; its original bytes are retained for the upload. A literal credential match or exceeded upload limit blocks preparation. Excluded files are skipped and reported.

Run `playgroundvibes deploy --dry-run` for an offline review, or add `--json` for the complete review as JSON. Review the included source, browser build, cover, metadata, and exclusions. Passing these checks does not publish anything or supply consent.

## Where each decision lives

| Source file                        | Responsibility                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/filtering/collect-files.ts`   | Traverse source/build files, apply exclusions and limits, check eligible contents, and retain bytes and hashes. |
| `src/filtering/path-exclusions.ts` | The original exclusions as named rules, safe relative paths, ignore scopes, and exclusion provenance.           |
| `src/filtering/limits.ts`          | `MIB` and the readonly `INSPECTION_LIMITS` table; there is no file-type allowance list.                         |
| `src/filtering/inspect-file.ts`    | Pass each file’s direct UTF-8 representation to the literal checks.                                             |
| `src/filtering/secret-patterns.ts` | The readonly `CREDENTIAL_PATTERNS` table copied from the original policy.                                       |
| `src/filtering/scan-text.ts`       | Check supplied text without decoding or adding scanner rules.                                                   |
| `src/filtering/findings.ts`        | `ScanError` diagnostics with path, line, and rule, without matched content.                                     |
| `src/filtering/index.ts`           | Curated public exports at `@playgroundvibes/cli/filtering`.                                                     |
| `src/artifacts/pack-project.ts`    | Create a deterministic ZIP from retained bytes without rereading files.                                         |
| `src/artifacts/inspect-cover.ts`   | Check an explicitly selected cover’s path, extension, size, and direct UTF-8 representation.                    |
| `src/publishing/prepare.ts`        | Check metadata, assemble the review, and bind the upload snapshot to a consent digest.                          |

Project/manifest loading lives in `src/project/load-project.ts`; browser output selection is in `src/project/browser-build.ts`. Metadata schema validation is in `src/project/metadata.ts`. Review rendering is in `src/cli/output.ts`.

## File selection

Source collection applies nested `.gitignore` rules and the root `.playgroundignore`. Browser builds apply the root `.playgroundignore`. A gitignored build directory (the usual `dist/`) bypasses `.gitignore`; a build directory Git tracks, such as `build_dir: ".."` for a static site, applies `.gitignore` exactly as source does, so gitignored local files are not uploaded. An excluded directory is not traversed. Source collection also omits top-level `dist`, `build`, and `out`; selected browser output is collected separately.

Mandatory exclusions match artifact-relative paths: source paths start at the project root, while build paths start at the selected build directory. `.playgroundignore` patterns use project-relative paths, so `dist/private.json` applies to that file in a build rooted at `dist`. Only the project-root `.playgroundignore` supplies these rules. Ignore negations cannot restore mandatory exclusions.

Unsafe relative paths, symlinks, and nonregular entries are skipped and reported. Unsafe paths include traversal components, paths longer than 240 characters, backslashes, colons, and the original control/directional characters. Explicit project and artifact paths must stay inside the project and cannot pass through symlinks. The project cannot be the home or filesystem root, and private Playground configuration must remain outside it.

Ignore-file contents are read as UTF-8 representations to apply their patterns. Reading a file for ignore rules does not itself scan its contents: it receives credential checks only if it is also eligible for upload. Filenames are not credential-scanned. Included files are checked, counted, and retained; neither file extensions nor byte formats restrict source/build selection. Browser output must include a root `index.html`, and empty artifacts are rejected.

An explicit `cover_file` resolves relative to `.playground/` and must select a project-local regular PNG, JPG/JPEG, or WebP file of at most 3 MiB without symlinked paths. As in the original bundle, this separate selection does not apply `.gitignore`, `.playgroundignore`, or the source/build filename exclusions. Its direct UTF-8 representation receives the same credential checks. Review the cover separately; omitting it requires removing `cover_file`.

## Built-in exclusions

`BUILT_IN_EXCLUSIONS` in `path-exclusions.ts` is the authoritative, readonly table. Each entry has an ID, reason, match kind, and patterns. Matching is case-insensitive; component rules apply at any depth within the artifact.

| Rule ID                 | Matching names or suffixes                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `environment-files`     | `.env` and `.env.*`                                                                                                                      |
| `version-control`       | `.git`, `.hg`, `.svn`                                                                                                                    |
| `dependencies`          | `node_modules`, `vendor`, `.venv`, `venv`, `__pycache__`                                                                                 |
| `generated-directories` | `.cache`, `.next`, `.nuxt`, `coverage`, `.playground`, `.sites-runtime`, `.wrangler`                                                     |
| `private-settings`      | `.aws`, `.ssh`, `.gnupg`, `.openai`, `.npmrc`, `.pypirc`, `.netrc`                                                                       |
| `assistant-settings`    | `.codex`, `.claude`, `.agents`                                                                                                           |
| `credential-filenames`  | Names beginning with `credentials`, `secret`, `serviceaccount`, `service-account`, or `service_account`; exact `id_rsa` and `id_ed25519` |
| `private-keys-and-logs` | `.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`, `.log` suffixes                                                                     |
| `private-records`       | `conversation(s)`, `chat(s)`, `message(s)`, or `user(s)` followed by `.json`, `.jsonl`, `.html`, `.csv`, or `.txt`                       |

These are the original rules plus `.agents`, which holds project agent skills such as the installed `playground-upload` skill. There are no other editor, agent, cloud, or source-map exclusions. For example, `.cursor`, `.vscode`, `.envrc`, and `.map` files are not excluded merely by those names. Use `.playgroundignore` for additional source/build omissions needed by the selected project.

Although `.playground` is excluded from source packaging, the manifest is read separately. Final metadata and account/project destination fields receive the literal credential checks during preparation.

## Exclusion provenance

An example `review.excluded` entry for line 2 of the root `.playgroundignore` is:

```json
{
  "artifact": "build",
  "path": "dist/private.json",
  "reason": ".playgroundignore",
  "source": "playgroundignore",
  "rule": "dist/private.json",
  "ignoreFile": ".playgroundignore",
  "line": 2
}
```

`source` is `built-in`, `gitignore`, or `playgroundignore`. `rule` identifies the policy or ignore pattern; `ignoreFile` and its one-based `line` identify the rule location when available.

Included `files[].path` values are artifact-relative for source/build and project-relative for covers. Exclusion paths and ignore-file locations are project-relative. Paths use `/` separators. Retain the artifact label when comparing entries because one local file can appear in more than one uploaded artifact.

## Literal credential checks

`CREDENTIAL_PATTERNS` lists the exact original regular-expression sources, including their case and word boundaries. The patterns cover private-key markers and Playground import/sync, OpenAI/Anthropic, GitHub classic/fine-grained, AWS, and Slack token forms. `scanText` applies only those patterns to its input; file inspection supplies `Buffer.toString('utf8')`.

There is no Secretlint ruleset, generic credential-assignment or URL check, encoding decoder, UTF-16 string extraction, binary signature filter, or archive unpacking. Invalid UTF-8 does not reject a file: conversion is only a view used for matching, and the original bytes are uploaded. A known literal token present in that view still blocks the operation, including inside a binary file.

Every review states:

> Credential checks match literal patterns in each file’s UTF-8 representation; encoded values and compressed content are not inspected. Review all selected files and metadata before publishing.

The checks do not establish that every secret or private detail is absent. Accepted formats include archives, databases, executables, media, models, and source maps; acceptance is not a promise of server preview support.

## Limits and verification

| Item                       | Limit                      |
| -------------------------- | -------------------------- |
| Source file                | 1 GiB                      |
| Source total / file count  | 1 GiB / 500                |
| Browser file               | 1 GiB                      |
| Browser total / file count | 1 GiB / 500                |
| Compressed ZIP artifact    | 1 GiB + 2 MiB ZIP overhead |
| Cover image                | 3 MiB                      |
| JSON upload request        | 16 MiB                     |

`INSPECTION_LIMITS` records source/build/archive limits. There is no additional text decoding budget. Manifest loading retains its 256 KiB limit. Large combined requests split at artifact boundaries; no individual part may exceed the request limit.

`test/assets.test.mjs` contains an independent fixture of the original exclusion predicate and verifies byte-format acceptance. `test/files.test.mjs` contains the original credential regex fixture, provider/word-boundary cases, and encoded/generic values that the original checks accept. These offline parity checks accompany snapshot, archive, and upload-contract tests; they do not contact or certify the live service.

The build-selection safeguard remains: use an explicit `build_dir`, or exactly one detected `dist`, `build`, or `out` containing `index.html`. Source-only publication requires `source_only: true`. Review and explicit consent remain necessary before the retained bytes are sent.

The combined source, build, and cover must fit 1 GiB and 500 files. Scanning and packaging use private disk snapshots and bounded memory. Large files are scanned in 256 KiB chunks with an 8 KiB overlap; this detects literal patterns across chunk boundaries but is not a general secret detector.
