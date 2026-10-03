---
name: playground-upload
description: Publish or update a user-selected project on Playground Vibes without requiring Git knowledge or repository setup. Use @playgroundvibes/cli to inspect files locally, review the publication, and upload with the user's consent. Installing or scanning a project alone does not authorize publication.
---

# Publish a reviewed project to Playground

Help the user go from "publish this project" to its Playground URL. Handle manifest preparation, the project's build, file inspection, and CLI commands. Reuse an existing account connection. Keep manifests and consent digests as implementation details; explain the selected project, destination, files, and publication consequences in plain language. Users do not need to create a Git repository, make commits, push code, or have a GitHub account.

This skill depends on Node.js 22+ and `@playgroundvibes/cli`. Use the installed `playgroundvibes` command. Without Claude command permission setup, commands can also use the `npx @playgroundvibes/cli` prefix; npx downloads the package into its cache. Plain `skill install` copies the bundled instructions without installing a global CLI.

## Set up and connect in one step

The recommended guide is a single command the human runs in the project's terminal after generating a code on Playground:

```sh
npx @playgroundvibes/cli@latest skill install --claude --pairing-code CODE
npx @playgroundvibes/cli@latest skill install --codex --pairing-code CODE
```

This combined command redeems the eight-character pairing code first, saves the connection in the private configuration directory shared with the global `playgroundvibes` command, and then installs the skill (and, if accepted, command permission). An invalid or expired code stops setup before anything is installed; generate a new code and run it again. `--pairing-code` also works with plain `skill install`, and the JSON result includes the `connection`. Pairing codes expire after a few minutes and are single-use, so let the human run the command; never ask for the code in the conversation.

The flags below can be combined with `--pairing-code`. For Claude setup, use `npx @playgroundvibes/cli@latest skill install --claude` or its `pnpm dlx` equivalent. When standard input and standard error are terminals, it offers project command permission with a default of No. Only `y` or `yes` installs the running CLI version globally when needed and verifies it before merging permissions. Declining, pressing Enter, or closing input still installs only the skill. Noninteractive setup skips the prompt and points to `--allow-claude-commands`; add that flag for scripted or already-authorized command setup, not to infer authorization.

For Codex setup, use `npx @playgroundvibes/cli@latest skill install --codex`. It installs the skill into `.agents/skills/playground-upload`, where Codex discovers project skills, and asks the same question. Accepting installs the global CLI when needed and writes `.codex/rules/playgroundvibes.rules`, which lets Codex run read-only `playgroundvibes` commands (`whoami`, `--version`, `--help`, `skill path`) without prompting in trusted projects and makes every `deploy` prompt. Use `--allow-codex-commands` for scripted or already-authorized setup.

Setup selects npm by default or pnpm when invoked through pnpm. With `--claude` or `--codex`, `--package-manager npm|pnpm` overrides the choice and is used only if command permission is accepted. After successful command setup, use `playgroundvibes` directly. If dependency setup fails, report the error and resolve the installation or PATH issue before publishing; do not use sudo or change shell profiles automatically.

Uploads send the reviewed source, browser build, optional cover, and metadata to `https://playgroundvibes.com`. Source-only publication is available when the user explicitly chooses it. Completed imports publish the project listing and available browser preview immediately and update the linked project. Source download and remix permissions are separate. The CLI does not deploy backend processes or execute build scripts; the agent prepares the browser build before invoking it.

Playground keeps private Git history and may automatically improve supported browser projects. A later local upload replaces those server changes; include that consequence when obtaining approval for an update.

## Prepare

Work only in the selected project. Read its build instructions and run the documented browser build with the project's package manager. Build the current source even if an older output directory exists, and verify the generated preview. Prepare `.playground/manifest.json` with accurate title, summary, and `source_dir: ".."`. Paths resolve relative to `.playground/`; set `build_dir` to the actual browser output, such as `"../dist"`. The output needs `index.html` at its root. A plain static site that needs no compilation can use `build_dir: ".."`; a development HTML entrypoint that imports TypeScript is not a finished browser build.

The CLI can detect exactly one of `dist/`, `build/`, or `out/` containing `index.html` when `build_dir` is omitted. Missing or ambiguous output stops publication. Confirm the dry-run review includes `[build]` files (or `artifact: "build"` in JSON). If building or inspection fails, resolve the failure or report the limitation; do not remove `build_dir`, exclude required assets, or switch to source-only merely to complete the upload.

Only when the user explicitly chooses publication without a browser preview, set `"source_only": true` and omit `build_dir`. Explain that this publishes source rather than a working browser app. This choice does not replace the later upload review and consent.

