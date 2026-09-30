import path from 'node:path';
import { createInterface } from 'node:readline';
import { CLAUDE_COMMAND_PERMISSION } from '../skills/claude-permissions.js';
import { CODEX_COMMAND_RULE, CODEX_RULES_FILE } from '../skills/codex-permissions.js';

export type SkillAgent = 'claude' | 'codex';

const AGENTS = {
  claude: {
    title: 'Claude',
    change: `merges ${CLAUDE_COMMAND_PERMISSION} into .claude/settings.local.json.`,
  },
  codex: {
    title: 'Codex',
    change: `adds ${CODEX_COMMAND_RULE} in ${CODEX_RULES_FILE}.`,
  },
} as const;

/** Ask a terminal user before enabling global commands and project-local permissions. */
export async function confirmAgentCommands(agent: SkillAgent): Promise<boolean> {
  const { title, change } = AGENTS[agent];
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    process.stderr.write(
      `${title} command permissions were not requested. To enable them for this project, run: npx @playgroundvibes/cli@latest skill install --${agent} --allow-${agent}-commands\n`,
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
        `and ${change}`,
        'Existing settings are preserved. Publishing still requires your consent.',
        `Allow ${title} to run playgroundvibes commands for this project? [y/N] `,
      ].join('\n'),
    );
  });
}
