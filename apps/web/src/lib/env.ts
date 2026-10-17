import { z } from "zod";

/**
 * Environment variable validation schema
 * Validates all required environment variables at app startup
 */
const envSchema = z.object({
  // Contract IDs - must start with 'C' (Stellar contract address format)
  NEXT_PUBLIC_PAYMENT_STREAM_CONTRACT_ID: z
    .string()
    .min(1, "Payment stream contract ID is required")
    .startsWith("C", "Contract ID must start with 'C'"),
  
  NEXT_PUBLIC_DISTRIBUTOR_CONTRACT_ID: z
    .string()
    .min(1, "Distributor contract ID is required")
    .startsWith("C", "Contract ID must start with 'C'"),

  NEXT_PUBLIC_PLANTER_CONTRACT_ID: z
    .string()
    .startsWith("C", "Contract ID must start with 'C'")
    .optional(),

  // Network Configuration
  NEXT_PUBLIC_SOROBAN_RPC_URL: z
    .string()
    .url("Soroban RPC URL must be a valid URL")
    .default("https://soroban-testnet.stellar.org"),

  NEXT_PUBLIC_NETWORK_PASSPHRASE: z
    .string()
    .min(1, "Network passphrase is required")
    .default("Test SDF Network ; September 2015"),

  NEXT_PUBLIC_STELLAR_NETWORK: z
    .enum(["testnet", "mainnet"], {
      errorMap: () => ({ message: "Network must be either 'testnet' or 'mainnet'" }),
    })
    .default("testnet"),

  // Optional: App metadata
  NEXT_PUBLIC_URL: z.string().url().optional(),
  NEXT_PUBLIC_APP_NAME: z.string().optional(),
  NEXT_PUBLIC_APP_DESCRIPTION: z.string().optional(),

  // Optional: Backend API
  NEXT_PUBLIC_API_URL: z.string().url().optional().or(z.literal("")),
  NEXT_PUBLIC_BACKEND_BASE_URL: z.string().url().optional().or(z.literal("")),

  // Optional: Stellar URLs
  NEXT_PUBLIC_STELLAR_HORIZON_URL: z.string().url().optional().or(z.literal("")),

  // Optional: Bridge configuration
  NEXT_PUBLIC_POLYGON_RPC_URL: z.string().url().optional(),

  // Optional: escrow token contract pairs
  NEXT_PUBLIC_USDT_CONTRACT_ID: z.string().startsWith('C').optional().or(z.literal('')),
  NEXT_PUBLIC_EURC_CONTRACT_ID: z.string().startsWith('C').optional().or(z.literal('')),

  // Optional: Feature flags
  NEXT_PUBLIC_OFFRAMP_MOCK: z
    .string()
    .transform((val: string) => val === "true")
    .optional(),

  // Optional: Trusted reverse proxies (comma-separated CIDR/IP list).
  // Only requests arriving from these addresses may supply forwarding headers
  // (X-Forwarded-For / X-Real-IP) used for rate-limit identity keys.
  // Defaults to an empty list, meaning forwarding headers are ignored.
  TRUSTED_PROXIES: z
    .string()
    .optional()
    .transform((val: string | undefined) =>
      (val ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),

  // Optional: Unified rate-limit policy overrides, per route class.
  // Each value is a positive integer; unset values fall back to the
  // per-class defaults defined in the rate-limit policy module.
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_AUTH_WINDOW_MS: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_WRITE_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_WRITE_WINDOW_MS: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_READ_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_READ_WINDOW_MS: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_WEBHOOK_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_WEBHOOK_WINDOW_MS: z.coerce.number().int().positive().optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates environment variables and returns typed config
 * @throws {Error} If validation fails with detailed error messages
 */
export function validateEnv(): Env {
  const env = {
    NEXT_PUBLIC_PAYMENT_STREAM_CONTRACT_ID: process.env.NEXT_PUBLIC_PAYMENT_STREAM_CONTRACT_ID,
    NEXT_PUBLIC_DISTRIBUTOR_CONTRACT_ID: process.env.NEXT_PUBLIC_DISTRIBUTOR_CONTRACT_ID,
    NEXT_PUBLIC_PLANTER_CONTRACT_ID: process.env.NEXT_PUBLIC_PLANTER_CONTRACT_ID,
    NEXT_PUBLIC_SOROBAN_RPC_URL: process.env.NEXT_PUBLIC_SOROBAN_RPC_URL,
    NEXT_PUBLIC_NETWORK_PASSPHRASE: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE,
    NEXT_PUBLIC_STELLAR_NETWORK: process.env.NEXT_PUBLIC_STELLAR_NETWORK,
    NEXT_PUBLIC_URL: process.env.NEXT_PUBLIC_URL,
    NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
    NEXT_PUBLIC_APP_DESCRIPTION: process.env.NEXT_PUBLIC_APP_DESCRIPTION,
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_BACKEND_BASE_URL: process.env.NEXT_PUBLIC_BACKEND_BASE_URL,
    NEXT_PUBLIC_STELLAR_HORIZON_URL: process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL,
    NEXT_PUBLIC_POLYGON_RPC_URL: process.env.NEXT_PUBLIC_POLYGON_RPC_URL,
    NEXT_PUBLIC_USDT_CONTRACT_ID: process.env.NEXT_PUBLIC_USDT_CONTRACT_ID,
    NEXT_PUBLIC_EURC_CONTRACT_ID: process.env.NEXT_PUBLIC_EURC_CONTRACT_ID,
    NEXT_PUBLIC_OFFRAMP_MOCK: process.env.NEXT_PUBLIC_OFFRAMP_MOCK,
    TRUSTED_PROXIES: process.env.TRUSTED_PROXIES,
    RATE_LIMIT_AUTH_MAX: process.env.RATE_LIMIT_AUTH_MAX,
    RATE_LIMIT_AUTH_WINDOW_MS: process.env.RATE_LIMIT_AUTH_WINDOW_MS,
    RATE_LIMIT_WRITE_MAX: process.env.RATE_LIMIT_WRITE_MAX,
    RATE_LIMIT_WRITE_WINDOW_MS: process.env.RATE_LIMIT_WRITE_WINDOW_MS,
    RATE_LIMIT_READ_MAX: process.env.RATE_LIMIT_READ_MAX,
    RATE_LIMIT_READ_WINDOW_MS: process.env.RATE_LIMIT_READ_WINDOW_MS,
    RATE_LIMIT_WEBHOOK_MAX: process.env.RATE_LIMIT_WEBHOOK_MAX,
    RATE_LIMIT_WEBHOOK_WINDOW_MS: process.env.RATE_LIMIT_WEBHOOK_WINDOW_MS,
  };

  const result = envSchema.safeParse(env);

  if (!result.success) {
    const errorMessages = result.error.issues.map((issue: { path: (string | number)[]; message: string }) => {
      return `  ❌ ${issue.path.join(".")}: ${issue.message}`;
    });

    const errorMessage = [
      "",
      "❌ Environment variable validation failed:",
      "",
      ...errorMessages,
      "",
      "Please check your .env.local file and ensure all required variables are set.",
      "See .env.example for reference.",
      "",
    ].join("\n");

    throw new Error(errorMessage);
  }

  return result.data;
}

// Validate and export typed environment variables
// Skip module-level validation in test environments (tests call validateEnv() directly)
export const env = process.env.NODE_ENV === 'test'
  ? ({
      NEXT_PUBLIC_PAYMENT_STREAM_CONTRACT_ID: process.env.NEXT_PUBLIC_PAYMENT_STREAM_CONTRACT_ID ?? 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      NEXT_PUBLIC_DISTRIBUTOR_CONTRACT_ID: process.env.NEXT_PUBLIC_DISTRIBUTOR_CONTRACT_ID ?? 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      NEXT_PUBLIC_PLANTER_CONTRACT_ID: process.env.NEXT_PUBLIC_PLANTER_CONTRACT_ID,
      NEXT_PUBLIC_SOROBAN_RPC_URL: process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org',
      NEXT_PUBLIC_NETWORK_PASSPHRASE: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015',
      NEXT_PUBLIC_STELLAR_NETWORK: (process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? 'testnet') as 'testnet' | 'mainnet',
      NEXT_PUBLIC_STELLAR_HORIZON_URL: process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL ?? 'https://horizon-testnet.stellar.org',
      NEXT_PUBLIC_USDT_CONTRACT_ID: process.env.NEXT_PUBLIC_USDT_CONTRACT_ID ?? '',
      NEXT_PUBLIC_EURC_CONTRACT_ID: process.env.NEXT_PUBLIC_EURC_CONTRACT_ID ?? '',
      // Test-mode fallbacks: no trusted proxies (forwarding headers ignored)
      // and no rate-limit overrides (per-class defaults apply).
      TRUSTED_PROXIES: (process.env.TRUSTED_PROXIES ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
      RATE_LIMIT_AUTH_MAX: process.env.RATE_LIMIT_AUTH_MAX
        ? Number(process.env.RATE_LIMIT_AUTH_MAX)
        : undefined,
      RATE_LIMIT_AUTH_WINDOW_MS: process.env.RATE_LIMIT_AUTH_WINDOW_MS
        ? Number(process.env.RATE_LIMIT_AUTH_WINDOW_MS)
        : undefined,
      RATE_LIMIT_WRITE_MAX: process.env.RATE_LIMIT_WRITE_MAX
        ? Number(process.env.RATE_LIMIT_WRITE_MAX)
        : undefined,
      RATE_LIMIT_WRITE_WINDOW_MS: process.env.RATE_LIMIT_WRITE_WINDOW_MS
        ? Number(process.env.RATE_LIMIT_WRITE_WINDOW_MS)
        : undefined,
      RATE_LIMIT_READ_MAX: process.env.RATE_LIMIT_READ_MAX
        ? Number(process.env.RATE_LIMIT_READ_MAX)
        : undefined,
      RATE_LIMIT_READ_WINDOW_MS: process.env.RATE_LIMIT_READ_WINDOW_MS
        ? Number(process.env.RATE_LIMIT_READ_WINDOW_MS)
        : undefined,
      RATE_LIMIT_WEBHOOK_MAX: process.env.RATE_LIMIT_WEBHOOK_MAX
        ? Number(process.env.RATE_LIMIT_WEBHOOK_MAX)
        : undefined,
      RATE_LIMIT_WEBHOOK_WINDOW_MS: process.env.RATE_LIMIT_WEBHOOK_WINDOW_MS
        ? Number(process.env.RATE_LIMIT_WEBHOOK_WINDOW_MS)
        : undefined,
    } as ReturnType<typeof validateEnv>)
  : validateEnv();

export const PAYMENT_STREAM_CONTRACT_ID = env.NEXT_PUBLIC_PAYMENT_STREAM_CONTRACT_ID;
export const DISTRIBUTOR_CONTRACT_ID = env.NEXT_PUBLIC_DISTRIBUTOR_CONTRACT_ID;
