import {
  TraceContext,
  getActiveTrace,
  createChildContext,
  runWithTrace,
  generateSpanId,
  generateTraceId,
} from './trace-context';
import { sanitizeSpanAttributes, sanitizeString } from './sanitizer';

export type SpanStatus = 'ok' | 'error' | 'unset';

export interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: SpanStatus;
  attributes: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

export class Span {
  private readonly data: SpanData;
  private readonly startHrTime: number;

  constructor(
    readonly context: TraceContext,
    readonly name: string,
    initialAttributes: Record<string, unknown> = {}
  ) {
    this.startHrTime = performance.now();
    this.data = {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      name,
      startTime: Date.now(),
      status: 'unset',
      attributes: sanitizeSpanAttributes(initialAttributes),
    };
  }

  /**
   * Set attributes on the span, automatically sanitized to exclude secrets and PII.
   */
  setAttribute(key: string, value: unknown): this {
    const sanitized = sanitizeSpanAttributes({ [key]: value });
    Object.assign(this.data.attributes, sanitized);
    return this;
  }

  setAttributes(attributes: Record<string, unknown>): this {
    const sanitized = sanitizeSpanAttributes(attributes);
    Object.assign(this.data.attributes, sanitized);
    return this;
  }

  setStatus(status: SpanStatus): this {
    this.data.status = status;
    return this;
  }

  recordError(error: unknown): this {
    this.data.status = 'error';
    const err = error instanceof Error ? error : new Error(String(error));
    this.data.error = {
      name: sanitizeString(err.name),
      message: sanitizeString(err.message),
      stack: err.stack ? sanitizeString(err.stack) : undefined,
    };
    return this;
  }

  end(status?: SpanStatus): SpanData {
    if (status) {
      this.setStatus(status);
    } else if (this.data.status === 'unset') {
      this.setStatus('ok');
    }

    const duration = performance.now() - this.startHrTime;
    this.data.durationMs = Number(duration.toFixed(3));
    this.data.endTime = Date.now();

    SpanRecorder.getInstance().record(this.data);
    return this.data;
  }

  getData(): SpanData {
    return { ...this.data };
  }
}

/**
 * In-memory collector for spans, enabling inspection, unit testing, and metrics export.
 */
export class SpanRecorder {
  private static instance: SpanRecorder;
  private spans: SpanData[] = [];
  private readonly maxSpans = 2000;

  static getInstance(): SpanRecorder {
    if (!SpanRecorder.instance) {
      SpanRecorder.instance = new SpanRecorder();
    }
    return SpanRecorder.instance;
  }

  record(span: SpanData): void {
    if (this.spans.length >= this.maxSpans) {
      this.spans.shift(); // Evict oldest
    }
    this.spans.push(span);
  }

  getSpans(): SpanData[] {
    return [...this.spans];
  }

  getSpansByTrace(traceId: string): SpanData[] {
    return this.spans.filter((s) => s.traceId === traceId);
  }

  clear(): void {
    this.spans = [];
  }
}

/**
 * Traces an async operation within an active or newly generated span.
 */
export async function withSpan<T>(
  name: string,
  operation: (span: Span) => Promise<T>,
  attributes: Record<string, unknown> = {}
): Promise<T> {
  const active = getActiveTrace();
  const context: TraceContext = active
    ? createChildContext(active)
    : {
        traceId: generateTraceId(),
        spanId: generateSpanId(),
        requestId: `req_${generateSpanId()}`,
        correlationId: `corr_${generateSpanId()}`,
        traceFlags: '01',
      };

  const span = new Span(context, name, attributes);

  return runWithTrace(context, async () => {
    try {
      const result = await operation(span);
      span.end('ok');
      return result;
    } catch (err) {
      span.recordError(err);
      span.end('error');
      throw err;
    }
  });
}
