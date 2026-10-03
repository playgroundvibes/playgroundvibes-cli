# Server compatibility

This package implements the existing Playground Vibes protocol. Its filtering, review, and consent steps run locally; they do not require a new server endpoint or a change to the import payload.

The compatibility review on September 29, 2026 compared the owner's supplied Node CLI (`bin/playgroundvibes.mjs` and `src/` in the provided `cli` folder), the public [upload helper](https://playgroundvibes.com/playground-upload.py), and its [packager](https://playgroundvibes.com/pack-playground.py). The Node CLI is the reference for pairing. The Python helper has a different connection flow; this package does not combine those authentication flows.

## Requests

All requests are JSON POSTs to `https://playgroundvibes.com`. Authentication uses `Authorization: Bearer TOKEN`, and redirects are rejected.

| Endpoint                     | Request contract                                                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/assistant/pair-redeem` | Normalized eight-character `code`, SHA-256 `token_hash`, and computer `label`. The generated permanent token is saved privately and is not sent in the pairing body. Only called when no saved credential passes the status check first.          |
| `/api/assistant/status`      | Empty object and bearer token. The server must return `status: "connected"` for the saved account. A returned project restriction must agree with the local project link. Before pairing, HTTP 401/403 marks the saved credential as replaceable. |
| `/api/assistant/disconnect`  | Empty object and bearer token. An already revoked credential can be removed locally after HTTP 401.                                                                                                                                               |
| `/api/assistant/import`      | `version: 1`, `operation_id`, `artifact_hashes`, optional existing `project_id`, one entry in `projects`, and `more_artifacts`.                                                                                                                   |

Import entries contain the owner's metadata fields plus `source` and optional `build` as base64 ZIP strings. Optional `cover` contains `{ mime, data }` for a PNG/JPEG/WebP image. Artifact hashes are SHA-256 of the **base64 strings**, including `cover.data`, matching the owner CLI. They are not hashes of the raw ZIP or image bytes. File hashes shown in the review are separate inspection details.

The body limit is 16 MiB. Larger combined uploads split at artifact boundaries, repeating the same metadata, operation ID, full artifact-hash map, and project ID. Only the final part has `more_artifacts: false`. Retries reuse the exact inspected bytes and operation ID. The consent digest, review, local paths, and exclusion report are never added to the server payload.

Large projects use `/api/assistant/artifact`: `start` reserves the archive size and raw-byte SHA-256, `part` sends a numbered 5 MiB base64 chunk, and `complete` verifies the full checksum. `start` also returns already uploaded part numbers for safe resume. Final import metadata uses `uploaded_artifacts: {source: id, build: id}` instead of inline ZIP strings. For these referenced archives, `artifact_hashes` use the **raw ZIP bytes** SHA-256. Cover hashes retain the original base64-string convention. Artifacts are restricted to the same account and connection. Pending uploads expire after 24 hours; completed version history retains its references.

## Responses and project identity

Account and project IDs are opaque strings. A verified server connection decides whether credentials are usable; the client's clock and optional expiry display fields do not override a connected response. Account equality, project restrictions, and local ownership checks still apply.

An upload completes only after an `imported` or `existing` status, nonempty project/version IDs, and an expected project URL. A linked project's returned ID must match the reviewed target. Optional `preview` and `processing.status` values are copied when usable, and omitted otherwise; absent or unfamiliar display fields do not turn a completed upload into a failure. Unknown response fields are not echoed into CLI output.

The per-user `connection.json` and `.playground/project.json` formats remain compatible with the owner CLI. This package requires private credential permissions. Existing source IDs, creation dates, account ownership, and completed project links are preserved. Keep the project identity file when moving or updating a project.

Pending upload journals are local implementation details: this package uses its consent digest rather than the owner's fingerprint. Finish an interrupted upload with the client that started it before switching implementations. A new operation must not reuse an earlier operation ID for different metadata or archive bytes. A fresh project here derives a stable source ID from its folder path so separate review/consent commands agree; the owner Node CLI instead generates and saves a UUID. Deleting the identity file is not a supported way to request a new remote project.

## Filtering parity and local workflow

File filtering follows the supplied Node bundle: all regular file byte formats and extensions are eligible, with its original path exclusions, ignore behavior, and credential rules. Each file's `Buffer.toString('utf8')` representation is checked against only the original literal private-key and provider-token patterns. There are no additional scanner rules, encoding decoders, archive inspections, or format bans. Explicit covers retain the bundle's separate extension, size, regular-file, project-boundary, and literal credential checks; they do not use source/build exclusions or ignore rules. See [filtering](filtering.md) for the complete policy.

The Node bundle is the filtering reference; the public Python packager has a different browser extension list. Accepting a file locally does not establish that the deployed server will serve or preview its format. Projects allow up to 1 GiB (1,024 MiB) and 500 files across source, browser build, and cover. Large archives use resumable 5 MiB parts; individual JSON requests stay below 16 MiB. Covers remain limited to 3 MiB. HTML documents must be under 8 MiB; keep large data and media in separate assets.

Starting in 0.1.2, omitting `build_dir` detects a single browser output in `dist`, `build`, or `out` instead of selecting source-only publication. Missing or ambiguous output requires correction. Intentional source-only uploads require the local manifest field `source_only: true`; it cannot be combined with `build_dir`. These choices only select local artifacts: `source_only` and `build_dir` are never added to server metadata, and small uploads still use the `source` plus optional `build` request format.

This package retains an explicit approval step and structured review/result events. Metadata is validated before transmission. Conflicting ownership choices, such as enabling remix with an all-rights-reserved license, require correction instead of relying on server normalization.

Completed imports publish immediately. The owner documents private Git history and automatic improvements for supported browser apps; a subsequent local upload replaces those server changes. Source-download and remix permissions are separate. The uploader does not deploy backend processes or databases.

## Verification boundary

Offline filtering tests compare the implementation against fixtures of the original exclusion and credential predicates and verify accepted file bytes. Contract tests exercise pairing bodies, bearer authentication, base64 artifact hashes, multipart requests, response handling, and updates to a saved project. They run in the GitHub quality gate. They never connect a real account or publish a project.

These checks establish consistency with the supplied and public client contracts, not a live server certification. A real pairing and consented test publication are still needed to verify the deployed service end to end.
