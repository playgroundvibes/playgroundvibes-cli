export const ORIGIN = 'https://playgroundvibes.com';
export type JsonObject = Record<string, unknown>;
export type PlaygroundEndpoint =
  | '/api/assistant/pair-redeem'
  | '/api/assistant/status'
  | '/api/assistant/disconnect'
  | '/api/assistant/import'
  | '/api/assistant/artifact';
/** Responses are untrusted and validated by each service module. */
export type PlaygroundTransport = (
  endpoint: PlaygroundEndpoint,
  body: JsonObject,
  token?: string,
) => Promise<JsonObject>;

export class APIError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'APIError';
    this.status = status;
  }
}

const ENDPOINTS = new Set([
  '/api/assistant/pair-redeem',
  '/api/assistant/status',
  '/api/assistant/disconnect',
  '/api/assistant/import',
  '/api/assistant/artifact',
]);
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;

/** Send one bounded request to Playground. Server error bodies are never surfaced. */
export const request: PlaygroundTransport = async (endpoint, body, token) => {
  if (!ENDPOINTS.has(endpoint)) throw new Error('Unsupported Playground endpoint.');
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('A Playground request must contain a JSON object.');
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(body);
  } catch {
    throw new Error('The Playground request contains a value that cannot be encoded as JSON.');
  }
  if (Buffer.byteLength(serialized) > MAX_REQUEST_BYTES)
    throw new Error('Upload request exceeds 16 MiB.');
  let response: Response;
  try {
    response = await fetch(ORIGIN + endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: serialized,
    });
  } catch {
    throw new Error('Unable to reach Playground. Check your connection and retry.');
  }
  if (!response.body) throw new Error('Playground returned an unexpected response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Playground response exceeds the permitted size.');
      }
      chunks.push(part.value);
    }
  } catch {
    throw new Error('Unable to read a bounded Playground response. Retry the request.');
  } finally {
    reader.releaseLock();
  }
  // Do not expose service-provided error text: it may echo uploaded secrets.
  if (!response.ok)
    throw new APIError(`Playground request failed (HTTP ${response.status}).`, response.status);
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Playground returned an unexpected response.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Playground returned an unexpected response.');
  }
  return value as JsonObject;
};
