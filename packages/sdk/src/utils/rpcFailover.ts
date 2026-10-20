/**
 * Bounded Soroban RPC Failover and Error Retry Classification.
 *
 * Provides multi-endpoint failover, exponential backoff with jitter,
 * and deterministic vs. transient error classification.
 */

import { parseContractError } from './errors.js';
import { assertSecureRpcUrl } from './rpcConnectionOptions.js';

export type ErrorClassification = 'transient' | 'deterministic' | 'unknown';

export interface RetryPolicy {
  /** Maximum number of retry attempts across all endpoints. Defaults to 3. */
  maxRetries?: number;
  /** Initial delay in ms before first retry. Defaults to 200ms. */
  initialBackoffMs?: number;
  /** Maximum delay in ms between retries. Defaults to 3000ms. */
  maxBackoffMs?: number;
  /** Backoff multiplier per failed attempt. Defaults to 2. */
  backoffMultiplier?: number;
  /** Enable randomized jitter to prevent thundering herd. Defaults to true. */
  jitter?: boolean;
  /** Cooldown in ms before a failing endpoint is retried. Defaults to 30,000ms. */
  endpointCooldownMs?: number;
}

export interface RpcEndpointState {
  url: string;
  failures: number;
  consecutiveFailures: number;
  lastFailureAt?: number;
  healthy: boolean;
}

export class RpcFailoverError extends Error {
  readonly attempts: number;
  readonly errors: Error[];
  readonly classification: ErrorClassification;

  constructor(
    message: string,
    attempts: number,
    errors: Error[],
    classification: ErrorClassification = 'unknown'
  ) {
    super(message);
    this.name = 'RpcFailoverError';
    this.attempts = attempts;
    this.errors = errors;
    this.classification = classification;
  }
}

/**
 * Classifies an error as 'deterministic' (should not retry) or 'transient' (can retry).
 */
export function classifyRpcError(error: unknown): ErrorClassification {
  if (!error) {
    return 'unknown';
  }

  // 1. Check for Soroban contract errors (e.g. panic, invariant violation, auth failure)
  try {
    const parsed = parseContractError(error);
    if (parsed.type === 'contract_error') {
      return 'deterministic';
    }
  } catch {
    // ignore parser error
  }

  const errStr = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const status = extractHttpStatus(error);

  // 2. HTTP Status checks
  if (status !== null) {
    // 429: Rate limited -> transient
    // 500, 502, 503, 504: Gateway/server down -> transient
    if (status === 429 || status === 502 || status === 503 || status === 504 || status === 500) {
      return 'transient';
    }
    // 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found -> deterministic
    if (status >= 400 && status < 500) {
      return 'deterministic';
    }
  }

  // 3. Known transient network patterns
  const transientPatterns = [
    /network\s*error/i,
    /failed\s*to\s*fetch/i,
    /timeout/i,
    /timed\s*out/i,
    /etimedout/i,
    /econnreset/i,
    /econnrefused/i,
    /ehostunreach/i,
    /socket\s*hang\s*up/i,
    /rate\s*limit/i,
    /overloaded/i,
    /temporarily\s*unavailable/i,
    /503\s+service\s+unavailable/i,
    /504\s+gateway\s+timeout/i,
    /429\s+too\s+many\s+requests/i,
  ];

  for (const pattern of transientPatterns) {
    if (pattern.test(errStr)) {
      return 'transient';
    }
  }

  // 4. Known deterministic contract/auth patterns
  const deterministicPatterns = [
    /invalid\s*argument/i,
    /unauthorized/i,
    /bad\s*sequence/i,
    /tx_bad_seq/i,
    /tx_failed/i,
    /op_malformed/i,
    /contract_error/i,
    /simulation_error/i,
    /hosterror/i,
    /missing\s*signature/i,
  ];

  for (const pattern of deterministicPatterns) {
    if (pattern.test(errStr)) {
      return 'deterministic';
    }
  }

  return 'unknown';
}

function extractHttpStatus(error: unknown): number | null {
  if (typeof error === 'object' && error !== null) {
    if ('status' in error && typeof (error as any).status === 'number') {
      return (error as any).status;
    }
    if ('statusCode' in error && typeof (error as any).statusCode === 'number') {
      return (error as any).statusCode;
    }
    if ('response' in error && typeof (error as any).response === 'object' && (error as any).response !== null) {
      const res = (error as any).response;
      if (typeof res.status === 'number') return res.status;
      if (typeof res.statusCode === 'number') return res.statusCode;
    }
  }

  const str = String(error);
  const match = str.match(/\b(429|500|502|503|504|400|401|403|404)\b/);
  return match ? parseInt(match[1], 10) : null;
}

