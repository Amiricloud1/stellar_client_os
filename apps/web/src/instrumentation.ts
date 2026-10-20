import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

type RequestErrorRequest = {
  headers?: Record<string, string | string[] | undefined> | Headers;
};

type RequestErrorContext = {
  routerKind?: string;
  routePath?: string;
  routeType?: string;
  renderSource?: string;
  revalidateReason?: string;
};

function readHeader(
  headers: RequestErrorRequest["headers"],
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }

  if (typeof (headers as Headers).get === "function") {
    const value = (headers as Headers).get(name);
    return value ?? undefined;
  }

  const record = headers as Record<string, string | string[] | undefined>;
  const direct = record[name] ?? record[name.toLowerCase()];
  if (Array.isArray(direct)) {
    return direct[0];
  }
  return direct;
}

/**
 * Extract the correlation request ID from the incoming request so that
 * server logs, API error payloads, and Sentry events all share the same ID.
 *
 * The API layer sets `x-request-id` on every response and forwards the
 * inbound value (or a freshly generated one) on the request. We prefer the
 * inbound header, then fall back to the response header if present.
 */
export function extractRequestId(request?: RequestErrorRequest): string | undefined {
  if (!request) {
    return undefined;
  }

  return (
    readHeader(request.headers, "x-request-id") ??
    readHeader(request.headers, "x-correlation-id")
  );
}

export const onRequestError: typeof Sentry.captureRequestError = (
  error,
  request,
  context,
) => {
  const requestId = extractRequestId(request as RequestErrorRequest | undefined);

  if (requestId) {
    Sentry.withScope((scope) => {
      scope.setTag("request_id", requestId);
      scope.setContext("request", {
        requestId,
        ...((context ?? {}) as RequestErrorContext),
      });
      Sentry.captureRequestError(error, request, context);
    });
    return;
  }

  Sentry.captureRequestError(error, request, context);
};