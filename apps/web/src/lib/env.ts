import { z } from "zod";
import { Networks, StrKey } from "@stellar/stellar-sdk";

function isSafeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const isLocalHttp =
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return (
      (url.protocol === "https:" ||
        (process.env.NODE_ENV !== "production" && isLocalHttp)) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function isCanonicalOrigin(value: string): boolean {
  if (!isSafeHttpsUrl(value)) return false;
  const url = new URL(value);
  return url.pathname === "/" && !url.search && !url.hash;
}

function isContractId(value: string): boolean {
  try {
    return StrKey.isValidContract(value);
  } catch {
    return false;
  }
}

function getHostname(value: string | undefined): string {
  if (!value) return "";
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isUnresolvedSecretReference(value: string): boolean {
  return (
    /^\$\{[^}]+\}$/.test(value.trim()) ||
    /^<[^>]+>$/.test(value.trim()) ||
    /^(?:secret|vault|aws-sm):\/\//i.test(value.trim()) ||
    /^arn:aws:secretsmanager:/i.test(value.trim())
  );
}

/**
 * Environment variable validation schema
 * Validates all required environment variables at app startup
 */
const contractIdSchema = z
  .string()
  .refine(isContractId, "Must be a valid Stellar contract address");

const rpcUrlSchema = z
  .string()
  .url("RPC URL must be a valid URL")
  .refine(
    isSafeHttpsUrl,
    "RPC URL must use HTTPS (or local HTTP) without embedded credentials or query secrets",
  );

const envSchema = z.object({
  // Contract IDs are checked as Stellar StrKeys, including their checksum.
  NEXT_PUBLIC_PAYMENT_STREAM_CONTRACT_ID: z
    .string()
    .min(1, "Payment stream contract ID is required")
    .pipe(contractIdSchema),
  
  NEXT_PUBLIC_DISTRIBUTOR_CONTRACT_ID: z
    .string()
    .min(1, "Distributor contract ID is required")
    .pipe(contractIdSchema),

  NEXT_PUBLIC_PLANTER_CONTRACT_ID: z
    .string()
    .pipe(contractIdSchema)
    .optional(),

  // Network Configuration
  NEXT_PUBLIC_SOROBAN_RPC_URL: rpcUrlSchema
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
  NEXT_PUBLIC_URL: z
    .string()
    .url()
    .refine(isCanonicalOrigin, "App URL must be a credential-free HTTPS origin")
    .optional(),
  NEXT_PUBLIC_APP_NAME: z.string().optional(),
  NEXT_PUBLIC_APP_DESCRIPTION: z.string().optional(),

  // Optional: Backend API
  NEXT_PUBLIC_API_URL: z
    .string()
    .url()
    .refine(isSafeHttpsUrl, "API URL must use HTTPS (or local HTTP) without credentials or query secrets")
    .optional()
    .or(z.literal("")),
  NEXT_PUBLIC_BACKEND_BASE_URL: z
    .string()
    .url()
    .refine(isSafeHttpsUrl, "Backend URL must use HTTPS (or local HTTP) without credentials or query secrets")
    .optional()
    .or(z.literal("")),

  // Optional: Stellar URLs
  NEXT_PUBLIC_STELLAR_HORIZON_URL: z
    .string()
    .url()
    .refine(isSafeHttpsUrl, "Horizon URL must use HTTPS (or local HTTP) without credentials or query secrets")
    .optional()
    .or(z.literal("")),

  // Optional: Bridge configuration
  NEXT_PUBLIC_POLYGON_RPC_URL: rpcUrlSchema.optional(),

  // Optional: escrow token contract pairs
  NEXT_PUBLIC_USDT_CONTRACT_ID: contractIdSchema.optional().or(z.literal('')),
  NEXT_PUBLIC_EURC_CONTRACT_ID: contractIdSchema.optional().or(z.literal('')),

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
    .refine(
      (value) => !isUnresolvedSecretReference(value),
      "Webhook signing secret must be injected as a resolved secret value",
    )
    .optional(),
  // Secondary secret accepted during key rotation (old or new key).
  WEBHOOK_SECONDARY_SECRET: z
    .string()
    .min(16, "Webhook secondary secret must be at least 16 characters")
    .refine(
      (value) => !isUnresolvedSecretReference(value),
      "Webhook secondary secret must be injected as a resolved secret value",
    )
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
}).superRefine((config, context) => {
  const isMainnet = config.NEXT_PUBLIC_STELLAR_NETWORK === "mainnet";
  const expectedPassphrase = isMainnet ? Networks.PUBLIC : Networks.TESTNET;
  if (config.NEXT_PUBLIC_NETWORK_PASSPHRASE !== expectedPassphrase) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["NEXT_PUBLIC_NETWORK_PASSPHRASE"],
      message: "Network passphrase does not match the selected Stellar network",
    });
  }

  const rpcHostname = getHostname(config.NEXT_PUBLIC_SOROBAN_RPC_URL);
  const hostSuggestsTestnet = /(^|[.-])testnet([.-]|$)/.test(rpcHostname);
  const hostSuggestsMainnet = /(^|[.-])(mainnet|public)([.-]|$)/.test(rpcHostname);
  if (rpcHostname && ((isMainnet && hostSuggestsTestnet) || (!isMainnet && hostSuggestsMainnet))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["NEXT_PUBLIC_SOROBAN_RPC_URL"],
      message: "RPC endpoint origin does not match the selected Stellar network",
    });
  }

  const horizonUrl = config.NEXT_PUBLIC_STELLAR_HORIZON_URL;
  if (horizonUrl) {
    const horizonHostname = getHostname(horizonUrl);
    const horizonSuggestsTestnet = /(^|[.-])testnet([.-]|$)/.test(horizonHostname);
    const horizonSuggestsMainnet = /(^|[.-])(mainnet|public)([.-]|$)/.test(horizonHostname);
    if (
      (isMainnet && horizonSuggestsTestnet) ||
      (!isMainnet && horizonSuggestsMainnet)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["NEXT_PUBLIC_STELLAR_HORIZON_URL"],
        message: "Horizon endpoint origin does not match the selected Stellar network",
      });
    }
  }

  if (
    process.env.NODE_ENV === "production" &&
    (!config.WEBHOOK_SIGNING_SECRET || config.WEBHOOK_SIGNING_SECRET.length < 32)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["WEBHOOK_SIGNING_SECRET"],
      message: "A 32-character webhook signing secret is required in production",
    });
  }
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates environment variables and returns typed config
 * @throws {Error} If validation fails with detailed error messages
 */
export function validateEnv(): Env {
  const exposedSecretNames = Object.keys(process.env).filter(
    (name) =>
      name.startsWith("NEXT_PUBLIC_") &&
      !name.endsWith("_NETWORK_PASSPHRASE") &&
      /(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY)/i.test(name),
  );
  const unresolvedSecretNames = Object.entries(process.env)
    .filter(([name, value]) =>
      /(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|ACCESS_KEY)/i.test(name) &&
      value !== undefined &&
      isUnresolvedSecretReference(value),
    )
    .map(([name]) => name);
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

  if (
    !result.success ||
    exposedSecretNames.length > 0 ||
    unresolvedSecretNames.length > 0
  ) {
    const errorMessages = result.success
      ? []
      : result.error.issues.map((issue: { path: (string | number)[]; message: string }) => {
          return `  ❌ ${issue.path.join(".")}: ${issue.message}`;
        });
    for (const name of exposedSecretNames) {
      errorMessages.push(`  ❌ ${name}: secret-bearing variables must not use the NEXT_PUBLIC_ prefix`);
    }
    for (const name of unresolvedSecretNames) {
      errorMessages.push(`  ❌ ${name}: secret references must be resolved before startup`);
    }

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
