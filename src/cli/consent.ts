import { createInterface } from 'node:readline';

export interface PublicationConsentOptions {
  consent?: string;
  json: boolean;
}

async function confirmPublication(): Promise<boolean> {
  const input = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise<boolean>((resolve) => {
    let answered = false;
    input.once('line', (answer) => {
      answered = true;
      input.close();
      resolve(answer === 'PUBLISH');
    });
    input.once('close', () => {
      if (!answered) resolve(false);
    });
    input.once('SIGINT', () => input.close());
    process.stdout.write(
      'Type PUBLISH to publish exactly this reviewed project, or anything else to cancel: ',
    );
  });
}

/** Require approval of the displayed review; JSON and non-TTY callers never prompt. */
export async function requirePublicationConsent(
  digest: string,
  options: PublicationConsentOptions,
): Promise<string> {
  if (options.consent !== undefined) {
    if (options.consent !== digest) {
      throw new Error(
        'Consent does not match this review. No upload occurred. Review the current files and account, then use its exact digest.',
      );
    }
    return options.consent;
  }
  if (!options.json && process.stdin.isTTY && process.stdout.isTTY) {
    const confirmed = await confirmPublication();
    if (!confirmed) throw new Error('Publication cancelled. No upload occurred.');
    return digest;
  }
  throw new Error(
    `Consent required. No upload occurred. After reviewing these files, exclusions, destination, and account, run: playgroundvibes deploy --consent ${digest}${options.json ? ' --json' : ''}`,
  );
}
