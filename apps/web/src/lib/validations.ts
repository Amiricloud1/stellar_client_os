import { z } from 'zod'
import { env } from './env'
import { StellarService } from './stellar'
import { validateContractId } from './stream-validation'
import {
  stellarAddressSchema,
  contractIdSchema,
  tokenAmountSchema,
  positiveIntegerStringSchema,
  streamIdSchema,
  paginationQuerySchema,
  streamStatusSchema,
} from './api-schemas'

// Re-export the shared API schemas so form and API validation share a single
// source of truth (issue #55). Consumers should prefer importing from here.
export {
  stellarAddressSchema,
  contractIdSchema,
  tokenAmountSchema,
  positiveIntegerStringSchema,
  streamIdSchema,
  paginationQuerySchema,
  streamStatusSchema,
}
export type {
  PaginationQuery,
  StreamStatus,
} from './api-schemas'

// Stream record type for display
export interface StreamRecord {
  id: string
  /** Numeric stream ID used for contract operations */
  contractStreamId: number
  sender: string
  recipient: string
  token: string
  tokenSymbol: string
  totalAmount: string
  withdrawnAmount: string
  startTime: number
  endTime: number
  /**
   * The on-chain lifecycle status of this stream.
   * "Confirming" is a transient client-side state used while the creation
   * transaction is still pending confirmation on the Stellar network.
   */
  status: "Active" | "Paused" | "Canceled" | "Completed" | "Confirming"
  cancelable: boolean
  transferable: boolean
  delegateAddress?: string | null
}

export const TOKEN_AMOUNT_REGEX = /^\d+(\.\d{1,7})?$/

export const paymentStreamSchema = z.object({
  recipientAddress: stellarAddressSchema,
  
  token: z
    .string()
    .min(1, "Token selection is required")
    .refine(
      (val) => val === "native" || validateContractId(val),
      "Invalid token: must be 'native' or a valid Stellar contract ID"
    ),
  
  totalAmount: tokenAmountSchema,
  
  duration: positiveIntegerStringSchema,
  
  durationUnit: z.enum(["hours", "days"]),
  
  cancelable: z.boolean(),
  transferable: z.boolean(),
}).strict()

export type PaymentStreamFormData = z.infer<typeof paymentStreamSchema>

/**
 * Schema for cloning an existing campaign.
 * Extends the payment stream schema with the original campaign reference
 * and species, preserving the goal (totalAmount) and timeline (duration/durationUnit).
 */
export const cloneCampaignSchema = paymentStreamSchema.extend({
  sourceCampaignId: z.string().min(1, "Source Campaign ID is required"),
  species: z.string().min(1, "Species is required"),
}).strict()

export type CloneCampaignFormData = z.infer<typeof cloneCampaignSchema>

export const insuranceClaimSchema = z.object({
  changedBy: z.string().min(1, "changedBy is required"),
  evidence: z.array(z.string().min(1, "Each evidence key must not be empty")).min(1, "At least one evidence file is required"),
  description: z.string().max(2000, "Description cannot exceed 2000 characters").optional(),
}).strict();

export type InsuranceClaimFormData = z.infer<typeof insuranceClaimSchema>;

export const SUPPORTED_TOKENS = [
  { value: "USDC", label: "USDC", address: "CBIELTK6YBZJU5UP2WWQEUCYKLUP6AUNZB2QTWFEIE5USCIHMXQDAMA" },
  { value: "USDT", label: "USDT", address: env.NEXT_PUBLIC_USDT_CONTRACT_ID },
  { value: "EURC", label: "EURC", address: env.NEXT_PUBLIC_EURC_CONTRACT_ID },
  { value: "XLM", label: "XLM (Native)", address: "native" },
  { value: "AQUA", label: "AQUA", address: "CAQCFVLOBK5GIULPPNZRGCALJIMZL5BSP7X5YJVMGCCPTUEPFM4AVSDF4Y" }
] as const

/** Only pairs with a configured Soroban token contract can be selected for a live transaction. */
export const CONFIGURED_ESCROW_TOKENS = SUPPORTED_TOKENS.filter(
  (token) => token.value === "XLM" || Boolean(token.address),
)

/**
 * Type representing a supported token entry
 */
export type SupportedToken = (typeof SUPPORTED_TOKENS)[number];

/**
 * Resolve a token value or contract address to a display-friendly ticker symbol.
 * Looks up the input against both the `value` (e.g. "USDC") and `address`
 * (e.g. "CBIEPTKY6ZBZIU5U2PWWQEUCYKLUP6AUNZB2QTWFEE5USCIHYMQADAMA") fields
 * of SUPPORTED_TOKENS. Falls back to the raw input if no match is found.
 *
 * @param tokenOrAddress - Token value ("USDC") or contract address
 * @returns The ticker symbol ("USDC"), or the original input if unrecognised
 *
 * @example
 * gtetTokenSymbol("USDC")                               // "USDC"
 * getTokenSymbol("CBIEPTKY6ZBZIU5U2PWWQEUCYKLUP6AUNZB2QTWFEE5USCIHYMQADAMA") // "USDC"
 * getTokenSymbol("native")                              // "XLM"
 * getTokenSymbol("UNKNOWN")                             // "UNKNOWN"
 */
export function getTokenSymbol(tokenOrAddress: string): string {
  if (!tokenOrAddress) return tokenOrAddress

  // Try matching by value first (fast path for forms)
  const byValue = SUPPORTED_TOKENS.find((t) => t.value === tokenOrAddress)
  if (byValue) return byValue.value

  // Fall back to matching by contract address
  const byAddress = SUPPORTED_TOKENS.find((t) => t.address === tokenOrAddress)
  if (byAddress) return byAddress.value

  // Unrecognised - return as-is
  return tokenOrAddress
}

