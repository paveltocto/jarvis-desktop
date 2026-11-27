/** Calls to JSON web APIs, with errors fit to give to the model. */

const TIMEOUT_MS = 20_000;

export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    message: string,
    readonly status: number,
    /** The API's own reason code, when it sends one. */
    readonly reason: string | null = null,
  ) {
    super(message);
  }
}

export interface JsonRequest {
  /** Name used in error messages, for example "Gmail". */
  service: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** Sent as a bearer token. */
  token?: string;
  body?: unknown;
  timeoutMs?: number;
}

interface ErrorBody {
  error?: string | { message?: string; reason?: string };
  message?: string;
  error_description?: string;
}

/** Resolves with the parsed answer, or `null` when the answer is empty. */
export async function requestJson<T>(
  fetcher: typeof fetch,
  url: string,
  request: JsonRequest,
): Promise<T | null> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (request.token) headers.Authorization = `Bearer ${request.token}`;
  if (request.body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  let text: string;
  try {
    response = await fetcher(url, {
      method: request.method ?? "GET",
      headers,
      signal: AbortSignal.timeout(request.timeoutMs ?? TIMEOUT_MS),
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    });
    text = await response.text();
  } catch (error) {
    throw new Error(
      `${request.service} is not reachable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const body = parse(text);
  if (!response.ok) {
    const { message, reason } = describe(body as ErrorBody | null);
    throw new ApiError(
      `${request.service} returned HTTP ${response.status}${message ? `: ${message}` : ""}.`,
      response.status,
      reason,
    );
  }
  if (!text.trim()) return null;
  if (body === null) throw new Error(`${request.service} sent an answer that is not JSON.`);
  return body as T;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function describe(body: ErrorBody | null): { message: string | null; reason: string | null } {
  const error = body?.error;
  if (typeof error === "object") {
    return { message: error.message ?? null, reason: error.reason ?? null };
  }
  return { message: body?.error_description ?? error ?? body?.message ?? null, reason: null };
}
