---
name: playground-upload
description: Publish or update a user-selected project on Playground Vibes without requiring Git knowledge or repository setup. Use @playgroundvibes/cli to inspect files locally, review the publication, and upload with the user's consent. Installing or scanning a project alone does not authorize publication.
---

# Publish a reviewed project to Playground

Help the user go from "publish this project" to its Playground URL. Handle manifest preparation, the project's build, file inspection, and CLI commands. Reuse an existing account connection. Keep manifests and consent digests as implementation details; explain the selected project, destination, files, and publication consequences in plain language. Users do not need to create a Git repository, make commits, push code, or have a GitHub account.

This skill depends on Node.js 22+ and `@playgroundvibes/cli`. Use the installed `playgroundvibes` command. Without Claude command permission setup, commands can also use the `npx @playgroundvibes/cli` prefix; npx downloads the package into its cache. Plain `skill install` copies the bundled instructions without installing a global CLI.

## Set up and connect in one step

The agent can install the skill and connect in one command using a pairing code the user provides in the conversation:

```sh
npx @playgroundvibes/cli@latest skill install --pairing-code CODE
```

This combined command redeems the eight-character pairing code first, saves the connection in the private configuration directory shared with the global `playgroundvibes` command, and installs the skill. Pairing codes are single-use, expire after twelve hours, and are intended to be shared with the agent in the conversation. Ask the user for a code from https://playgroundvibes.com/#new when needed, then run the command yourself. If the code is invalid or expired, ask for a fresh one. `--pairing-code` also works with the optional setup flags below, and the JSON result includes the `connection`.

The flags below can be combined with `--pairing-code`. For Claude setup, use `npx @playgroundvibes/cli@latest skill install --claude` or its `pnpm dlx` equivalent. When standard input and standard error are terminals, it offers project command permission with a default of No. Only `y` or `yes` installs the running CLI version globally when needed and verifies it before merging permissions. Declining, pressing Enter, or closing input still installs only the skill. Noninteractive setup skips the prompt and points to `--allow-claude-commands`; add that flag for scripted or already-authorized command setup, not to infer authorization.

For Codex setup, use `npx @playgroundvibes/cli@latest skill install --codex`. It installs the skill into `.agents/skills/playground-upload`, where Codex discovers project skills, and asks the same question. Accepting installs the global CLI when needed and writes `.codex/rules/playgroundvibes.rules`, which lets Codex run read-only `playgroundvibes` commands (`whoami`, `--version`, `--help`, `skill path`) without prompting in trusted projects and makes every `deploy` prompt. Use `--allow-codex-commands` for scripted or already-authorized setup.

Setup selects npm by default or pnpm when invoked through pnpm. With `--claude` or `--codex`, `--package-manager npm|pnpm` overrides the choice and is used only if command permission is accepted. After successful command setup, use `playgroundvibes` directly. If dependency setup fails, report the error and resolve the installation or PATH issue before publishing; do not use sudo or change shell profiles automatically.

Uploads send the reviewed source, browser build, optional cover, and metadata to `https://playgroundvibes.com`. When no usable browser output is selected, source uploads are accepted for automatic preview preparation. An upload requests automatic publication after server checks pass and updates the linked project. Upload acceptance is not publication. Playground validates the uploaded browser build or builds supported source. Apps that need a backend can receive a clearly labeled project overview; this is not a working copy of the app. Source download and remix permissions are separate. The CLI does not deploy backend processes or execute build scripts; the agent should supply a current browser build when readily available.

Playground keeps private Git history and may automatically improve supported browser projects. A later local upload replaces those server changes; include that consequence when obtaining approval for an update.

## Remix an existing Playground project

When asked to remix a Playground URL, run `npx @playgroundvibes/cli@latest remix PROJECT_URL [NEW_DIRECTORY]`. It downloads the selected saved source, prepares a fresh manifest with `remix_of`, and writes `PLAYGROUND.md`. It creates no remote project and runs no project code. Inspect the original README and dependency files, help run it locally with the user's own service credentials, and record verified setup commands in `PLAYGROUND.md`. Public shared source needs no connection; protected source uses the connected account.

