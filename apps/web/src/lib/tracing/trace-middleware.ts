import { NextRequest, NextResponse } from 'next/server';
import {
  extractTraceContext,
  injectTraceHeaders,
  runWithTrace,
  TraceContext,
} from './trace-context';
import { Span } from './span';
import { sanitizeHeaders } from './sanitizer';

export type RouteHandler = (
  req: NextRequest,
  context?: { params?: Promise<Record<string, string | string[]>> | Record<string, string | string[]> }
) => Promise<NextResponse | Response>;

/**
 * Higher-order function wrapping Next.js App Router route handlers with distributed tracing.
 * Extracts W3C traceparent and request-id, creates root span, propagates context,
 * and sets trace headers on the response.
 */
export function withApiTracing(
  handlerName: string,
  handler: RouteHandler
): RouteHandler {
  return async (req: NextRequest, routeContext?: { params?: Promise<Record<string, string | string[]>> | Record<string, string | string[]> }) => {
    const traceContext: TraceContext = extractTraceContext(req.headers);
    const span = new Span(traceContext, `api.${handlerName}`, {
      'http.method': req.method,
      'http.url': req.nextUrl?.pathname || req.url,
      'http.headers': sanitizeHeaders(Object.fromEntries(req.headers.entries())),
    });

    return runWithTrace(traceContext, async () => {
      try {
        const response = await handler(req, routeContext);
        span.setAttribute('http.status_code', response.status);

        if (response.status >= 500) {
          span.setStatus('error');
        } else {
          span.setStatus('ok');
        }

        span.end();

        // Ensure outgoing response carries the correlation headers
        const headers = new Headers(response.headers);
        const traceHeaders = injectTraceHeaders(traceContext);
        for (const [k, v] of Object.entries(traceHeaders)) {
          headers.set(k, v);
        }

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch (error) {
        span.recordError(error);
        span.end('error');
        throw error;
      }
    });
  };
}
