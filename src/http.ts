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
  const limit = 2 * 1024 * 1024;
  const signal = AbortSignal.timeout(timeout);
  let response: Response;
  try {
    response = await transport(url, {
      ...init,
      signal,
    });
  } catch {
    throw new RemoteError("Network", "timeout_or_connection");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new RemoteError(
      "HTTP",
      response.status,
      response.status === 429 || response.status >= 500,
    );
  }
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel().catch(() => {});
    throw new RemoteError("Response", "response_limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new RemoteError("Response", "invalid_json");
  let complete = false;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) { complete = true; break; }
      size += part.value.byteLength;
      if (size > limit) throw new RemoteError("Response", "response_limit");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch (e) {
    if (e instanceof RemoteError) throw e;
    if (signal.aborted) throw new RemoteError("Network", "timeout_or_connection");
    throw new RemoteError("Response", "invalid_json");
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
