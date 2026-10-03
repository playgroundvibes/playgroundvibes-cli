import type { DeploymentStatus } from '../publishing/types.js';

/** Poll only the reviewed version; this never retries an upload or alters consent. */
export async function waitForDeployment(
  initial: DeploymentStatus,
  read: () => Promise<DeploymentStatus>,
  progress: (value: DeploymentStatus) => void,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<DeploymentStatus> {
  const deadline = Date.now() + (options.timeoutMs ?? 600_000);
  let current = initial,
    last = '';
  while (current.publication === 'processing') {
    const stage = current.processing?.status || 'processing';
    if (stage !== last) {
      progress(current);
      last = stage;
    }
    if (Date.now() >= deadline)
      return {
        ...current,
        message:
          'Upload saved. Processing is still running. Use playgroundvibes status --wait to continue checking; do not upload again.',
      };
    current = await read();
    if (current.publication === 'processing')
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 5000));
  }
  return current;
}
