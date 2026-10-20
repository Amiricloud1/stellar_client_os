import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  sendDefaultPii: false,
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1 : 0.1,
  beforeSend(event, hint) {
    // Correlate Sentry events with the API response requestId.
    // The requestId is attached to the current scope (e.g. via
    // Sentry.setTag("requestId", ...) in the API error handler) and/or
    // to the error object itself, so we surface it as a top-level tag
    // and context for easy filtering in the Sentry UI.
    const originalException = hint?.originalException;
    const requestIdFromError =
      originalException && typeof originalException === "object"
        ? (originalException as { requestId?: unknown }).requestId
        : undefined;

    const requestId =
      (typeof requestIdFromError === "string" && requestIdFromError) ||
      event.tags?.requestId ||
      (event.contexts?.requestId as { requestId?: string } | undefined)
        ?.requestId;

    if (typeof requestId === "string" && requestId.length > 0) {
      event.tags = { ...event.tags, requestId };
      event.contexts = {
        ...event.contexts,
        requestId: { requestId },
      };
    }

    return event;
  },
});