export const withdrawStreamSchema = z.object({
  amount: tokenAmountSchema,
  
  withdrawTo: stellarAddressSchema,
  
  useMax: z.boolean(),
  useSelf: z.boolean(),
}).strict()

export type WithdrawStreamFormData = z.infer<typeof withdrawStreamSchema>

export const depositStreamSchema = z.object({
  amount: tokenAmountSchema,
}).strict()

export type DepositStreamFormData = z.infer<typeof depositStreamSchema>

/**
 * Schema for creators updating campaign details before launch (issue #721).
 * Allows updating name, description, goal amount, and deadline.
 */
export const updateCampaignSchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string().min(1, "Campaign name is required"),
  description: z.string().min(1, "Description is required"),
  goalAmount: tokenAmountSchema,
  deadline: z.string().min(1, "Deadline is required"),
}).strict()

export type UpdateCampaignFormData = z.infer<typeof updateCampaignSchema>

/**
 * Upload presign validation (issue #62).
 *
 * Presigned upload requests must be bound to an explicit content type, a byte
 * size ceiling, a safe object-key prefix, and the owning campaign/milestone.
 * These schemas are shared by the API route and the client so that tampered or
 * unauthorized payloads are rejected before a signature is ever produced.
 */

/** MIME types that may be uploaded. Anything else is rejected outright. */
export const UPLOAD_ALLOWED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
] as const

export type UploadMimeType = (typeof UPLOAD_ALLOWED_MIME_TYPES)[number]

/** Hard ceiling for a single upload, in bytes (10 MiB). */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024

/** Minimum accepted declared size; zero-byte uploads are rejected. */
export const UPLOAD_MIN_BYTES = 1

/** Presign URLs may not be requested for longer than this (seconds). */
export const UPLOAD_MAX_EXPIRY_SECONDS = 15 * 60

/** Presign URLs must be valid for at least this long (seconds). */
export const UPLOAD_MIN_EXPIRY_SECONDS = 30

/**
 * Object keys must live under a known, non-traversable prefix. The owning
 * campaign id is appended by the server, never supplied verbatim by clients.
 */
export const UPLOAD_KEY_PREFIXES = ["campaigns", "milestones", "evidence"] as const

export type UploadKeyPrefix = (typeof UPLOAD_KEY_PREFIXES)[number]

/** Campaign and milestone identifiers are positive integers. */
export const uploadOwnerIdSchema = z
  .number({ invalid_type_error: "Owner id must be a number" })
  .int("Owner id must be an integer")
  .positive("Owner id must be positive")
  .max(Number.MAX_SAFE_INTEGER, "Owner id is out of range")

/** A single path segment: no slashes, dots-only names, or control characters. */
const SAFE_KEY_SEGMENT_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export const uploadKeySegmentSchema = z
  .string()
  .min(1, "File name is required")
  .max(128, "File name cannot exceed 128 characters")
  .refine((segment) => SAFE_KEY_SEGMENT_REGEX.test(segment), "File name contains unsafe characters")
  .refine((segment) => segment !== "." && segment !== "..", "File name cannot be a relative path")

export const uploadPresignSchema = z
  .object({
    campaignId: uploadOwnerIdSchema,
    milestoneId: uploadOwnerIdSchema.optional(),
    prefix: z.enum(UPLOAD_KEY_PREFIXES),
    fileName: uploadKeySegmentSchema,
    contentType: z.enum(UPLOAD_ALLOWED_MIME_TYPES, {
      errorMap: () => ({ message: "Unsupported content type" }),
    }),
    size: z
      .number({ invalid_type_error: "Size must be a number" })
      .int("Size must be an integer number of bytes")
      .min(UPLOAD_MIN_BYTES, "File must not be empty")
      .max(UPLOAD_MAX_BYTES, `File cannot exceed ${UPLOAD_MAX_BYTES} bytes`),
    expiresIn: z
      .number({ invalid_type_error: "Expiry must be a number of seconds" })
      .int("Expiry must be an integer number of seconds")
      .min(UPLOAD_MIN_EXPIRY_SECONDS, `Expiry must be at least ${UPLOAD_MIN_EXPIRY_SECONDS} seconds`)
      .max(UPLOAD_MAX_EXPIRY_SECONDS, `Expiry cannot exceed ${UPLOAD_MAX_EXPIRY_SECONDS} seconds`)
      .default(UPLOAD_MAX_EXPIRY_SECONDS),
  })
  .strict()

export type UploadPresignInput = z.infer<typeof uploadPresignSchema>

/**
 * Server-side authorization envelope. `ownerAddress` is the authenticated
 * caller and must match the campaign owner; it is never trusted from the body.
 */
export const uploadPresignAuthorizationSchema = z
  .object({
    ownerAddress: z
      .string()
      .min(1, "Owner address is required")
      .refine((address) => StellarService.validateStellarAddress(address), "Invalid owner address"),
  })
  .strict()

export type UploadPresignAuthorization = z.infer<typeof uploadPresignAuthorizationSchema>

/**
 * Build the canonical object key for a validated presign request. The campaign
 * id is always injected by the server so a client cannot target another
 * campaign's namespace.
 */
export function buildUploadObjectKey(
  input: Pick<UploadPresignInput, "prefix" | "campaignId" | "milestoneId" | "fileName">,
): string {
  const parts: string[] = [input.prefix, String(input.campaignId)]
  if (input.milestoneId !== undefined) parts.push(String(input.milestoneId))
  parts.push(input.fileName)
  return parts.join("/")
}

