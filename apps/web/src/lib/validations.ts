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

/**
 * Pre-launch readiness checklist tests (issue #179).
 *
 * These are colocated with the schema so the launch form and the deploy API
 * exercise the exact same rules.
 */
export const campaignReadinessTestFixtures = {
  valid: {
    name: "Reforest the Delta",
    description: "Planting native mangroves across the river delta.",
    network: "testnet" as const,
    token: "native",
    goalAmount: "1000",
    milestones: [
      { order: 1, title: "Site survey", amount: "400" },
      { order: 2, title: "Planting", amount: "600" },
    ],
    payoutTerms: {
      schedule: "milestone" as const,
      recipientAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      feeBps: 100,
      accepted: true as const,
    },
  },
}

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
 * Pre-launch readiness checklist (issue #179).
 *
 * Before a campaign is deployed the creator must supply complete metadata, a
 * supported network, an asset the escrow can actually hold, an ordered set of
 * milestones that sum to the goal, and explicit payout terms. The schema below
 * is the single source of truth shared by the launch form and the deploy API
 * so an incomplete campaign can never reach the contract.
 */

/** Networks the app can deploy campaigns to. */
export const SUPPORTED_NETWORKS = ["testnet", "mainnet", "futurenet"] as const

export type SupportedNetwork = (typeof SUPPORTED_NETWORKS)[number]

/** Payout schedules the escrow contract understands. */
export const PAYOUT_SCHEDULES = ["immediate", "milestone", "linear"] as const

export type PayoutSchedule = (typeof PAYOUT_SCHEDULES)[number]

/** Minimum number of milestones a campaign must declare. */
export const MIN_CAMPAIGN_MILESTONES = 1

/** Maximum number of milestones a campaign may declare. */
export const MAX_CAMPAIGN_MILESTONES = 50

/** Minimum length for the campaign title. */
export const CAMPAIGN_NAME_MIN_LENGTH = 3

/** Maximum length for the campaign title. */
export const CAMPAIGN_NAME_MAX_LENGTH = 120

/** Maximum length for the campaign description. */
export const CAMPAIGN_DESCRIPTION_MAX_LENGTH = 5000

/** Maximum length for a single milestone title. */
export const MILESTONE_TITLE_MAX_LENGTH = 120

/** Maximum length for a single milestone description. */
export const MILESTONE_DESCRIPTION_MAX_LENGTH = 2000

/**
 * A milestone as declared at launch. `order` is 1-based and must be strictly
 * increasing across the list so the contract can release funds in sequence.
 */
export const campaignMilestoneSchema = z
  .object({
    order: z
      .number({ invalid_type_error: "Milestone order must be a number" })
      .int("Milestone order must be an integer")
      .min(1, "Milestone order starts at 1")
      .max(MAX_CAMPAIGN_MILESTONES, `Milestone order cannot exceed ${MAX_CAMPAIGN_MILESTONES}`),
    title: z
      .string()
      .trim()
      .min(1, "Milestone title is required")
      .max(MILESTONE_TITLE_MAX_LENGTH, `Milestone title cannot exceed ${MILESTONE_TITLE_MAX_LENGTH} characters`),
    description: z
      .string()
      .trim()
      .max(
        MILESTONE_DESCRIPTION_MAX_LENGTH,
        `Milestone description cannot exceed ${MILESTONE_DESCRIPTION_MAX_LENGTH} characters`,
      )
      .optional(),
    amount: tokenAmountSchema,
  })
  .strict()

export type CampaignMilestoneInput = z.infer<typeof campaignMilestoneSchema>

/** Payout terms the creator must accept before deployment. */
export const campaignPayoutTermsSchema = z
  .object({
    schedule: z.enum(PAYOUT_SCHEDULES, {
      errorMap: () => ({ message: "Unsupported payout schedule" }),
    }),
    recipientAddress: stellarAddressSchema,
    /** Platform fee in basis points (0–1000 = 0%–10%). */
    feeBps: z
      .number({ invalid_type_error: "Fee must be a number" })
      .int("Fee must be an integer number of basis points")
      .min(0, "Fee cannot be negative")
      .max(1000, "Fee cannot exceed 1000 basis points"),
    /** Creator must explicitly accept the terms before launch. */
    accepted: z.literal(true, {
      errorMap: () => ({ message: "Payout terms must be accepted before launch" }),
    }),
  })
  .strict()

export type CampaignPayoutTerms = z.infer<typeof campaignPayoutTermsSchema>

/**
 * Full readiness payload. Every field is required: a campaign that omits any
 * of them is not launchable and the API must reject it with field-level errors.
 */
export const campaignReadinessSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(CAMPAIGN_NAME_MIN_LENGTH, `Campaign name must be at least ${CAMPAIGN_NAME_MIN_LENGTH} characters`)
      .max(CAMPAIGN_NAME_MAX_LENGTH, `Campaign name cannot exceed ${CAMPAIGN_NAME_MAX_LENGTH} characters`),
    description: z
      .string()
      .trim()
      .min(1, "Description is required")
      .max(
        CAMPAIGN_DESCRIPTION_MAX_LENGTH,
        `Description cannot exceed ${CAMPAIGN_DESCRIPTION_MAX_LENGTH} characters`,
      ),
    network: z.enum(SUPPORTED_NETWORKS, {
      errorMap: () => ({ message: "Unsupported network" }),
    }),
    token: z
      .string()
      .min(1, "Token selection is required")
      .refine(
        (val) => val === "native" || validateContractId(val),
        "Invalid token: must be 'native' or a valid Stellar contract ID",
      )
      .refine(
        (val) =>
          CONFIGURED_ESCROW_TOKENS.some(
            (configured) => configured.value === val || configured.address === val,
          ),
        "Token is not supported by the escrow contract",
      ),
    goalAmount: tokenAmountSchema,
    milestones: z
      .array(campaignMilestoneSchema)
      .min(MIN_CAMPAIGN_MILESTONES, `At least ${MIN_CAMPAIGN_MILESTONES} milestone is required`)
      .max(MAX_CAMPAIGN_MILESTONES, `Cannot declare more than ${MAX_CAMPAIGN_MILESTONES} milestones`),
    payoutTerms: campaignPayoutTermsSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    // Milestone ordering: `order` must be 1..n with no gaps or duplicates.
    value.milestones.forEach((milestone, index) => {
      if (milestone.order !== index + 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["milestones", index, "order"],
          message: `Milestone order must be ${index + 1} (sequential, no gaps or duplicates)`,
        })
      }
    })

    // Milestone amounts must sum exactly to the campaign goal.
    const sum = value.milestones.reduce((acc, milestone) => {
      const parsed = Number(milestone.amount)
      return Number.isFinite(parsed) ? acc + parsed : acc
    }, 0)
    const goal = Number(value.goalAmount)
    if (Number.isFinite(goal) && Math.abs(sum - goal) > 1e-7) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["milestones"],
        message: "Milestone amounts must sum to the campaign goal",
      })
    }
  })

