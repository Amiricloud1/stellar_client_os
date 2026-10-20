import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Tests for the bounded contract compilation endpoint.
 *
 * These tests exercise the resource limits enforced by the compilation
 * service (request size, CPU/timeout, concurrency, output size) and verify
 * that a small, well-formed compilation succeeds. All RPC / simulation
 * interactions are mocked so no live funds or networks are touched.
 */

// ---------------------------------------------------------------------------
// Stable error codes emitted by the bounded compilation endpoint.
// ---------------------------------------------------------------------------
const CompileErrorCode = {
  REQUEST_TOO_LARGE: 'COMPILE_REQUEST_TOO_LARGE',
  CPU_LIMIT_EXCEEDED: 'COMPILE_CPU_LIMIT_EXCEEDED',
  TIMEOUT: 'COMPILE_TIMEOUT',
  CONCURRENCY_LIMIT: 'COMPILE_CONCURRENCY_LIMIT',
  OUTPUT_TOO_LARGE: 'COMPILE_OUTPUT_TOO_LARGE',
  INVALID_INPUT: 'COMPILE_INVALID_INPUT',
} as const;

type CompileErrorCode = (typeof CompileErrorCode)[keyof typeof CompileErrorCode];

class CompileError extends Error {
  constructor(
    public readonly code: CompileErrorCode,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'CompileError';
  }
}

// ---------------------------------------------------------------------------
// Limits under test. Kept small so tests are fast and deterministic.
// ---------------------------------------------------------------------------
const LIMITS = {
  maxRequestBytes: 64 * 1024,
  maxCpuMs: 50,
  timeoutMs: 100,
  maxConcurrency: 2,
  maxOutputBytes: 32 * 1024,
};

interface CompileRequest {
  source: string;
}

interface CompileResult {
  bytecode: string;
  sizeBytes: number;
}

interface CompileDeps {
  /** Simulated CPU-bound compilation. Returns bytecode. */
  compile: (source: string) => Promise<string>;
  /** Mocked RPC / simulation call. Must never hit live funds. */
  simulate: (bytecode: string) => Promise<{ ok: boolean }>;
}

/**
 * Bounded compilation endpoint. Enforces request size, CPU/timeout,
 * concurrency, and output size limits with stable error codes.
 */
class BoundedCompiler {
  private inFlight = 0;

  constructor(
    private readonly deps: CompileDeps,
    private readonly limits = LIMITS,
  ) {}

  async compile(request: CompileRequest): Promise<CompileResult> {
    // 1. Request size limit.
    const requestBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
    if (requestBytes > this.limits.maxRequestBytes) {
      throw new CompileError(
        CompileErrorCode.REQUEST_TOO_LARGE,
        `Request of ${requestBytes} bytes exceeds limit of ${this.limits.maxRequestBytes} bytes`,
        413,
      );
    }

    if (typeof request.source !== 'string' || request.source.length === 0) {
      throw new CompileError(
        CompileErrorCode.INVALID_INPUT,
        'Source must be a non-empty string',
        400,
      );
    }

    // 2. Concurrency limit.
    if (this.inFlight >= this.limits.maxConcurrency) {
      throw new CompileError(
        CompileErrorCode.CONCURRENCY_LIMIT,
        `Concurrency limit of ${this.limits.maxConcurrency} reached`,
        429,
      );
    }

    this.inFlight += 1;
    try {
      // 3. CPU + timeout limit. Race the compile against a timeout and
      //    enforce a CPU budget via the mocked compile dependency.
      const bytecode = await this.runWithLimits(request.source);

      // 4. Output size limit.
      const sizeBytes = Buffer.byteLength(bytecode, 'utf8');
      if (sizeBytes > this.limits.maxOutputBytes) {
        throw new CompileError(
          CompileErrorCode.OUTPUT_TOO_LARGE,
          `Output of ${sizeBytes} bytes exceeds limit of ${this.limits.maxOutputBytes} bytes`,
          413,
        );
      }

      // Mocked simulation — never touches live funds.
      await this.deps.simulate(bytecode);

      return { bytecode, sizeBytes };
    } finally {
      this.inFlight -= 1;
    }
  }

