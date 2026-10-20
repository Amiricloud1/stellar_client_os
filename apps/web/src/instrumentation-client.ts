import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  sendDefaultPii: false,
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1 : 0.1,
  beforeSend(event) {
    // Attach the API correlation ID (requestId) captured from the most recent
    // API response so client-side error reports share the same correlation ID
    // as the server logs for the originating request.
    const requestId = getLastApiRequestId();
    if (requestId) {
      event.tags = { ...event.tags, requestId };
      event.contexts = {
        ...event.contexts,
        correlation: { requestId },
      };
    }
    return event;
  },
});

const REQUEST_ID_STORAGE_KEY = "api:lastRequestId";

let lastApiRequestId: string | undefined;

function readPersistedRequestId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.sessionStorage.getItem(REQUEST_ID_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns the requestId from the most recent API response, if any.
 * Prefers the in-memory value and falls back to sessionStorage so the
 * correlation ID survives full page reloads within the same tab.
 */
export function getLastApiRequestId(): string | undefined {
  return lastApiRequestId ?? readPersistedRequestId();
}

/**
 * Records the requestId returned by an API response so subsequent client-side
 * error reports can be correlated with server logs. Safe to call with
 * undefined/null (no-op) and in non-browser environments.
 */
export function setLastApiRequestId(requestId: string | null | undefined): void {
  if (!requestId) return;
  lastApiRequestId = requestId;
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(REQUEST_ID_STORAGE_KEY, requestId);
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;