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

  // Webhook signing & delivery configuration (server-side only)
  // Primary secret used to sign outgoing webhook payloads. Required in production.
  WEBHOOK_SIGNING_SECRET: z
    .string()
    .min(16, "Webhook signing secret must be at least 16 characters")
    .optional(),
  // Secondary secret accepted during key rotation (old or new key).
  WEBHOOK_SECONDARY_SECRET: z
    .string()
    .min(16, "Webhook secondary secret must be at least 16 characters")
    .optional(),
  // Maximum age (seconds) of a signed delivery before it is rejected as a replay.
  WEBHOOK_REPLAY_WINDOW_SECONDS: z
    .coerce.number()
    .int("Replay window must be an integer number of seconds")
    .positive("Replay window must be positive")
    .max(3600, "Replay window must not exceed 3600 seconds")
    .default(300),
  // Maximum number of delivery attempts before a webhook is dead-lettered.
  WEBHOOK_MAX_RETRIES: z
    .coerce.number()
    .int("Max retries must be an integer")
    .min(0, "Max retries must be zero or greater")
    .max(20, "Max retries must not exceed 20")
    .default(5),

  // GraphQL query budget configuration (server-side only)
  GRAPHQL_MAX_DEPTH: z
    .coerce.number()
    .int("GraphQL max depth must be an integer")
    .positive("GraphQL max depth must be positive")
    .max(50, "GraphQL max depth must not exceed 50")
    .default(10),
  GRAPHQL_MAX_COMPLEXITY: z
    .coerce.number()
    .int("GraphQL max complexity must be an integer")
    .positive("GraphQL max complexity must be positive")
    .max(100000, "GraphQL max complexity must not exceed 100000")
    .default(1000),
  GRAPHQL_EXECUTION_TIMEOUT_MS: z
    .coerce.number()
    .int("GraphQL execution timeout must be an integer")
    .positive("GraphQL execution timeout must be positive")
    .max(60000, "GraphQL execution timeout must not exceed 60000ms")
    .default(5000),
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
    WEBHOOK_SIGNING_SECRET: process.env.WEBHOOK_SIGNING_SECRET,
    WEBHOOK_SECONDARY_SECRET: process.env.WEBHOOK_SECONDARY_SECRET,
    WEBHOOK_REPLAY_WINDOW_SECONDS: process.env.WEBHOOK_REPLAY_WINDOW_SECONDS,
    WEBHOOK_MAX_RETRIES: process.env.WEBHOOK_MAX_RETRIES,
    GRAPHQL_MAX_DEPTH: process.env.GRAPHQL_MAX_DEPTH,
    GRAPHQL_MAX_COMPLEXITY: process.env.GRAPHQL_MAX_COMPLEXITY,
    GRAPHQL_EXECUTION_TIMEOUT_MS: process.env.GRAPHQL_EXECUTION_TIMEOUT_MS,
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
      WEBHOOK_SIGNING_SECRET: process.env.WEBHOOK_SIGNING_SECRET,
      WEBHOOK_SECONDARY_SECRET: process.env.WEBHOOK_SECONDARY_SECRET,
      WEBHOOK_REPLAY_WINDOW_SECONDS: Number(process.env.WEBHOOK_REPLAY_WINDOW_SECONDS ?? 300),
      WEBHOOK_MAX_RETRIES: Number(process.env.WEBHOOK_MAX_RETRIES ?? 5),
      GRAPHQL_MAX_DEPTH: Number(process.env.GRAPHQL_MAX_DEPTH ?? 10),
      GRAPHQL_MAX_COMPLEXITY: Number(process.env.GRAPHQL_MAX_COMPLEXITY ?? 1000),
      GRAPHQL_EXECUTION_TIMEOUT_MS: Number(process.env.GRAPHQL_EXECUTION_TIMEOUT_MS ?? 5000),
    } as ReturnType<typeof validateEnv>)
  : validateEnv();

export const PAYMENT_STREAM_CONTRACT_ID = env.NEXT_PUBLIC_PAYMENT_STREAM_CONTRACT_ID;
export const DISTRIBUTOR_CONTRACT_ID = env.NEXT_PUBLIC_DISTRIBUTOR_CONTRACT_ID;

// Webhook delivery configuration (see docs/webhooks.md for rotation guidance)
export const WEBHOOK_SIGNING_SECRET = env.WEBHOOK_SIGNING_SECRET;
export const WEBHOOK_SECONDARY_SECRET = env.WEBHOOK_SECONDARY_SECRET;
export const WEBHOOK_REPLAY_WINDOW_SECONDS = env.WEBHOOK_REPLAY_WINDOW_SECONDS;
export const WEBHOOK_MAX_RETRIES = env.WEBHOOK_MAX_RETRIES;

// GraphQL query budget configuration
export const GRAPHQL_MAX_DEPTH = env.GRAPHQL_MAX_DEPTH;
export const GRAPHQL_MAX_COMPLEXITY = env.GRAPHQL_MAX_COMPLEXITY;
export const GRAPHQL_EXECUTION_TIMEOUT_MS = env.GRAPHQL_EXECUTION_TIMEOUT_MS;
