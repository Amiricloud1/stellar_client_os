import * as Sentry from "@sentry/nextjs";
import { scrubSentryBreadcrumb, scrubSentryEvent } from "@/lib/sanitize-error";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  sendDefaultPii: false,
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1 : 0.1,
  beforeSend(event) {
    return scrubSentryEvent(event);
  },
  beforeSendTransaction(event) {
    return scrubSentryEvent(event);
  },
  beforeBreadcrumb(breadcrumb) {
    return scrubSentryBreadcrumb(breadcrumb);
  },
});
