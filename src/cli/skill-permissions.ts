import path from 'node:path';
import { createInterface } from 'node:readline';
import { CLAUDE_COMMAND_PERMISSION } from '../skills/claude-permissions.js';

/** Ask a terminal user before enabling global commands and project-local permissions. */
export async function confirmClaudeCommands(): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    process.stderr.write(
      'Claude command permissions were not requested. To enable them for this project, run: npx @playgroundvibes/cli@latest skill install --claude --allow-claude-commands\n',
    );
    return false;
  }

  const input = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  return new Promise<boolean>((resolve, reject) => {
    let finished = false;
    const answer = (confirmed: boolean): void => {
      if (finished) return;
      finished = true;
      input.close();
      resolve(confirmed);
    };
    input.once('line', (line) => answer(/^(?:y|yes)$/i.test(line.trim())));
    input.once('close', () => answer(false));
    input.once('SIGINT', () => {
      if (finished) return;
      finished = true;
      input.close();
      reject(new Error('Skill installation cancelled.'));
    });

    process.stderr.write(
      [
        `Current project: ${JSON.stringify(path.resolve(process.cwd()))}`,
        'This installs the matching @playgroundvibes/cli version globally if needed',
        `and merges ${CLAUDE_COMMAND_PERMISSION} into .claude/settings.local.json.`,
        'Existing settings are preserved. Publishing still requires your consent.',
        'Allow Claude to run playgroundvibes commands for this project? [y/N] ',
      ].join('\n'),
    );
  });
}
