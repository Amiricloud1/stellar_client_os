/**
 * Helpers for safely configuring Stellar RPC / Horizon HTTP connections.
 *
 * Plain HTTP is only permitted for local loopback endpoints when the caller
 * explicitly opts in via `allowHttp: true`.
 */

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface RpcTransportRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface RpcTransportResponse<T = unknown> {
  status: number;
  data: T;
  headers?: Record<string, string>;
}

export interface RpcTransportErrorDetails {
  code: string;
  message: string;
  statusCode?: number;
  retryable?: boolean;
  context?: Record<string, unknown>;
}

export type CustomRpcTransport = (
  req: RpcTransportRequest
) => Promise<RpcTransportResponse>;

export interface RpcConnectionOptions {
  /** Opt in to plain HTTP for local loopback RPC/Horizon URLs. Defaults to false. */
  allowHttp?: boolean;
  /** Optional custom transport handler for isolated RPC requests. */
  transport?: CustomRpcTransport;
  /** Request timeout in milliseconds. Defaults to 30000. */
  timeoutMs?: number;
}

/**
 * Returns true when `url` uses plain HTTP against a local loopback host.
 */
export function isLoopbackHttpUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:') {
    return false;
  }

  return LOOPBACK_HOSTNAMES.has(parsed.hostname);
}

/**
 * Rejects non-loopback plain-HTTP URLs before any network client is created.
 */
export function assertSecureRpcUrl(url: string): void {
  if (url.startsWith('http://') && !isLoopbackHttpUrl(url)) {
    throw new Error(
      `Insecure RPC URL rejected: "${url}". Use https:// for remote hosts. ` +
        'Plain HTTP is only permitted for local development against ' +
        'http://localhost, http://127.0.0.1, or http://[::1] with allowHttp: true.'
    );
  }
}

/**
 * Resolves Stellar SDK `{ allowHttp }` server options from a URL and caller config.
 */
export function resolveRpcServerOptions(
  url: string,
  options: RpcConnectionOptions = {}
): { allowHttp: boolean } {
  assertSecureRpcUrl(url);

  const requestedAllowHttp = options.allowHttp ?? false;
  if (requestedAllowHttp) {
    if (!isLoopbackHttpUrl(url)) {
      throw new Error(
        'allowHttp: true is only permitted for loopback HTTP URLs ' +
          '(http://localhost, http://127.0.0.1, http://[::1]). ' +
          `Got: "${url}"`
      );
    }
    return { allowHttp: true };
  }

  if (isLoopbackHttpUrl(url)) {
    throw new Error(
      'Plain HTTP for loopback RPC URLs requires explicit allowHttp: true.'
    );
  }

  return { allowHttp: false };
}

/**
 * Creates an isolated RPC dispatcher that executes requests via the provided custom transport
 * or standard fetch, ensuring typed responses, contextual errors, and compatible defaults.
 */
export function createIsolatedRpcDispatcher(options: RpcConnectionOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 30000;

  return async function dispatchRpc<T = unknown>(
    request: RpcTransportRequest
  ): Promise<RpcTransportResponse<T>> {
    assertSecureRpcUrl(request.url);

    if (options.transport) {
      try {
        const res = await options.transport({
          ...request,
          timeoutMs: request.timeoutMs ?? timeoutMs
        });
        return res as RpcTransportResponse<T>;
      } catch (err: unknown) {
        const errorDetail: RpcTransportErrorDetails = {
          code: 'CUSTOM_TRANSPORT_ERROR',
          message: err instanceof Error ? err.message : String(err),
          context: { url: request.url, method: request.method || 'POST' }
        };
        const error = new Error(`Custom RPC transport failed: ${errorDetail.message}`);
        (error as unknown as { details: RpcTransportErrorDetails }).details = errorDetail;
        throw error;
      }
    }

    // Default standard fetch-based transport fallback
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(request.url, {
        method: request.method || 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(request.headers || {})
        },
        body: request.body,
        signal: controller.signal
      });

      const responseData = (await response.json()) as T;
      return {
        status: response.status,
        data: responseData
      };
    } catch (err: unknown) {
      const isAbort = (err as { name?: string })?.name === 'AbortError';
      const errorDetail: RpcTransportErrorDetails = {
        code: isAbort ? 'RPC_TIMEOUT' : 'RPC_NETWORK_ERROR',
        message: err instanceof Error ? err.message : String(err),
        retryable: true,
        context: { url: request.url, timeoutMs }
      };
      const error = new Error(`RPC transport dispatch failed: ${errorDetail.message}`);
      (error as unknown as { details: RpcTransportErrorDetails }).details = errorDetail;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}
