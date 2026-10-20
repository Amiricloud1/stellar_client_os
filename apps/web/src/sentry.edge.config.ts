import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  sendDefaultPii: false,
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1 : 0.1,
  initialScope: {
    tags: {
      runtime: "edge",
    },
  },
  beforeSend(event, hint) {
    // Correlate edge-runtime errors with the API response requestId.
    // The requestId is attached to the Sentry scope by the API error
    // handler (see apps/web/src/lib/api/errors.ts) and propagated here so
    // that server logs and client-facing responses share the same ID.
    const requestId =
      (event.tags?.requestId as string | undefined) ??
      (event.contexts?.request as { requestId?: string } | undefined)?.requestId;

    if (requestId) {
      event.tags = { ...event.tags, requestId };
      event.contexts = {
        ...event.contexts,
        request: {
          ...(event.contexts?.request ?? {}),
          requestId,
        },
      };
    }

    // Never leak stack traces or internal error details to Sentry payloads
    // that could be surfaced back to clients.
    if (event.exception?.values) {
      event.exception.values = event.exception.values.map((value) => ({
        ...value,
        stacktrace: undefined,
      }));
    }

    return event;
  },
});