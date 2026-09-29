# Filtering and inspection

The CLI selects files, inspects their contents, and builds archives from the exact bytes it inspected. An excluded path is omitted and reported. An inspection failure blocks preparation of the upload; it does not silently remove the offending file.

Use `playgroundvibes deploy --dry-run` for an offline review, or add `--json` for the complete review as JSON. Inspect the included files, exclusions, and final metadata. Passing inspection does not publish anything or supply publication consent.

## Where each decision lives

| Source file                          | Responsibility                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/filtering/collect-files.ts`     | Walk the selected artifact, resolve paths, apply exclusions, inspect eligible files, and retain their bytes and hashes.        |
| `src/filtering/path-exclusions.ts`   | Named built-in exclusion rules, safe relative paths, ignore-file scopes, and the rule responsible for each exclusion.          |
| `src/filtering/file-types.ts`        | Supported text extensions and filenames, UTF-8 validation, and file/archive size limits.                                       |
| `src/filtering/binary-signatures.ts` | Named binary header tables, offset matching, and structural checks for encoded archive headers.                                |
| `src/filtering/scan-text.ts`         | Run fixed Secretlint rules and supplemental checks over original and decoded text.                                             |
| `src/filtering/secret-patterns.ts`   | Provider token patterns, credential assignments, private keys, authorization headers, and credentials embedded in URLs.        |
| `src/filtering/encoded-content.ts`   | Find and decode supported encoded forms within explicit depth, byte, and candidate limits.                                     |
| `src/filtering/findings.ts`          | `ScanError` and diagnostics containing locations and rule IDs, without matched values or source excerpts.                      |
| `src/filtering/index.ts`             | Public filtering exports, available through `@playgroundvibes/cli/filtering`.                                                  |
| `src/artifacts/pack-project.ts`      | Create a deterministic ZIP from inspected bytes; never reread source files to build it.                                        |
| `src/publishing/prepare.ts`          | Scan final metadata and destination, collect source/build reviews, and bind the immutable upload snapshot to a consent digest. |

Project-root and manifest validation happen in `src/project/load-project.ts`; metadata schema validation lives in `src/project/metadata.ts`. Review rendering, including exclusion provenance, lives in `src/cli/output.ts`.

## Selection order

1. Validate the project and artifact roots. Paths must stay inside the selected project. The private Playground configuration must remain outside it. The home directory and filesystem root cannot be selected as projects.
2. Read and inspect the project-root `.playgroundignore`. During source traversal, also read and inspect each visited directory's `.gitignore` before applying its rules.
3. For every encountered entry, inspect its project-relative filename and validate its artifact-relative path before putting it in a report. A filename containing a detected credential blocks inspection with `[filename]` as its diagnostic path.
4. Apply exclusions in order: symbolic links, named built-in rules, `.playgroundignore`, source `.gitignore` rules, then the source-only separation of top-level `dist`, `build`, and `out`. Record the first applicable exclusion. An excluded directory is not traversed; its entry represents the omitted subtree.
5. Require each remaining entry to be a regular file of a supported text type. Check its size, read it without following a final symlink, validate its bytes, and scan its text. Enforce total byte and file-count limits.
6. Build the archive from the retained inspected bytes. The browser build must include `index.html` at its artifact root; an empty artifact is rejected. Check compressed archive size before returning the review.

This ordering matters: excluded content is generally not read or scanned, but filenames are checked before exclusion. Ignore files consulted by the walker are themselves inspected even when their patterns would exclude them. A symlink encountered as an entry is excluded; selecting an artifact or resolving a project path through a symlink is an error.

## Built-in exclusions

`BUILT_IN_EXCLUSIONS` in `path-exclusions.ts` is the authoritative, readonly table. Each entry has a stable ID, reason, match kind, and patterns. Named components and component patterns apply at any depth; built-in matching is case-insensitive.

| Rule ID                                    | Representative paths or names                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `environment-files`                        | `.env`, `.env.local`, `.env.example`, `.envrc`                                       |
| `version-control`                          | `.git`, `.git-credentials`, `.hg`, `.svn`                                            |
| `dependencies`                             | `node_modules`, `vendor`, `.venv`, `venv`, `__pycache__`                             |
| `generated-directories`                    | `.cache`, `.next`, `.nuxt`, `coverage`, `.playground`, `.sites-runtime`, `.wrangler` |
| `private-settings`                         | `.aws`, `.ssh`, `.config`, `.npmrc`, `.netrc`, `.docker`, `.kube`                    |
| `assistant-settings` / `assistant-history` | `.codex`, `.claude`, `.agents`, `.cursor`, `.aider*`                                 |
| `editor-settings`                          | `.history`, `.idea`, `.vscode`, `.DS_Store`                                          |
| `credential-filenames`                     | `credentials*`, `secret*`, service-account names, `id_rsa`, `id_ed25519`             |
| `private-keys-and-logs`                    | `.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`, `.log` suffixes                 |
| `private-records`                          | Names such as `chat.json`, `messages.csv`, and `users.txt`                           |
| `source-maps`                              | `.map` suffixes, including browser build source maps                                 |

`structuralExclusion` adds `symbolic-links` and `separate-build-output`. The latter applies only to source artifact top-level `dist`, `build`, and `out`; a selected browser build is inspected separately. Ignore-file negations cannot restore mandatory exclusions.

Although `.playground` is excluded from source packaging, its manifest is read separately. The validated metadata actually destined for upload, including title, description, licensing, and creation details, is scanned in `prepare.ts`. Account/project destination fields are scanned separately too. Excluding the settings directory does not bypass those checks.

## Ignore rules and provenance

Source collection uses the root `.gitignore` and nested `.gitignore` files in directories it visits. Patterns are relative to their owning directory. Nested negations can reverse inherited matches for files in traversed directories; they cannot reach into an already excluded directory.

Browser build collection does **not** apply `.gitignore`. A build commonly lives in a gitignored directory, and its selected files must still be inspected.

The root `.playgroundignore` applies to both source and build, using project-relative paths. For example, `dist/private.json` excludes that file from a build rooted at `dist`. Only the project-root `.playgroundignore` supplies these rules. Its matches take precedence over `.gitignore`; a `.gitignore` negation cannot undo a `.playgroundignore` exclusion.

The following is a representative `review.excluded` entry when line 2 of the root `.playgroundignore` contains `dist/private.json`:

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

`source` is `built-in`, `gitignore`, or `playgroundignore`. `rule` is the built-in policy ID or matching ignore pattern. `ignoreFile` and its one-based `line` identify an ignore rule when available; built-in entries omit them. The review adds `artifact: "source" | "build"` to each exclusion.

Included `files[].path` values are **artifact-relative**: a build file might be `index.html`. Excluded `excluded[].path` and `ignoreFile` values are **project-relative**: the same build might report `dist/private.json`. Both use `/` separators. Keep `artifact` when comparing entries because source and build can contain the same relative filename.

## Text, binary, and credential checks

The readonly `SOURCE_TEXT_EXTENSIONS`, `BUILD_TEXT_EXTENSIONS`, and `SOURCE_TEXT_FILENAMES` tables in `file-types.ts` define supported types. Source supports application code, documentation, and selected configuration files; build supports a smaller set of browser/text assets. Consult those tables for the exact list instead of assuming that every text-looking extension is accepted.

An allowed extension does not establish that its content is text. `decodePlainText` checks named binary headers, strict UTF-8 decoding, and disallowed control characters. For example, an archive renamed to `.json` still blocks inspection. Unsupported images, fonts, databases, archives, and `cover_file` are not uploaded by this release. Exclude an unneeded asset explicitly with `.playgroundignore`; doing so also removes it from the uploaded app.

`BINARY_SIGNATURES` in `binary-signatures.ts` makes header checks inspectable: each entry names a format and lists required ASCII or byte sequences at explicit offsets. Every part must match. Examples include TAR's `ustar` marker at offset 257, and WebP/WAVE checks combining `RIFF` at offset 0 with their subtype at offset 8. `ENCODED_CONTAINER_SIGNATURES` uses longer signatures for incidental encoded strings; ZIP and gzip also have structural header checks. These are recognition rules, not parsers for every format or an exhaustive guarantee about binary content. Archives are blocked, not unpacked for inspection.

Text inspection combines Secretlint's recommended provider rules with the supplemental patterns in `secret-patterns.ts`. It checks provider tokens, private-key markers, literal credential assignments, authorization values, and URL credentials. Recognized runtime environment references are allowed. Repository Secretlint configuration and suppression comments cannot disable the package's checks.

`encoded-content.ts` supplies bounded decoded variants for repeated inspection: supported Unicode/hex escapes, percent encoding, HTML entities, base64 data URLs, literal `atob`/`Buffer.from` operands, and plausible standalone hex/base64 strings. Recognizable encoded UTF-16 text is also inspected. Explicit encoded binary payloads block inspection. Incidental hashes are treated more cautiously so a digest that happens to decode to a short binary prefix is not automatically rejected. This is static inspection; it does not execute the app or reconstruct every possible encoding or dynamically assembled value.

Credential findings, malformed content, unsafe paths, unsupported file types, scanner failures, and exceeded inspection budgets block the operation. Findings show paths, lines, and rule IDs, not matched secret values. Decoded credential findings carry a `/decoded` rule suffix and use tracked source-line information instead of displaying decoded content.

## Limits and review boundaries

`INSPECTION_LIMITS` in `file-types.ts` defines source/build file limits of 4/3 MiB, total uncompressed limits of 50/10 MiB, file-count limits of 2,000/150, and a 10 MiB compressed limit per artifact. `scanText` also caps each input at 4 MiB. `DECODING_LIMITS` in `encoded-content.ts` caps generated decoded bytes at 12 MiB, variants at 128, nesting depth at 4, and candidates at 2,048. `load-project.ts` caps the manifest at 256 KiB. Crossing a limit blocks inspection rather than skipping the remaining work.

Inspection reduces risk but cannot establish that every secret or private detail is absent. Generic credentials, unsupported encodings, and personal data can fall outside its patterns; ordinary example values can also trigger conservative credential rules. Review the actual selected files and metadata, and investigate a blocker rather than assuming it is harmless. The review describes the immutable bytes selected for that operation; later edits require a fresh review to be included.