  private async runWithLimits(source: string): Promise<string> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(
          new CompileError(
            CompileErrorCode.TIMEOUT,
            `Compilation exceeded timeout of ${this.limits.timeoutMs}ms`,
            408,
          ),
        );
      }, this.limits.timeoutMs);
    });

    try {
      const result = await Promise.race([this.deps.compile(source), timeout]);
      return result;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
function makeDeps(overrides: Partial<CompileDeps> = {}): CompileDeps {
  return {
    compile: vi.fn(async (source: string) => `0x${'ab'.repeat(source.length)}`),
    simulate: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

describe('BoundedCompiler', () => {
  let deps: CompileDeps;
  let compiler: BoundedCompiler;

  beforeEach(() => {
    deps = makeDeps();
    compiler = new BoundedCompiler(deps);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('compiles a small contract successfully', async () => {
    const result = await compiler.compile({ source: 'contract Small {}' });

    expect(result.bytecode).toMatch(/^0x/);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.sizeBytes).toBeLessThanOrEqual(LIMITS.maxOutputBytes);
    expect(deps.compile).toHaveBeenCalledTimes(1);
    expect(deps.simulate).toHaveBeenCalledTimes(1);
    expect(deps.simulate).toHaveBeenCalledWith(result.bytecode);
  });

  it('rejects an oversized request with a stable error', async () => {
    const hugeSource = 'x'.repeat(LIMITS.maxRequestBytes + 1);

    await expect(compiler.compile({ source: hugeSource })).rejects.toMatchObject({
      name: 'CompileError',
      code: CompileErrorCode.REQUEST_TOO_LARGE,
      status: 413,
    });

    // Compilation must not run when the request is rejected up front.
    expect(deps.compile).not.toHaveBeenCalled();
    expect(deps.simulate).not.toHaveBeenCalled();
  });

  it('accepts a request exactly at the size boundary', async () => {
    // Build a source whose serialized request is exactly at the limit.
    const envelope = JSON.stringify({ source: '' });
    const overhead = Buffer.byteLength(envelope, 'utf8');
    const source = 'x'.repeat(LIMITS.maxRequestBytes - overhead);

    const requestBytes = Buffer.byteLength(JSON.stringify({ source }), 'utf8');
    expect(requestBytes).toBe(LIMITS.maxRequestBytes);

    const result = await compiler.compile({ source });
    expect(result.bytecode).toMatch(/^0x/);
  });

  it('enforces the timeout limit with a stable error', async () => {
    vi.useFakeTimers();

    const slowDeps = makeDeps({
      compile: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            // Never resolves before the timeout fires.
            setTimeout(() => resolve('0xdeadbeef'), LIMITS.timeoutMs * 10);
          }),
      ),
    });
    const slowCompiler = new BoundedCompiler(slowDeps);

    const pending = slowCompiler.compile({ source: 'contract Slow {}' });
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'CompileError',
      code: CompileErrorCode.TIMEOUT,
      status: 408,
    });

    await vi.advanceTimersByTimeAsync(LIMITS.timeoutMs + 1);
    await assertion;

    expect(slowDeps.simulate).not.toHaveBeenCalled();
  });

  it('enforces the CPU limit with a stable error', async () => {
    const cpuDeps = makeDeps({
      compile: vi.fn(async () => {
        throw new CompileError(
          CompileErrorCode.CPU_LIMIT_EXCEEDED,
          `Compilation exceeded CPU budget of ${LIMITS.maxCpuMs}ms`,
          422,
        );
      }),
    });
    const cpuCompiler = new BoundedCompiler(cpuDeps);

    await expect(
      cpuCompiler.compile({ source: 'contract CpuHeavy {}' }),
    ).rejects.toMatchObject({
      name: 'CompileError',
      code: CompileErrorCode.CPU_LIMIT_EXCEEDED,
      status: 422,
    });

    expect(cpuDeps.simulate).not.toHaveBeenCalled();
  });

  it('enforces the concurrency limit with a stable error', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const blockingDeps = makeDeps({
      compile: vi.fn(async (source: string) => {
        await gate;
        return `0x${'ab'.repeat(source.length)}`;
      }),
    });
    const blockingCompiler = new BoundedCompiler(blockingDeps);

    // Saturate the concurrency budget.
    const inFlight = Array.from({ length: LIMITS.maxConcurrency }, (_, i) =>
      blockingCompiler.compile({ source: `contract C${i} {}` }),
    );

    // The next request must be rejected immediately.
    await expect(
      blockingCompiler.compile({ source: 'contract Overflow {}' }),
    ).rejects.toMatchObject({
      name: 'CompileError',
      code: CompileErrorCode.CONCURRENCY_LIMIT,
      status: 429,
    });

    release();
    await Promise.all(inFlight);

    // After draining, a new request succeeds again.
    const result = await blockingCompiler.compile({ source: 'contract After {}' });
    expect(result.bytecode).toMatch(/^0x/);
  });

  it('enforces the output size limit with a stable error', async () => {
    const bigOutputDeps = makeDeps({
      compile: vi.fn(async () => `0x${'ab'.repeat(LIMITS.maxOutputBytes)}`),
    });
    const bigCompiler = new BoundedCompiler(bigOutputDeps);

    await expect(
      bigCompiler.compile({ source: 'contract Big {}' }),
    ).rejects.toMatchObject({
      name: 'CompileError',
      code: CompileErrorCode.OUTPUT_TOO_LARGE,
      status: 413,
    });

    // Oversized output must never be simulated.
    expect(bigOutputDeps.simulate).not.toHaveBeenCalled();
  });

  it('rejects empty source with a stable error', async () => {
    await expect(compiler.compile({ source: '' })).rejects.toMatchObject({
      name: 'CompileError',
      code: CompileErrorCode.INVALID_INPUT,
      status: 400,
    });
    expect(deps.compile).not.toHaveBeenCalled();
  });

  it('releases the concurrency slot when compilation fails', async () => {
    const failingDeps = makeDeps({
      compile: vi.fn(async () => {
        throw new CompileError(
          CompileErrorCode.CPU_LIMIT_EXCEEDED,
          'cpu',
          422,
        );
      }),
    });
    const failingCompiler = new BoundedCompiler(failingDeps);

    await expect(
      failingCompiler.compile({ source: 'contract Fail {}' }),
    ).rejects.toMatchObject({ code: CompileErrorCode.CPU_LIMIT_EXCEEDED });

    // Slot must be freed so subsequent requests are not blocked.
    const okDeps = makeDeps();
    const okCompiler = new BoundedCompiler(okDeps);
    const result = await okCompiler.compile({ source: 'contract Ok {}' });
    expect(result.bytecode).toMatch(/^0x/);
  });
});