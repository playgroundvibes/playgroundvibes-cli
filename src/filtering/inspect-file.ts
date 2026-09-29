import { scanText } from './scan-text.js';

/** Match the supplied uploader: scan replacement-decoded UTF-8 without changing bytes. */
export async function inspectFileContents(data: Buffer, filename: string): Promise<void> {
  await scanText(data.toString('utf8'), filename);
}
