/**
 * Multi-Currency Decimal Normalization, RPC Validation, Batch Limits & Widget Guard (Issues #247, #256, #260, #261)
 */

export interface CurrencyFormatOptions {
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  displaySymbol?: boolean;
}

/**
 * Normalizes multi-currency decimal representations across dashboard cards and tables (Issue #247).
 */
export function formatMultiCurrencyAmount(
  amount: string | number | bigint,
  currencyCode: string = 'XLM',
  options: CurrencyFormatOptions = {}
): string {
  const numericAmount = typeof amount === 'bigint' ? Number(amount) / 10_000_000 : Number(amount);
  if (isNaN(numericAmount)) return `0.00 ${currencyCode}`;

  const minDecimals = options.minimumFractionDigits ?? 2;
  const maxDecimals = options.maximumFractionDigits ?? (currencyCode.toUpperCase() === 'USDC' ? 2 : 7);

  const formattedNumber = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: minDecimals,
    maximumFractionDigits: maxDecimals
  }).format(numericAmount);

  return options.displaySymbol !== false ? `${formattedNumber} ${currencyCode.toUpperCase()}` : formattedNumber;
}

/**
 * Validates custom RPC endpoint URLs before client or provider initialization (Issue #256).
 */
export function validateRpcEndpointUrl(
  url: string,
  allowHttp: boolean = false
): { valid: boolean; error?: string } {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { valid: false, error: `Unsupported protocol: ${parsed.protocol}. Only HTTP and HTTPS are permitted.` };
    }
    const isLoopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol === 'http:' && (!allowHttp || !isLoopback)) {
      return { valid: false, error: 'Insecure HTTP connections are only allowed for local loopback addresses.' };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: `Invalid URL format: "${url}".` };
  }
}

export const MAX_BULK_TRANSACTION_BATCH_SIZE = 50;

/**
 * Enforces maximum batch limits on bulk transaction submissions (Issue #260).
 */
export function enforceBulkBatchLimit<T>(
  items: T[],
  maxLimit: number = MAX_BULK_TRANSACTION_BATCH_SIZE
): T[][] {
  if (items.length === 0) return [];
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += maxLimit) {
    batches.push(items.slice(i, i + maxLimit));
  }
  return batches;
}

/**
 * Fallback error descriptor for dashboard chart widgets and third-party embeds (Issue #261).
 */
export interface WidgetErrorState {
  hasError: boolean;
  widgetName: string;
  errorMessage?: string;
  fallbackMessage: string;
}

export function createWidgetErrorFallback(widgetName: string, error?: Error): WidgetErrorState {
  return {
    hasError: true,
    widgetName,
    errorMessage: error?.message,
    fallbackMessage: `Unable to render ${widgetName}. Displaying safe cached metrics.`
  };
}