export type CampaignReadinessInput = z.infer<typeof campaignReadinessSchema>

/** A single readiness failure surfaced to the creator/operator. */
export interface CampaignReadinessIssue {
  path: string
  message: string
}

/** Result of evaluating a campaign against the readiness checklist. */
export interface CampaignReadinessResult {
  ready: boolean
  issues: CampaignReadinessIssue[]
}

/**
 * Evaluate a campaign payload against the readiness checklist without throwing.
 * Returns every failure so the UI can render a complete checklist rather than
 * stopping at the first error.
 */
export function checkCampaignReadiness(input: unknown): CampaignReadinessResult {
  const parsed = campaignReadinessSchema.safeParse(input)
  if (parsed.success) return { ready: true, issues: [] }
  return {
    ready: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  }
}

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

/**
 * Shared Campaign Form & Cross-Field Validation Schema (Issues #163, #240, #242, #253)
 * Keeps immediate client feedback synchronized with authoritative server-side rules.
 */
export const campaignFormValidationSchema = z
  .object({
    title: z.string().trim().min(3, "Title must be at least 3 characters").max(100, "Title cannot exceed 100 characters"),
    description: z.string().trim().min(10, "Description must be at least 10 characters").max(2000, "Description cannot exceed 2000 characters"),
    targetAmount: tokenAmountSchema,
    minTarget: tokenAmountSchema,
    costPerTree: z.number().positive("Cost per tree must be greater than zero"),
    targetTrees: z.number().int().positive("Target trees count must be positive"),
    startTime: z.number().int().positive("Start time must be a valid timestamp"),
    deadline: z.number().int().positive("Deadline must be a valid timestamp"),
    treeType: z.string().min(1, "Tree type is required"),
    region: z.string().min(1, "Region is required"),
  })
  .refine(
    (data) => {
      const target = parseFloat(data.targetAmount);
      const min = parseFloat(data.minTarget);
      return !isNaN(target) && !isNaN(min) && min <= target;
    },
    {
      message: "Minimum target cannot exceed total campaign target amount",
      path: ["minTarget"],
    }
  )
  .refine(
    (data) => data.deadline > data.startTime,
    {
      message: "Campaign deadline must be later than start time",
      path: ["deadline"],
    }
  )
  .refine(
    (data) => {
      const target = parseFloat(data.targetAmount);
      return !isNaN(target) && (data.costPerTree * data.targetTrees) <= target;
    },
    {
      message: "Target trees multiplied by cost per tree cannot exceed total target amount",
      path: ["targetTrees"],
    }
  );

export type CampaignFormValues = z.infer<typeof campaignFormValidationSchema>;

/**
 * Validates campaign form fields for real-time client feedback using the identical
 * authoritative server-side cross-field validation rules.
 */
export function validateCampaignFormRealtime(values: unknown): {
  valid: boolean;
  errors: Record<string, string>;
} {
  const result = campaignFormValidationSchema.safeParse(values);
  if (result.success) {
    return { valid: true, errors: {} };
  }

  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path[0] ? String(issue.path[0]) : "form";
    if (!errors[key]) {
      errors[key] = issue.message;
    }
  }

  return { valid: false, errors };
}