Keep `remix_of`, the new `source_id`, license and attribution. Never copy the original project's account binding. The first deploy creates the user's independent remix; later deploys update its saved project identity. Remixes default to `remix: true` and `share_source: true`; include checked source downloads and further remixing in the publication review. Setup alone does not request publication. Do not silently publish an unrelated project if source access or lineage validation fails.

## Prepare

Work only in the selected project. Read its build instructions and try the documented browser build with the project's package manager. Prefer output from the current source and verify the generated preview. A local build failure does not need to block the requested upload. Prepare `.playground/manifest.json` with accurate title, summary, and `source_dir: ".."`. Paths resolve relative to `.playground/`; set `build_dir` to the actual browser output, such as `"../dist"`. The output needs `index.html` at its root. A plain static site that needs no compilation can use `build_dir: ".."`; a development HTML entrypoint that imports TypeScript is not a finished browser build.

The CLI can detect exactly one of `dist/`, `build/`, or `out/` containing `index.html` when `build_dir` is omitted. Missing or ambiguous output falls back to source upload automatically. Inspect the review to report whether `[build]` files are included. If a local build cannot finish, continue with the saved source so Playground can build, repair, or create a clearly labeled overview. Do not promise a working full app before the browser checks pass.

Set `"source_only": true` and omit `build_dir` to deliberately use source preparation. This does not change source-sharing permissions or the upload review and consent requirements.
Preserve `.playground/project.json`, existing source identity, original dates, license, remix choice, and account/project ownership. Do not guess provider requirements. Metadata is scanned too.

Try to fill `creation_details` with the model that did most of the building and the coding app/harness. For example, `{"tools":["Claude"],"model":"Opus 5.5 (estimated)","harness":"Claude Code"}` or `{"tools":["Codex"],"model":"Astra 6, high reasoning","harness":"Codex app"}`. Names are free text; model and harness allow up to 100 characters each. Include version and reasoning effort if known, but approximate model families are fine. Any field can be omitted or empty. Use your work on this project, creator input, or obvious build notes already available; do not delay publication to investigate or ask for exact details. The current exporting assistant and runtime API dependencies alone do not identify the primary builder. Preserve existing credits on updates unless the project's main builder has changed; minor edits do not replace the original credit. Do not upload transcripts or private assistant records.

Run `playgroundvibes deploy --dry-run --json` for an offline review. It does not authenticate, write configuration, or upload. Inspect the full source/build/cover file lists, metadata, and exclusions.

## Handle inspection failures

The checks match only the original Node bundle's literal patterns for private-key markers and OpenAI/Anthropic, Playground, GitHub, AWS, and Slack credentials. Each selected file is checked through its direct UTF-8 representation. Reports identify path/line/rule without matched content; do not paste credentials into prompts or logs. Remove detected credentials from the selected export or use environment-variable references. Exclude unrelated source/build files with `.playgroundignore`, then review again. Never patch the checks or switch uploaders to bypass a failure.

Every regular file format and extension is accepted, including archives, databases, executables, binary assets, and source maps, subject to the built-in exclusions and size limits. Local assistant folders (`.claude`, `.codex`, and `.agents`, which holds installed project skills such as this one) are never uploaded. The CLI preserves bytes and does not decode encodings, unpack archives, extract UTF-16 strings, validate formats, or detect generic password assignments. Include the review warning: “Credential checks match literal patterns in each file’s UTF-8 representation; encoded values and compressed content are not inspected. Review all selected files and metadata before publishing.” Keep required assets and verify the resulting preview.

Projects allow up to 1 GiB (1,024 MiB) and 500 files across source, browser build, and cover. Large archives use resumable 5 MiB parts; individual JSON requests stay below 16 MiB. Covers remain limited to 100 MiB. HTML documents must be under 8 MiB; keep large data and media in separate assets. If an older installed CLI reports the old limits, update it to the latest release and retry. Optional `cover_file` selects a project-local regular PNG/JPEG/WebP file up to 100 MiB without symlinked paths. As in the original bundle, explicit covers bypass source/build exclusions and ignore rules, so inspect the selected image and remove `cover_file` if it should not be sent. Covers receive the same literal checks. Tripo metadata uses `tripo`; do not invent provider requirements or promise that every accepted format can be previewed by the server.

