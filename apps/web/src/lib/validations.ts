import { z } from 'zod'
import { env } from './env'
import { StellarService } from './stellar'
import { validateContractId } from './stream-validation'

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
  recipientAddress: z
    .string()
    .min(1, "Recipient address is required")
    .refine((address) => StellarService.validateStellarAddress(address), "Please enter a valid Stellar public key"),
  
  token: z
    .string()
    .min(1, "Token selection is required")
    .refine(
      (val) => val === "native" || validateContractId(val),
      "Invalid token: must be 'native' or a valid Stellar contract ID"
    ),
  
  totalAmount: z
    .string()
    .min(1, "Amount is required")
    .refine((val) => {
      const num = parseFloat(val)
      return !isNaN(num) && num > 0
    }, "Amount must be a positive number")
    .refine((val) => TOKEN_AMOUNT_REGEX.test(val), "Amount cannot exceed 7 decimal places"),
  
  duration: z
    .string()
    .min(1, "Duration is required")
    .refine((val) => {
      const num = parseInt(val)
      return !isNaN(num) && num > 0
    }, "Duration must be a positive number"),
  
  durationUnit: z.enum(["hours", "days"]),
  
  cancelable: z.boolean(),
  transferable: z.boolean(),
})

export type PaymentStreamFormData = z.infer<typeof paymentStreamSchema>

/**
 * Schema for cloning an existing campaign.
 * Extends the payment stream schema with the original campaign reference
 * and species, preserving the goal (totalAmount) and timeline (duration/durationUnit).
 */
export const cloneCampaignSchema = paymentStreamSchema.extend({
  sourceCampaignId: z.string().min(1, "Source Campaign ID is required"),
  species: z.string().min(1, "Species is required"),
})

export type CloneCampaignFormData = z.infer<typeof cloneCampaignSchema>

export const insuranceClaimSchema = z.object({
  changedBy: z.string().min(1, "changedBy is required"),
  evidence: z.array(z.string().min(1, "Each evidence key must not be empty")).min(1, "At least one evidence file is required"),
  description: z.string().max(2000, "Description cannot exceed 2000 characters").optional(),
});

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
  amount: z
    .string()
    .min(1, "Amount is required")
    .refine((val) => {
      const num = parseFloat(val)
      return !isNaN(num) && num > 0
    }, "Amount must be a positive number")
    .refine((val) => TOKEN_AMOUNT_REGEX.test(val), "Amount cannot exceed 7 decimal places"),
  
  withdrawTo: z
    .string()
    .min(1, "Withdraw address is required")
    .refine((address) => StellarService.validateStellarAddress(address), "Invalid Stellar address format"),
  
  useMax: z.boolean(),
  useSelf: z.boolean(),
})

export type WithdrawStreamFormData = z.infer<typeof withdrawStreamSchema>

export const depositStreamSchema = z.object({
  amount: z
    .string()
    .min(1, "Amount is required")
    .refine((val) => {
      const num = parseFloat(val)
      return !isNaN(num) && num > 0
    }, "Amount must be a positive number")
    .refine((val) => TOKEN_AMOUNT_REGEX.test(val), "Amount cannot exceed 7 decimal places"),
})

export type DepositStreamFormData = z.infer<typeof depositStreamSchema>

/**
 * Schema for creators updating campaign details before launch (issue #721).
 * Allows updating name, description, goal amount, and deadline.
 */
export const updateCampaignSchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string().min(1, "Campaign name is required"),
  description: z.string().min(1, "Description is required"),
  goalAmount: z
    .string()
    .min(1, "Goal amount is required")
    .refine((val) => {
      const num = parseFloat(val)
      return !isNaN(num) && num > 0
    }, "Goal amount must be a positive number")
    .refine((val) => TOKEN_AMOUNT_REGEX.test(val), "Goal amount cannot exceed 7 decimal places"),
  deadline: z.string().min(1, "Deadline is required"),
})

export type UpdateCampaignFormData = z.infer<typeof updateCampaignSchema>

/**
 * Shared pagination and sorting contract for list endpoints (issue #59).
 *
 * Every list endpoint (campaigns, backers, audit, analytics) validates its
 * query parameters through these schemas so ordering is stable, page sizes are
 * bounded, and invalid sort fields are rejected with a typed error.
 */
export const DEFAULT_PAGE = 1
export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 100

/** Allowlisted sort fields per list resource. Unknown fields are rejected. */
export const SORT_FIELDS = {
  campaigns: ["createdAt", "deadline", "goalAmount", "name", "updatedAt"],
  backers: ["contributedAt", "amount", "backerAddress"],
  audit: ["timestamp", "action", "actor"],
  analytics: ["date", "totalRaised", "backerCount", "campaignCount"],
} as const

export type SortResource = keyof typeof SORT_FIELDS

export const sortDirectionSchema = z.enum(["asc", "desc"])

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(DEFAULT_PAGE),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE, `pageSize cannot exceed ${MAX_PAGE_SIZE}`)
    .default(DEFAULT_PAGE_SIZE),
})

export type PaginationParams = z.infer<typeof paginationSchema>

/** Typed error raised when a sort field is not in the resource allowlist. */
export class InvalidSortFieldError extends Error {
  readonly code = "INVALID_SORT_FIELD"
  constructor(
    readonly resource: SortResource,
    readonly field: string,
  ) {
    super(`Invalid sort field "${field}" for ${resource}`)
    this.name = "InvalidSortFieldError"
  }
}

/**
 * Build a schema that validates pagination plus a resource-scoped sort field
 * and direction. `sortField` defaults to the first allowlisted field.
 */
export function createListQuerySchema<R extends SortResource>(resource: R) {
  const fields = SORT_FIELDS[resource] as readonly string[]
  return paginationSchema.extend({
    sortField: z.enum(fields as [string, ...string[]]).default(fields[0]),
    sortDirection: sortDirectionSchema.default("desc"),
  })
}

export type ListQueryParams<R extends SortResource> = z.infer<
  ReturnType<typeof createListQuerySchema<R>>
>

/**
 * Parse and default list query parameters for a resource. Throws
 * `InvalidSortFieldError` for unknown sort fields and a `ZodError` for other
 * invalid input (e.g. pageSize above the maximum).
 */
export function parseListQuery<R extends SortResource>(
  resource: R,
  input: unknown,
): ListQueryParams<R> {
  const raw = (input ?? {}) as Record<string, unknown>
  const fields = SORT_FIELDS[resource] as readonly string[]
  if (raw.sortField !== undefined && !fields.includes(String(raw.sortField))) {
    throw new InvalidSortFieldError(resource, String(raw.sortField))
  }
  return createListQuerySchema(resource).parse(raw) as ListQueryParams<R>
}

