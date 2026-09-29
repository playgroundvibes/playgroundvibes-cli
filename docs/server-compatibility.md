# Server compatibility

This package implements the existing Playground Vibes protocol. Its filtering, review, and consent steps run locally; they do not require a new server endpoint or a change to the import payload.

The compatibility review on September 29, 2026 compared the owner's supplied Node CLI (`bin/playgroundvibes.mjs` and `src/` in the provided `cli` folder), the public [upload helper](https://playgroundvibes.com/playground-upload.py), and its [packager](https://playgroundvibes.com/pack-playground.py). The Node CLI is the reference for pairing. The Python helper has a different connection flow; this package does not combine those authentication flows.

## Requests

All requests are JSON POSTs to `https://playgroundvibes.com`. Authentication uses `Authorization: Bearer TOKEN`, and redirects are rejected.

| Endpoint                     | Request contract                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/assistant/pair-redeem` | Normalized eight-character `code`, SHA-256 `token_hash`, and computer `label`. The generated permanent token is saved privately and is not sent in the pairing body.      |
| `/api/assistant/status`      | Empty object and bearer token. The server must return `status: "connected"` for the saved account. A returned project restriction must agree with the local project link. |
| `/api/assistant/disconnect`  | Empty object and bearer token. An already revoked credential can be removed locally after HTTP 401.                                                                       |
| `/api/assistant/import`      | `version: 1`, `operation_id`, `artifact_hashes`, optional existing `project_id`, one entry in `projects`, and `more_artifacts`.                                           |

Import entries contain the owner's metadata fields plus `source` and optional `build` as base64 ZIP strings. Artifact hashes are SHA-256 of those **base64 strings**, matching the owner CLI. They are not hashes of the raw ZIP bytes. File hashes shown in the review are separate inspection details.

The body limit is 16 MiB. Larger combined uploads split at artifact boundaries, repeating the same metadata, operation ID, full artifact-hash map, and project ID. Only the final part has `more_artifacts: false`. Retries reuse the exact inspected bytes and operation ID. The consent digest, review, local paths, and exclusion report are never added to the server payload.

## Responses and project identity

Account and project IDs are opaque strings. A verified server connection decides whether credentials are usable; the client's clock and optional expiry display fields do not override a connected response. Account equality, project restrictions, and local ownership checks still apply.

An upload completes only after an `imported` or `existing` status, nonempty project/version IDs, and an expected project URL. A linked project's returned ID must match the reviewed target. Optional `preview` and `processing.status` values are copied when usable, and omitted otherwise; absent or unfamiliar display fields do not turn a completed upload into a failure. Unknown response fields are not echoed into CLI output.

The per-user `connection.json` and `.playground/project.json` formats remain compatible with the owner CLI. This package requires private credential permissions. Existing source IDs, creation dates, account ownership, and completed project links are preserved. Keep the project identity file when moving or updating a project.

Pending upload journals are local implementation details: this package uses its consent digest rather than the owner's fingerprint. Finish an interrupted upload with the client that started it before switching implementations. A new operation must not reuse an earlier operation ID for different metadata or archive bytes. A fresh project here derives a stable source ID from its folder path so separate review/consent commands agree; the owner Node CLI instead generates and saves a UUID. Deleting the identity file is not a supported way to request a new remote project.

## Deliberate local restrictions

This is not an identical command-line replacement for every owner-CLI option. It adds an explicit approval step and structured review/result events. It also blocks unsupported binary files and covers, inspects encoded text, and caps a source file at 4 MiB. The owner CLI accepts more file types and larger individual source files. See [filtering](filtering.md) for the complete policy.

Metadata is validated before transmission. Conflicting ownership choices, such as enabling remix with an all-rights-reserved license, require correction instead of relying on server normalization. The Node and Python references differ in some accepted browser extensions and filename rules; local text inspection is not a guarantee that the server can preview every accepted file.

Completed imports publish immediately. The owner documents private Git history and automatic improvements for supported browser apps; a subsequent local upload replaces those server changes. Source-download and remix permissions are separate. The uploader does not deploy backend processes or databases.

## Verification boundary

Offline contract tests exercise pairing bodies, bearer authentication, base64 artifact hashes, multipart requests, response handling, and updates to a saved project. They run in the GitHub quality gate. They never connect a real account or publish a project.

These checks establish consistency with the supplied and public client contracts, not a live server certification. A real pairing and consented test publication are still needed to verify the deployed service end to end.
