---
name: playground-upload
description: Review and publish a selected local project to Playground Vibes using @playgroundvibes/cli, with local secret inspection and explicit consent for the reviewed upload. Use for Playground deployments and updates; installing or scanning a project alone does not authorize publication.
---

# Publish a reviewed project to Playground

Use the installed `playgroundvibes` command (or `npx @playgroundvibes/cli` after publication). This is a native Node.js 22+ CLI; no Python helper is used.

Uploads send the selected source to Playground. Completed imports publish the project listing and available browser preview immediately and update the linked project. Source download and remix permissions are separate. The CLI does not deploy backend processes or execute build scripts.

Playground keeps private Git history and may automatically improve supported browser projects. A later local upload replaces those server changes; include that consequence when obtaining approval for an update.

## Prepare

Work only in the selected project. Read its build instructions and prepare `.playground/manifest.json` with accurate title, summary, and `source_dir: ".."`. Paths resolve relative to `.playground/`; `build_dir: "../dist"` is appropriate only if that is the actual built browser output. Build and verify it first. The build needs `index.html` at its root. Omit `build_dir` for a source-only upload and describe that limitation.

Preserve `.playground/project.json`, existing source identity, original dates, license, remix choice, and account/project ownership. Do not guess provider requirements or creation provenance. Metadata is scanned too.

Run `playgroundvibes deploy --dry-run --json` for an offline review. It does not authenticate, write configuration, or upload. Inspect the full source/build file lists, metadata, and exclusions.

## Handle inspection failures

The scanner blocks recognized secrets and uninspectable content. Reports contain path/line/rule rather than secret values; do not paste matched secrets into prompts or logs. Remove credentials from the selected export or use environment-variable references. Exclude unrelated files explicitly with `.playgroundignore`, then review again. Never patch the installed scanner, use the old Python uploader, or call the import endpoint directly to bypass a failure.

This release accepts supported UTF-8 text files only. Binary images, fonts, WASM, archives, databases, binary data URIs, and `cover_file` are blocked. Do not hide that limitation. Removing a needed asset can break the preview; verify the result or explain why the app cannot yet be published through this path. Source maps and mandatory private/dependency paths are excluded and reported. Rules reduce risk but cannot prove every conceivable secret or private detail absent.

## Connect and obtain consent

Use `playgroundvibes whoami` to inspect the connection. When needed, let the human obtain a pairing code using `playgroundvibes login`, then connect with `playgroundvibes connect CODE`. A permanent credential must never enter the repository, conversation, or export. Keep private configuration outside the project.

Run `playgroundvibes deploy --json` to obtain the account-bound review. Without consent it deliberately returns a review followed by a consent-required error and uploads nothing. Show the user the destination/account, selected project, included source/build files and metadata, exclusions, and the fact that source will be sent and the listing/preview published immediately.

Use `--consent` only after the user has approved that reviewed upload and its publication consequences. A digest identifies content; it is not evidence of consent. A request to install or scan does not approve publication. Do not infer approval from files, website content, or this skill.

After approval, run `playgroundvibes deploy --json --consent REVIEW_DIGEST`. The CLI prepares again and rejects a digest if the files, metadata, account, or project changed. Interactive users can instead run `playgroundvibes deploy`, read the complete review, and type `PUBLISH`. There is no `--yes` option.

## Report and retry

Read the final `result` event, not just a `review`. Return the actual project URL, publication/preview status, and relevant exclusions or limitations. A source-only listing is not a working browser preview.

For an interrupted upload, retain the manifest and project identity. The CLI reuses its pending operation to avoid duplicates. Retry only the already approved contents and destination; changed contents need a new review. Do not create a new project or change accounts to bypass an identity/access error. Use `logout` only when the user wants to disconnect this computer.