export class RpcFailoverClient {
  private readonly endpoints: RpcEndpointState[];
  private readonly policy: Required<RetryPolicy>;
  private currentIndex: number = 0;

  constructor(endpoints: string[], policy?: RetryPolicy) {
    if (!endpoints || endpoints.length === 0) {
      throw new Error('RpcFailoverClient requires at least one endpoint');
    }

    endpoints.forEach(url => assertSecureRpcUrl(url));

    this.endpoints = endpoints.map(url => ({
      url,
      failures: 0,
      consecutiveFailures: 0,
      healthy: true,
    }));

    this.policy = {
      maxRetries: policy?.maxRetries ?? 3,
      initialBackoffMs: policy?.initialBackoffMs ?? 200,
      maxBackoffMs: policy?.maxBackoffMs ?? 3000,
      backoffMultiplier: policy?.backoffMultiplier ?? 2,
      jitter: policy?.jitter ?? true,
      endpointCooldownMs: policy?.endpointCooldownMs ?? 30_000,
    };
  }

  getEndpoints(): readonly RpcEndpointState[] {
    return this.endpoints;
  }

  /**
   * Executes an asynchronous RPC operation against the healthiest endpoint,
   * falling over to alternative endpoints on transient failure.
   */
  async execute<T>(
    operation: (endpointUrl: string) => Promise<T>,
    customMaxRetries?: number
  ): Promise<T> {
    const maxRetries = customMaxRetries ?? this.policy.maxRetries;
    const collectedErrors: Error[] = [];
    let attempt = 0;

    while (attempt <= maxRetries) {
      const endpoint = this.selectNextEndpoint();

      try {
        const result = await operation(endpoint.url);
        // On success, reset consecutive failures
        endpoint.consecutiveFailures = 0;
        endpoint.healthy = true;
        return result;
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        collectedErrors.push(error);

        const classification = classifyRpcError(error);

        // Immediately throw deterministic contract or validation errors
        if (classification === 'deterministic') {
          throw error;
        }

        // Record failure against this endpoint
        endpoint.failures++;
        endpoint.consecutiveFailures++;
        endpoint.lastFailureAt = Date.now();
        if (endpoint.consecutiveFailures >= 2) {
          endpoint.healthy = false;
        }

        attempt++;
        if (attempt > maxRetries) {
          break;
        }

        // Calculate backoff
        const delay = this.calculateBackoff(attempt);
        await sleep(delay);
      }
    }

    throw new RpcFailoverError(
      `RPC operation failed after ${attempt} attempts across ${this.endpoints.length} endpoints. Last error: ${collectedErrors[collectedErrors.length - 1]?.message}`,
      attempt,
      collectedErrors,
      'transient'
    );
  }

  private selectNextEndpoint(): RpcEndpointState {
    const now = Date.now();

    // Check if any cooldowns have elapsed
    for (const ep of this.endpoints) {
      if (!ep.healthy && ep.lastFailureAt) {
        if (now - ep.lastFailureAt >= this.policy.endpointCooldownMs) {
          ep.healthy = true;
          ep.consecutiveFailures = 0;
        }
      }
    }

    // Try starting from currentIndex
    for (let i = 0; i < this.endpoints.length; i++) {
      const idx = (this.currentIndex + i) % this.endpoints.length;
      if (this.endpoints[idx].healthy) {
        this.currentIndex = (idx + 1) % this.endpoints.length;
        return this.endpoints[idx];
      }
    }

    // If all unhealthy, fallback to least recently failed
    let oldestIndex = 0;
    let oldestTime = Infinity;
    for (let i = 0; i < this.endpoints.length; i++) {
      const time = this.endpoints[i].lastFailureAt ?? 0;
      if (time < oldestTime) {
        oldestTime = time;
        oldestIndex = i;
      }
    }

    this.currentIndex = (oldestIndex + 1) % this.endpoints.length;
    return this.endpoints[oldestIndex];
  }

  private calculateBackoff(attempt: number): number {
    const base = this.policy.initialBackoffMs * Math.pow(this.policy.backoffMultiplier, attempt - 1);
    const capped = Math.min(base, this.policy.maxBackoffMs);

    if (this.policy.jitter) {
      // Full jitter: between 0.5 * capped and capped
      return Math.floor(capped * (0.5 + Math.random() * 0.5));
    }

    return Math.floor(capped);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
