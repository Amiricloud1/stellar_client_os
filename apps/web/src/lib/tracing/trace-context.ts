import { AsyncLocalStorage } from 'async_hooks';
import { randomBytes } from 'crypto';

/**
 * W3C Trace Context and Request Correlation State.
 *
 * @see https://www.w3.org/TR/trace-context/
 */
export interface TraceContext {
  /** 32-hex character W3C trace ID */
  traceId: string;
  /** 16-hex character W3C current span ID */
  spanId: string;
  /** 16-hex character W3C parent span ID if available */
  parentSpanId?: string;
  /** Unique request ID propagated across API, RPC, and webhooks */
  requestId: string;
  /** Correlation ID linking distributed operations across boundaries */
  correlationId: string;
  /** W3C trace flags: '01' indicates recorded/sampled */
  traceFlags: string;
}

export const HEADER_TRACEPARENT = 'traceparent';
export const HEADER_REQUEST_ID = 'x-request-id';
export const HEADER_TRACE_ID = 'x-trace-id';
export const HEADER_CORRELATION_ID = 'x-correlation-id';

const TRACEPARENT_REGEX = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/**
 * Generates a standard 32-character lowercase hex trace ID.
 */
export function generateTraceId(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Generates a standard 16-character lowercase hex span ID.
 */
export function generateSpanId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * Generates an opaque request identifier prefixed with req_.
 */
export function generateRequestId(): string {
  return `req_${randomBytes(8).toString('hex')}`;
}

/**
 * Parses incoming HTTP headers to extract or initialize a TraceContext.
 */
export function extractTraceContext(
  headers: Headers | Record<string, string | string[] | undefined>
): TraceContext {
  const getHeader = (name: string): string | undefined => {
    if (typeof (headers as Headers)?.get === 'function') {
      return (headers as Headers).get(name) || (headers as Headers).get(name.toLowerCase()) || undefined;
    }
    const map = headers as Record<string, string | string[] | undefined>;
    const val = map[name] ?? map[name.toLowerCase()];
    if (Array.isArray(val)) return val[0];
    return val;
  };

  const rawTraceparent = getHeader(HEADER_TRACEPARENT);
  let traceId = '';
  let parentSpanId: string | undefined = undefined;
  let traceFlags = '01';

  if (rawTraceparent) {
    const match = TRACEPARENT_REGEX.exec(rawTraceparent.trim());
    if (match) {
      traceId = match[1];
      parentSpanId = match[2];
      traceFlags = match[3];
    }
  }

  // Fallback to x-trace-id or generate new
  const rawTraceId = getHeader(HEADER_TRACE_ID);
  if (!traceId) {
    if (rawTraceId && /^[0-9a-f]{32}$/i.test(rawTraceId.trim())) {
      traceId = rawTraceId.trim().toLowerCase();
    } else {
      traceId = generateTraceId();
    }
  }

  const spanId = generateSpanId();
  const requestId = getHeader(HEADER_REQUEST_ID)?.trim() || generateRequestId();
  const correlationId = getHeader(HEADER_CORRELATION_ID)?.trim() || requestId;

  return {
    traceId,
    spanId,
    parentSpanId,
    requestId,
    correlationId,
    traceFlags,
  };
}

/**
 * Injects W3C and correlation trace headers into an outgoing HTTP header map.
 */
export function injectTraceHeaders(
  context: TraceContext,
  headers: Record<string, string> = {}
): Record<string, string> {
  const traceparent = `00-${context.traceId}-${context.spanId}-${context.traceFlags}`;

  headers[HEADER_TRACEPARENT] = traceparent;
  headers[HEADER_REQUEST_ID] = context.requestId;
  headers[HEADER_TRACE_ID] = context.traceId;
  headers[HEADER_CORRELATION_ID] = context.correlationId;

  return headers;
}

/**
 * Creates a child TraceContext from an existing parent context.
 */
export function createChildContext(parent: TraceContext): TraceContext {
  return {
    traceId: parent.traceId,
    spanId: generateSpanId(),
    parentSpanId: parent.spanId,
    requestId: parent.requestId,
    correlationId: parent.correlationId,
    traceFlags: parent.traceFlags,
  };
}

// ── Node.js AsyncLocalStorage Propagation ─────────────────────────────────────

const asyncLocalStorage = new AsyncLocalStorage<TraceContext>();

/**
 * Returns the active TraceContext within the current async call stack, or undefined.
 */
export function getActiveTrace(): TraceContext | undefined {
  return asyncLocalStorage.getStore();
}

/**
 * Runs a function within the scope of a TraceContext.
 */
export function runWithTrace<T>(context: TraceContext, fn: () => T): T {
  return asyncLocalStorage.run(context, fn);
}
