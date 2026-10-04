export class RemoteError extends Error {
  constructor(
    public service: string,
    public code: number | string,
    public retryable = true,
  ) {
    super(
      `${service} failed (code ${String(code)
        .replace(/[^a-zA-Z0-9_-]/g, "")
        .slice(0, 40)})`,
    );
  }
}
export type Fetch = typeof fetch;
export async function jsonRequest(
  url: string,
  init: RequestInit = {},
  timeout = 5000,
  transport: Fetch = fetch,
): Promise<any> {
  let response: Response;
  try {
    response = await transport(url, {
      ...init,
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new RemoteError("Network", "timeout_or_connection");
  }
  if (!response.ok)
    throw new RemoteError(
      "HTTP",
      response.status,
      response.status === 429 || response.status >= 500,
    );
  try {
    return await response.json();
  } catch {
    throw new RemoteError("Response", "invalid_json");
  }
}
