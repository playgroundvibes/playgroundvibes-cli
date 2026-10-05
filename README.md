# @playgroundvibes/cli

Publish a reviewed project to [Playground Vibes](https://playgroundvibes.com/). The CLI and API are written in strict TypeScript, compiled to JavaScript for npm, and run on Node.js 22+. Python is not required.

Users can ask their coding agent to publish a project without learning Git, creating a repository, or using GitHub. The agent prepares the project and shows the publication review; the user connects their Playground account when needed, approves the reviewed upload, and receives the project URL. Existing account connections and project identities are reused for updates.

The CLI uses the owner's pairing and upload protocol. It scans selected files locally, shows the complete upload review, and requires explicit consent before any project content is posted. Uploads request automatic publication after server checks pass. The CLI waits for that result; uploading alone does not confirm publication. Selected source is sent to Playground; source download and remix permissions remain separate.

The service keeps private Git history and can automatically improve supported browser projects. A later local deployment replaces those server changes. Backend processes and databases are not deployed by this CLI. See [server compatibility](docs/server-compatibility.md) for the verified request contract and deliberate client-side restrictions.

## Where to read the code

Start with [the filtering guide](docs/filtering.md) to see what is excluded, what blocks publication, and where each rule lives. Policy tables name the exclusions and literal credential patterns; the review identifies the rule and ignore-file location behind each exclusion.

| Source module                                                  | Responsibility                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [src/client.ts](src/client.ts)                                 | Public client; connects preparation, consent, and deployment.                              |
| [src/filtering/](src/filtering/)                               | Original bundle exclusions, literal credential patterns, and file-size limits.             |
| [src/project/](src/project/)                                   | Manifest loading, metadata validation, URL policy, and saved project identity.             |
| [src/artifacts/pack-project.ts](src/artifacts/pack-project.ts) | Deterministic ZIP creation from the bytes already inspected.                               |
| [src/publishing/](src/publishing/)                             | Immutable reviews, consent digests, request splitting, retries, and completion validation. |
| [src/auth/](src/auth/)                                         | Pairing and verified account access; public results omit credentials.                      |
| [src/api/transport.ts](src/api/transport.ts)                   | Bounded requests to the fixed service endpoints.                                           |
| [src/storage/local-state.ts](src/storage/local-state.ts)       | Private credentials, atomic JSON writes, and command locks.                                |
| [src/cli/](src/cli/)                                           | Argument parsing, command dispatch, review output, and interactive consent.                |
| [src/skills/install.ts](src/skills/install.ts)                 | Explicit installation of the bundled skill.                                                |

The flow is `load project → validate metadata → collect and inspect files → archive inspected bytes → review → consent → upload`. Only the final step sends project content. Authentication requests happen when connecting or preparing an account-bound review.

## Install and develop

After npm publication:

```sh
npm install -g @playgroundvibes/cli
playgroundvibes --help
```

From a fresh checkout, use Node.js 22+ and the pinned pnpm version, 12.4.2:

If pnpm is not installed, run `npm install --global pnpm@12.4.2` first.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm start --help
pnpm run check
pnpm pack
```

Or use npm:

```sh
npm ci --ignore-scripts
npm run build
npm start -- --help
npm test
npm pack
```

Both installs work without an existing `dist/` directory. Build and verification scripts invoke local tools through Node; pnpm does not call npm internally. Keep optional dependencies enabled: TypeScript includes its platform-specific compiler in an optional dependency. Dependency install scripts are not needed.

Commit both `package-lock.json` and `pnpm-lock.yaml`. When changing dependencies, update the npm lockfile with `npm install --package-lock-only --ignore-scripts`, then regenerate the pnpm lockfile with `pnpm import`. CI uses frozen installs to catch stale lockfiles. Avoid switching managers in the same `node_modules`; use a fresh checkout when verifying the other manager.

## Build quality checks

`pnpm run check` and `npm run check` run the same quality gate used by GitHub Actions. It checks formatting, compiles the strict TypeScript source, checks public API declarations, runs the offline test suite, and validates the compiled package's files and exports.

```sh
npm run format        # Apply the project's pinned Prettier formatting
npm run format:check  # Check formatting without changing files
npm run check         # Run all quality checks
```

Formatting covers source, tests, scripts, JSON, Markdown, and GitHub workflow YAML. Generated output, dependencies, and both generated lockfiles are excluded. Git attributes keep checked-out text files on LF line endings across operating systems.

`pnpm run build` and `npm run build` refuse unformatted source before compiling. Packing or normally publishing from this checkout with either manager runs the full quality gate through `prepack`. The lower-level `test:unit`, `test:types`, and `check:package` commands use an existing build; prefer `pnpm run check` or `npm run check` for complete validation.

GitHub runs fresh npm and pnpm installs on every branch push and pull request, across Linux, macOS, and Windows with Node 22 and 24. Release tags reuse the same workflow. The publishing job requires all 12 jobs to succeed, then checks and packs the release before publishing that exact tarball with OIDC. These workflows start running once committed and pushed to GitHub.

Only compiled `dist/**/*.js`, generated `.d.ts` declarations, the skill, examples, and documentation ship in the package. TypeScript source, tests, compiler, and Python helpers do not ship as runtime code. Builds clear `dist/` first so moved or deleted modules cannot linger in the package.

## Connect your account

```sh
playgroundvibes login
playgroundvibes connect ABCD2345
playgroundvibes whoami
```

Replace the example with the eight-character pairing code generated on Playground. `login --no-browser` prints the website URL. Credentials are stored outside projects with private permissions. Use `playgroundvibes logout` to revoke this computer's connection.

Before redeeming a code, `connect` runs the same check as `whoami` on any saved connection. If it is still valid, it is kept, the code is not used, and the result includes `"already_connected": true`. Missing, unreadable, revoked (HTTP 401/403), or changed-account credentials are replaced by the new pairing. If the check fails for another reason, such as a network error or server outage, `connect` stops without touching the saved connection or using the code; try again, or run `playgroundvibes logout` first to switch accounts.

The default configuration directory is `~/.config/playground-vibes/cli` on macOS/Linux; `XDG_CONFIG_HOME` is respected. Windows uses `LOCALAPPDATA`, falling back to the home directory. Override with `PLAYGROUND_CONFIG_DIR` or `--config-dir DIR`. The directory must stay outside the project being uploaded.

## Prepare and review a project

From the project root, create `.playground/manifest.json`:

```json
{
  "title": "My app",
  "summary": "What this app does.",
  "source_dir": "..",
  "build_dir": "../dist",
  "license": "All rights reserved",
  "remix": false
}
```

Paths are relative to `.playground/`; `source_dir` must select the current project. Build the app with its documented command first, using its package manager (for example, `pnpm run build` or `npm run build`). The CLI does not execute project build scripts. Browser output needs `index.html` at its root. See [examples/manifest.json](examples/manifest.json) for other basic fields.

Without `build_dir`, the CLI detects a browser build in `dist/`, `build/`, or `out/`. Exactly one of those directories must contain `index.html`; if more than one matches, set `build_dir` to select the intended output. Custom output directories require `build_dir`. A plain static site can use `build_dir: ".."` if the project root is already browser-ready; a development entrypoint that imports TypeScript needs to be built first.

Missing, invalid, or blocked builds stop the upload. They never silently fall back to source-only publication. To intentionally publish source without a browser preview, set `"source_only": true` in the manifest and remove `build_dir`. This is an explicit choice starting in 0.1.2; merely omitting `build_dir` no longer selects source-only mode. Both options are local controls and are not sent as server metadata.

```sh
playgroundvibes deploy --dry-run
playgroundvibes deploy
```

Dry-run is offline and writes no identity or credentials. Deployment first shows the account, destination, final metadata, source/build/cover file list with sizes and hashes, exclusions, and publication consequences. In an interactive terminal, type **PUBLISH** to approve. Refusal or EOF cancels. The upload uses the exact inspected byte snapshot; it never silently adds files changed after review.

For an agent or other noninteractive caller:

1. Run `playgroundvibes deploy --json`. It returns a complete account-bound review and exits with a consent-required error, without uploading.
2. Show that review to the user and obtain approval for its destination, selected files, and publication consequences.
3. Run `playgroundvibes deploy --json --consent REVIEW_DIGEST` with the approved digest.

`--consent` is an acknowledgement of that review, not a secret or proof of who approved it. The caller must obtain real consent. There is no `--yes` or scanner bypass. New preparations with changed content, metadata, account, or project produce a different digest. An offline dry-run digest cannot authorize a deployment because it is not bound to an account.

`--json` emits newline-delimited events: `review`, then `result` or `error`. A review alone is never upload success. The final result contains the actual project URL and preview status. A linked `.playground/project.json` preserves project identity and can be committed; interrupted operations reuse their saved identity and operation ID.

## Secret filtering and its limits

Filtering follows the owner's original Node bundle. Every regular file format and extension is accepted, including binary assets, archives, databases, executables, and source maps, subject to the original path exclusions and size limits. Selected bytes are preserved exactly.

- Source honors nested `.gitignore`; the root `.playgroundignore` applies to source and build. Selected browser output bypasses `.gitignore` when the output directory itself is gitignored (as `dist/` usually is); a tracked build directory, such as `build_dir: ".."`, keeps the source `.gitignore` rules.
- The original mandatory exclusions cover `.env` variants, selected private settings, dependency/cache directories, private-key/log filenames, and common chat/user exports. Unsafe paths, symlinks, and nonregular entries are skipped and reported. See the [complete exclusion table](docs/filtering.md#built-in-exclusions).
- Each selected file is checked using `Buffer.toString('utf8')` and only the original literal patterns for private-key markers and OpenAI/Anthropic, Playground, GitHub, AWS, and Slack credentials. Final metadata receives the same literal checks.
- There is no Secretlint ruleset, generic password/credential-assignment or URL check, encoding decoder, UTF-16 extraction, archive inspection, or format validation. A matching literal credential or exceeded upload limit blocks preparation; files are never redacted or rewritten.

Credential checks match literal patterns in each file’s UTF-8 representation; encoded values and compressed content are not inspected. Review all selected files and metadata before publishing.

Optional `cover_file` selects a project-local PNG, JPEG, or WebP image up to 100 MiB, resolved relative to `.playground/`. As in the original bundle, explicit covers do not apply `.gitignore`, `.playgroundignore`, or the source/build filename exclusions. They require a regular file without symlinked paths and use the same direct UTF-8 credential checks. Covers appear separately in the review. The `tripo` provider setting uses that canonical spelling in `provider_requirements`.

Projects allow up to 1 GiB (1,024 MiB) and 500 files across source, browser build, and cover. Large archives use resumable 5 MiB parts; individual JSON requests stay below 16 MiB. Covers remain limited to 100 MiB. HTML documents must be under 8 MiB; keep large data and media in separate assets. Offline tests compare exclusions and accepted file bytes with fixtures of the original policy; they do not establish that every possible secret is detected or every uploaded format can be previewed.

## JavaScript / TypeScript API

Exports are explicit; there are no wildcard exports of implementation modules.

| Import                           | Exports                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `@playgroundvibes/cli`           | `createPlaygroundClient`, `ConsentError`, `ScanError`, skill helpers, and public client/project/result types.       |
| `@playgroundvibes/cli/filtering` | `scanText`, `ScanError`, and readonly `CREDENTIAL_PATTERNS`, `BUILT_IN_EXCLUSIONS`, and `INSPECTION_LIMITS` tables. |
| `@playgroundvibes/cli/skills`    | `getSkillPath`, `installSkill`, `InstallSkillOptions`, and `InstallSkillResult`.                                    |

`PlaygroundClient`, `Review`, `ProjectMetadata`, `Manifest`, `ConnectionInfo`, `DeploymentConsent`, and `DeploymentResult` are named interfaces. Reviews and their nested fields are readonly in TypeScript and frozen at runtime. Account and deployment results expose validated fields rather than arbitrary server response dictionaries.

```ts
import { createPlaygroundClient } from '@playgroundvibes/cli';

const client = createPlaygroundClient({ cwd: '/absolute/path/to/project' });
const review = await client.prepare();
// Display review and obtain the user's approval in your application's UI.
const userApproved = await showPublicationConsent(review);
if (userApproved) {
  const result = await client.deploy(review, { consent: review.digest });
  console.log(result.url);
}
```

`showPublicationConsent` represents your application's consent UI; the package does not supply it. `inspect()` produces an offline review; `prepare()` verifies account access and returns an immutable review backed by a private in-memory snapshot. Only a review from that client instance, with its matching digest, can be deployed. Importing the API does not connect or publish. Auth methods are `connect(code)`, `whoami()`, and `logout()`; `loginUrl` provides the pairing page. `configDir` can be overridden for embedding and tests.

To inspect the configured rules or check a single piece of text locally:

```ts
import { BUILT_IN_EXCLUSIONS, CREDENTIAL_PATTERNS, scanText } from '@playgroundvibes/cli/filtering';

console.table(BUILT_IN_EXCLUSIONS.map(({ id, reason }) => ({ id, reason })));
console.table(CREDENTIAL_PATTERNS);
await scanText('export const greeting = "hello";', 'src/main.ts');
```

`scanText` resolves when the literal checks pass and throws `ScanError` with path/line/rule findings when they fail. It does not decode its input or grant project approval: full preparation also applies path, ignore, metadata, and artifact limits. Exported policy tables are descriptive and immutable; they cannot disable deployment checks.

## Agent skill

Once this package is published to npm, users can install the skill from their project's directory without a global CLI installation or adding a project dependency:

```sh
npx @playgroundvibes/cli@latest skill install
```

Or with pnpm:

```sh
pnpm dlx @playgroundvibes/cli@latest skill install
```

The package runs from the package manager's cache; the skill is copied into the project. Node.js 22+ is required. Later commands can use the same prefix, such as `npx @playgroundvibes/cli@latest deploy --dry-run --json`.

The default installs the skill for both Claude Code and Codex in this project, without changing permission rules. To install only for Claude Code:

```sh
npx @playgroundvibes/cli@latest skill install --claude
```

When standard input and standard error are terminals, setup asks whether to install the CLI globally and allow Claude to run it for this project. The default is **No**. Answer `y` or `yes` to accept; declining, pressing Enter, or closing input still installs the skill without changing global packages or permissions.

Or use pnpm:

```sh
pnpm dlx @playgroundvibes/cli@latest skill install --claude
```

Noninteractive setup skips the prompt, installs only the skill, and points to the explicit flag. For scripted or already-authorized command setup, bypass the prompt with:

```sh
npx @playgroundvibes/cli@latest skill install --claude --allow-claude-commands
```

When accepted, the installer checks the selected package manager's global installation records. It reuses a matching version or installs the exact CLI version running the setup command from the public npm registry. It verifies the global package, executable, and PATH before adding permissions; an npx cache copy does not count as a global installation. Installation uses npm by default or pnpm when invoked through pnpm. With `--claude`, `--package-manager npm` or `--package-manager pnpm` overrides that choice; it is used only if command permission is accepted.

Once the dependency is ready, setup merges the following rules into `.claude/settings.local.json` in the current project:

```json
{
  "permissions": {
    "allow": [
      "Bash(playgroundvibes whoami:*)",
      "Bash(playgroundvibes --version)",
      "Bash(playgroundvibes --help)",
      "Bash(playgroundvibes skill path:*)"
    ],
    "ask": ["Bash(playgroundvibes deploy:*)"]
  }
}
```

Only read-only commands run without asking. Every `deploy`, including `--dry-run` and `--consent DIGEST`, asks for your approval, so an agent cannot approve its own publication with the command the CLI prints. Existing settings, including other allow, ask, and deny rules, are preserved. Repeating the command does not add duplicates. The broad `Bash(playgroundvibes:*)` rule written by 0.1.5 and earlier is removed. Global installation and permission changes require an affirmative prompt answer or `--allow-claude-commands`. An edited existing skill is preserved; installation reports the conflict instead of overwriting it or granting new permissions. If dependency installation or verification fails, permissions are left unchanged.

After setup, use `playgroundvibes` directly: the rule does not match `npx` or `pnpm dlx` invocations. The initial setup still requires normal host approval or running the command yourself in a terminal. If pnpm reports that its global bin directory is not on PATH, run `pnpm setup`, reopen the terminal, and retry; the installer does not edit shell profiles or use sudo. Claude's deny rules and other host policies remain effective. See [Claude's permission rules](https://code.claude.com/docs/en/permissions).

To install only for Codex, use `.agents/skills/playground-upload`, where Codex discovers project skills:

```sh
npx @playgroundvibes/cli@latest skill install --codex
```

It asks the same question (default **No**); `--allow-codex-commands` skips the prompt for scripted setup. When accepted, it ensures the global CLI exactly as for Claude and then writes `.codex/rules/playgroundvibes.rules`:

```python
prefix_rule(pattern = ["playgroundvibes", "whoami"], decision = "allow")
prefix_rule(pattern = ["playgroundvibes", "--version"], decision = "allow")
prefix_rule(pattern = ["playgroundvibes", "--help"], decision = "allow")
prefix_rule(pattern = ["playgroundvibes", "skill", "path"], decision = "allow")
prefix_rule(pattern = ["playgroundvibes", "deploy"], decision = "prompt")
```

Every deploy prompts for approval. A rules file written by 0.1.5 or earlier (which allowed every `playgroundvibes` command) is replaced; any other existing rules file at that path is preserved and reported as a conflict. Codex loads project `.codex/` rules only for trusted projects. See [Codex rules](https://developers.openai.com/codex/rules). `--claude` and `--codex` cannot be combined in one run; run the installer once for each agent.

To sign the CLI in during setup, pass the pairing code generated on Playground:

```sh
npx @playgroundvibes/cli@latest skill install --claude --pairing-code=ABCD-2345
```

The code is redeemed first, exactly like `playgroundvibes connect CODE` (including keeping a still-valid saved connection instead of redeeming the code), and the connection is saved in the private configuration directory shared with the global `playgroundvibes` command. If the code is invalid or expired, setup stops before installing anything. `--pairing-code` works with `--claude`, `--codex`, or plain `skill install`, and the JSON result includes the `connection`.

Unrecognized `--options` are ignored with a warning on stderr instead of failing, so newer flags passed to an older CLI do not break setup. Unknown commands, missing values, invalid values, and duplicate flags are still errors.

Command access does not approve a project's publication. The CLI still scans and reviews files and requires publication consent before uploading.

For an existing global installation:

```sh
playgroundvibes skill install
playgroundvibes skill install --path .claude/skills/playground-upload
playgroundvibes skill path
```

Default destinations: `.agents/skills/playground-upload/SKILL.md` and `.claude/skills/playground-upload/SKILL.md` in the current project. `--claude`, `--codex`, or `--path` selects a single destination. The default does not modify permission rules or install a global command. Results include `paths` for both destinations, with `path` retaining the Codex destination for compatibility. Installation is explicit and preserves existing edits. `getSkillPath()` and `installSkill({ cwd, directory })` are also exported. Installing the npm package or skill never authorizes publication.

## npm releases

The GitHub repository is `playgroundvibes/playgroundvibes-cli`; the npm package remains `@playgroundvibes/cli`. The intended npm account is **playgroundvibesapp**, which must have publishing access to the `@playgroundvibes` scope. Account name and package scope are separate.

The publishing workflow runs on pushed `v*` tags, verifies the tag matches `package.json`, waits for cross-platform tests, compiles JavaScript, and publishes the tarball using npm trusted publishing. Stable versions use `latest`; prereleases use `next`. No long-lived npm token is stored in GitHub.

One-time setup (not yet completed): sign in to npm as `playgroundvibesapp`, verify scope access and choose the license (currently `UNLICENSED`), publish the initial package, then configure this trusted publisher:

```sh
npm login --auth-type=web --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
# Verify the printed account is playgroundvibesapp before publishing.
npm publish --access public --registry=https://registry.npmjs.org/
npm trust github @playgroundvibes/cli \
  --file publish.yml \
  --repository playgroundvibes/playgroundvibes-cli \
  --allow-publish \
  --registry=https://registry.npmjs.org/
```

The trust command needs npm 11.15+, account 2FA, and write access to an existing package. Use browser login; bypass-2FA granular tokens and legacy basic authentication cannot configure trust. `--allow-publish` enables direct publishing instead of only staged releases. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and [npm trust](https://docs.npmjs.com/cli/v12/commands/npm-trust/).

If trust setup returns `403`, first check `npm whoami --registry=https://registry.npmjs.org/` prints `playgroundvibesapp`. The package must be published and this account must have write access before retrying trust setup. A `404` from `npm view @playgroundvibes/cli --registry=https://registry.npmjs.org/` can mean the package is unpublished or the signed-in account cannot access it; it does not prove the package is available. The timer warning is separate from the registry rejection.

Once setup and repository changes are live, release a new version with `npm version patch` (or an explicit prerelease version), then push the commit and its version tag. Each tag must match the package version exactly. Do not tag the already bootstrapped version for publication again.

Tests are offline: scanners use synthetic secrets, and deployment requests are mocked. Live pairing and publication still require service validation. See [NOTICE.md](NOTICE.md) for source/dependency attribution.

### Processing status

`playgroundvibes deploy` waits up to ten minutes for server processing. `--no-wait` returns after the upload; use `playgroundvibes status --wait --json` to resume checking. Add `--version-id ID` to follow one exact upload. Status checks use the existing account and project connection and never send the source again.

Only `published: true` confirms publication. `preview: "ready"` means a validated app; `preview: "overview"` is a generated introduction for an app requiring backend hosting, not a running copy. Failed processing includes an error and keeps the candidate private. Publishing a listing/preview does not require turning on source downloads or remixing, and it does not require a second browser Publish action.

## Credit the model that built a project

Optional manifest metadata records the primary coding model and coding app/harness:

```json
"creation_details": {
  "tools": ["Codex"],
  "model": "Astra 6, high reasoning (estimated)",
  "harness": "Codex app"
}
```

Model and harness are free text (up to 100 characters each). Use the best project-specific estimate available; include version or reasoning details when known. Any field may be omitted or left blank. Preserve existing credits on updates unless they need correcting. Runtime API models do not identify the model that wrote the project. The bundled skill asks agents to fill these credits during preparation; Playground can fill obvious gaps from uploaded build notes. Credits appear publicly and remain editable on the project page.
