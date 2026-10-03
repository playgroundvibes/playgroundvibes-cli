import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createPlaygroundClient } from '../client.js';
import { getSkillPath, installSkill } from '../skills/install.js';
import type { CLIArguments } from './arguments.js';
import { requirePublicationConsent } from './consent.js';
import { printHelp, printJson, printReview } from './output.js';
import { confirmAgentCommands } from './skill-permissions.js';
import { waitForDeployment } from './deployment-status.js';

async function openBrowser(url: string): Promise<void> {
  let executable: string;
  let args: string[];
  switch (process.platform) {
    case 'darwin':
      executable = 'open';
      args = [url];
      break;
    case 'win32':
      executable = 'rundll32.exe';
      args = ['url.dll,FileProtocolHandler', url];
      break;
    default:
      executable = 'xdg-open';
      args = [url];
  }
  await new Promise<void>((resolve, reject) => {
    const browser = spawn(executable, args, { detached: true, stdio: 'ignore', shell: false });
    browser.once('error', reject);
    browser.once('spawn', () => {
      browser.unref();
      resolve();
    });
  });
}

/** Dispatch a fully parsed command; publication always follows review and consent. */
export async function executeCommand({ configDir, command }: CLIArguments): Promise<void> {
  switch (command.name) {
    case 'help':
      printHelp();
      return;
    case 'version': {
      const manifest = JSON.parse(
        await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
      ) as { version: string };
      process.stdout.write(`${manifest.version}\n`);
      return;
    }
    case 'skill-path':
      process.stdout.write(`${getSkillPath()}\n`);
      return;
    case 'skill-install': {
      // Redeem first: codes expire quickly, and a failed pairing should not leave a half setup.
      const connection =
        command.pairingCode === undefined
          ? undefined
          : await createPlaygroundClient({ configDir }).connect(command.pairingCode);
      const allowClaudeCommands =
        command.allowClaudeCommands || (command.claude && (await confirmAgentCommands('claude')));
      const allowCodexCommands =
        command.allowCodexCommands || (command.codex && (await confirmAgentCommands('codex')));
      const installed = await installSkill({
        directory: command.directory,
        claude: command.claude,
        allowClaudeCommands,
        codex: command.codex,
        allowCodexCommands,
        packageManager:
          allowClaudeCommands || allowCodexCommands ? command.packageManager : undefined,
      });
      printJson(connection ? { ...installed, connection } : installed);
      return;
    }
  }

  const client = createPlaygroundClient({ configDir });
  switch (command.name) {
    case 'login':
      process.stdout.write(
        `Open ${client.loginUrl} to connect your Playground Vibes account.\nThen run: playgroundvibes connect CODE\n`,
      );
      if (!command.noBrowser) {
        try {
          await openBrowser(client.loginUrl);
        } catch {
          process.stderr.write('Could not open a browser automatically. Open the URL above.\n');
        }
      }
      return;
    case 'connect':
      printJson(await client.connect(command.code));
      return;
    case 'whoami':
      printJson(await client.whoami());
      return;
    case 'logout':
      printJson((await client.logout()) ?? { loggedOut: true });
      return;
    case 'status': {
      let result = await client.deploymentStatus(command.versionId);
      if (command.wait)
        result = await waitForDeployment(
          result,
          () => client.deploymentStatus(result.version_id),
          (value) => printJson({ type: 'processing', ...value }),
        );
      printJson(command.json ? { type: 'result', result } : result);
      if (result.publication === 'failed') process.exitCode = 1;
      return;
    }
    case 'deploy': {
      const review = command.dryRun ? await client.inspect() : await client.prepare();
      printReview(review, command.dryRun, command.json);
      if (command.dryRun) return;
      const consent = await requirePublicationConsent(review.digest, command);
      let result = await client.deploy(review, { consent });
      if (!command.noWait && result.publication === 'processing') {
        const completed = await waitForDeployment(
          result,
          () => client.deploymentStatus(result.version_id),
          (value) => printJson({ type: 'processing', ...value }),
        );
        result = { ...result, ...completed };
      }
      printJson(command.json ? { type: 'result', result } : result);
      if (result.publication === 'failed') process.exitCode = 1;
      return;
    }
  }
}