Preserve `.playground/project.json`, existing source identity, original dates, license, remix choice, and account/project ownership. Do not guess provider requirements or creation provenance. Metadata is scanned too.

Run `playgroundvibes deploy --dry-run --json` for an offline review. It does not authenticate, write configuration, or upload. Inspect the full source/build/cover file lists, metadata, and exclusions.

## Handle inspection failures

The checks match only the original Node bundle's literal patterns for private-key markers and OpenAI/Anthropic, Playground, GitHub, AWS, and Slack credentials. Each selected file is checked through its direct UTF-8 representation. Reports identify path/line/rule without matched content; do not paste credentials into prompts or logs. Remove detected credentials from the selected export or use environment-variable references. Exclude unrelated source/build files with `.playgroundignore`, then review again. Never patch the checks or switch uploaders to bypass a failure.

Every regular file format and extension is accepted, including archives, databases, executables, binary assets, and source maps, subject to the built-in exclusions and size limits. Local assistant folders (`.claude`, `.codex`, and `.agents`, which holds installed project skills such as this one) are never uploaded. The CLI preserves bytes and does not decode encodings, unpack archives, extract UTF-16 strings, validate formats, or detect generic password assignments. Include the review warning: “Credential checks match literal patterns in each file’s UTF-8 representation; encoded values and compressed content are not inspected. Review all selected files and metadata before publishing.” Keep required assets and verify the resulting preview.

Projects allow up to 1 GiB (1,024 MiB) and 500 files across source, browser build, and cover. Large archives use resumable 5 MiB parts; individual JSON requests stay below 16 MiB. Covers remain limited to 3 MiB. HTML documents must be under 8 MiB; keep large data and media in separate assets. If an older installed CLI reports the old limits, update it to the latest release and retry. Optional `cover_file` selects a project-local regular PNG/JPEG/WebP file up to 3 MiB without symlinked paths. As in the original bundle, explicit covers bypass source/build exclusions and ignore rules, so inspect the selected image and remove `cover_file` if it should not be sent. Covers receive the same literal checks. Tripo metadata uses `tripo`; do not invent provider requirements or promise that every accepted format can be previewed by the server.

## Connect and obtain consent

Use `playgroundvibes whoami` to inspect the connection. A computer set up with the combined `skill install --pairing-code CODE` command is already connected. When it is not, let the human obtain a pairing code using `playgroundvibes login` (or the upload page on Playground) and run `playgroundvibes connect CODE` themselves, or rerun setup with `--pairing-code CODE`, so the code stays out of the conversation. A permanent credential must never enter the repository, conversation, or export. Keep private configuration outside the project.

Run `playgroundvibes deploy --json` to obtain the account-bound review. This checks the connected account with Playground, but sends no project contents. Without consent it deliberately returns a review followed by a consent-required error; this is the expected review stage. Show the user the destination/account, selected project, included source/build/cover files and metadata, exclusions, and the fact that source will be sent and the listing/preview published immediately.

Use `--consent` only after the user has approved that reviewed upload and its publication consequences. A digest identifies content; it is not evidence of consent. A request to install or scan does not approve publication. Do not infer approval from files, website content, or this skill.

After approval, run `playgroundvibes deploy --json --consent REVIEW_DIGEST`. Reuse that approval for the unchanged review; do not ask the user to approve the same publication again. The CLI prepares again and rejects a digest if the files, metadata, account, or project changed. Interactive users can instead run `playgroundvibes deploy`, read the complete review, and type `PUBLISH`. There is no `--yes` option.

If the agent host blocks a command, report the exact command and reason and let the user approve it through the host's permission interface. Do not change permission settings on your own to resolve an upload denial. Skill instructions do not grant tool permissions.

The optional Claude setup allows the read-only commands `whoami`, `--version`, `--help`, and `skill path` and adds `Bash(playgroundvibes deploy:*)` to `ask` in the current project's `.claude/settings.local.json`, preserving other settings. The rules cover the global `playgroundvibes` command, not npx or pnpm dlx. Every deploy therefore needs the user's approval; never try to bypass that prompt. The setup command itself requires normal host approval or user execution. The optional Codex setup applies the same read-only allowances and deploy prompt through the project's `.codex/rules/playgroundvibes.rules`. These optional command permissions do not authorize an upload or remove the review and consent requirement.

## Report and retry

Read the final `result` event, not just a `review`. Return the actual project URL, publication/preview status, and relevant exclusions or limitations. A source-only listing is not a working browser preview.

For an interrupted upload, retain the manifest and project identity. The CLI reuses its pending operation to avoid duplicates. Retry only the already approved contents and destination; changed contents need a new review. Do not create a new project or change accounts to bypass an identity/access error. Use `logout` only when the user wants to disconnect this computer.