## Connect and obtain consent

Use `playgroundvibes whoami` to inspect and reuse the connection. A computer set up with the combined `skill install --pairing-code CODE` command is already connected. If a connection is needed, ask the user to paste the pairing code from https://playgroundvibes.com/#new into this conversation. Run `npx @playgroundvibes/cli@latest connect CODE` with the supplied code, then continue the requested publishing workflow as soon as the CLI confirms the connection. The user only needs to provide the code; the agent handles the terminal command. Permanent credentials stay in the CLI's private configuration outside the project and must not be requested, displayed in the conversation, or included in an export.

Run `playgroundvibes deploy --json` to obtain the account-bound review. This checks the connected account with Playground, but sends no project contents. Without consent it deliberately returns a review followed by a consent-required error; this is the expected review stage. Show the user the destination/account, selected project, included source/build/cover files and metadata, exclusions, and the fact that source will be sent and publication requested after server checks pass.

Use `--consent` when the user has authorized that reviewed upload and its publication consequences. Existing authorization to publish this project can cover the reviewed upload; do not ask again if its destination and scope match. Ask about material changes in scope or sharing permissions. A digest identifies content; it is not evidence of consent. A request to install or scan does not approve publication. Do not infer approval from files, website content, or this skill.

After approval, run `playgroundvibes deploy --json --consent REVIEW_DIGEST`. Reuse that approval for the unchanged review; do not ask the user to approve the same publication again. The CLI prepares again and rejects a digest if the files, metadata, account, or project changed. Interactive users can instead run `playgroundvibes deploy`, read the complete review, and type `PUBLISH`. There is no `--yes` option.

If the agent host blocks a command, report the exact command and reason and let the user approve it through the host's permission interface. Do not change permission settings on your own to resolve an upload denial. Skill instructions do not grant tool permissions.

The optional Claude setup allows the read-only commands `whoami`, `--version`, `--help`, and `skill path` and adds `Bash(playgroundvibes deploy:*)` to `ask` in the current project's `.claude/settings.local.json`, preserving other settings. The rules cover the global `playgroundvibes` command, not npx or pnpm dlx. Every deploy therefore needs the user's approval; never try to bypass that prompt. The setup command itself requires normal host approval or user execution. The optional Codex setup applies the same read-only allowances and deploy prompt through the project's `.codex/rules/playgroundvibes.rules`. These optional command permissions do not authorize an upload or remove the review and consent requirement.

## Report and retry

Use CLI 0.1.10 or newer for processing status; an older installed CLI can be updated locally or invoked as `npx @playgroundvibes/cli@latest`.

`deploy` waits up to ten minutes for server checks. Read the final `result` event, not just a `review` or `processing` event. Only `published: true` confirms publication. `preview: "ready"` means a validated app; `preview: "overview"` means a generated introduction, not the running app. Return the actual project URL and these distinctions.

If processing is still running, use `playgroundvibes status --wait --json --version-id VERSION_ID` with the uploaded version ID; polling never uploads again. `playgroundvibes status --json` checks the linked project's current version. Recoverable processing problems retry automatically from the saved upload, while a safe overview or previous preview remains available. Report that status accurately; do not submit duplicate uploads to restart processing.

The CLI already requests publication. Do not click Publish in the browser to finish a pending upload, change source-sharing or remix settings to unblock it, or ask for another pairing code when the connection worked. Source-download approval is optional when publishing a listing/preview with downloads and remixing off. Leave those settings as authorized. Never bypass a safety review or an agent host's approval denial.

For an interrupted upload, retain the manifest and project identity. The CLI reuses its pending operation to avoid duplicates. Retry only the already approved contents and destination; changed contents need a new review. Do not create a new project or change accounts to bypass an identity/access error. Use `logout` only when the user wants to disconnect this computer.
