import * as Sentry from "@sentry/nextjs";
import {
  sanitizeError,
  sanitizeObject,
  sanitizeErrorString,
  sanitizeUrl,
  scrubSentryEvent,
  scrubSentryBreadcrumb,
} from "./sanitize-error";

export { scrubSentryEvent, scrubSentryBreadcrumb };

export type ErrorContext = {
  boundaryName?: string;
  componentStack?: string;
  digest?: string;
  [key: string]: unknown;
};

function captureSentryError(error: Error, context: Record<string, unknown>): void {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return;

  Sentry.withScope((scope) => {
    scope.setContext("fundable", context);
    Sentry.captureException(error);
  });
}

/**
 * Report a runtime error to the configured error reporting endpoint.
 * All sensitive data (Stellar secret keys, tax IDs, signed transactions,
 * evidence, and sensitive URL/body fields) are automatically sanitized
 * before being sent to prevent data exposure in telemetry logs.
 */
export function reportRuntimeError(error: Error, context: ErrorContext = {}): void {
  if (process.env.NODE_ENV !== "production" || typeof window === "undefined") {
    return;
  }

  const sanitizeOpts = { maskFullKey: false };
  const sanitizedError = sanitizeError(error, sanitizeOpts);
  const sanitizedContext = sanitizeObject(context, sanitizeOpts);

  const sentryContext: Record<string, unknown> = {
    ...sanitizedContext,
    boundaryName: sanitizedContext.boundaryName,
    componentStack: sanitizedContext.componentStack,
  };
  if (sanitizedContext.digest !== undefined) {
    sentryContext.digest = sanitizedContext.digest;
  }

  captureSentryError(sanitizedError, sentryContext);

  const rawPath =
    typeof window !== "undefined"
      ? `${window.location.pathname}${window.location.search || ""}`
      : undefined;

  const payload = {
    name: sanitizedError.name,
    message: sanitizedError.message,
    stack: sanitizedError.stack,
    boundaryName: sanitizedContext.boundaryName,
    componentStack: sanitizedContext.componentStack,
    digest: sanitizedContext.digest,
    path: rawPath ? sanitizeUrl(sanitizeErrorString(rawPath, sanitizeOpts), sanitizeOpts) : undefined,
    timestamp: new Date().toISOString(),
  };

  const endpoint = process.env.NEXT_PUBLIC_ERROR_REPORTING_ENDPOINT;

  if (endpoint) {
    void fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => undefined);
    return;
  }

  window.dispatchEvent(new CustomEvent("fundable:runtime-error", { detail: payload }));
}

/**
 * Report a caught error with additional context.
 * Automatically sanitizes all sensitive data before reporting.
 */
export function reportCaughtError(
  error: unknown,
  context: Record<string, unknown> = {}
): void {
  if (process.env.NODE_ENV !== "production" || typeof window === "undefined") {
    return;
  }

  const sanitizeOpts = { maskFullKey: false };
  const errorObj = error instanceof Error ? error : new Error(String(error));

  const sanitizedError = sanitizeError(errorObj, sanitizeOpts);
  const sanitizedContext = sanitizeObject(context, sanitizeOpts);
  captureSentryError(sanitizedError, sanitizedContext as Record<string, unknown>);

  const rawPath =
    typeof window !== "undefined"
      ? `${window.location.pathname}${window.location.search || ""}`
      : undefined;

  const payload = {
    name: sanitizedError.name,
    message: sanitizedError.message,
    stack: sanitizedError.stack,
    context: sanitizedContext,
    path: rawPath ? sanitizeUrl(sanitizeErrorString(rawPath, sanitizeOpts), sanitizeOpts) : undefined,
    timestamp: new Date().toISOString(),
  };

  const endpoint = process.env.NEXT_PUBLIC_ERROR_REPORTING_ENDPOINT;

  if (endpoint) {
    void fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => undefined);
    return;
  }

  window.dispatchEvent(new CustomEvent("fundable:runtime-error", { detail: payload }));
}