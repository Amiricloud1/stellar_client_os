import { z } from "zod";
import { isStellarAccount } from "@/lib/admin-auth";
import { CarbonMarketError, type CarbonMarketErrorCode } from "@/services/carbon-credit-market.service";
import {
  apiErrorResponse,
  getRequestId,
  validationErrorResponse,
  type ApiErrorCode,
} from "@/lib/api-errors";

/** Bearer token for the impact oracle that issues credits from verified campaigns. */
export const ISSUER_TOKEN_ENV = "CARBON_MARKET_ADMIN_TOKEN";

export const NO_STORE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

export const stellarAccount = z.string().refine(isStellarAccount, "must be a Stellar account address");

const ERROR_STATUS: Record<CarbonMarketErrorCode, number> = {
  INVALID_INPUT: 400,
  SELF_TRADE: 400,
  NOT_LISTING_OWNER: 403,
  LISTING_NOT_FOUND: 404,
  INSUFFICIENT_CREDITS: 409,
  LISTING_NOT_OPEN: 409,
  INSUFFICIENT_LISTING_QUANTITY: 409,
};

const ERROR_CODE: Record<CarbonMarketErrorCode, ApiErrorCode> = {
  INVALID_INPUT: "VALIDATION_ERROR",
  SELF_TRADE: "VALIDATION_ERROR",
  NOT_LISTING_OWNER: "FORBIDDEN",
  LISTING_NOT_FOUND: "NOT_FOUND",
  INSUFFICIENT_CREDITS: "CONFLICT",
  LISTING_NOT_OPEN: "CONFLICT",
  INSUFFICIENT_LISTING_QUANTITY: "CONFLICT",
};

export function jsonResponse(data: unknown, status = 200, requestId?: string): Response {
  return Response.json(
    { data },
    { status, headers: { ...NO_STORE_HEADERS, ...(requestId ? { "X-Request-Id": requestId } : {}) } },
  );
}

export function badRequest(message: string, requestId?: string): Response {
  return apiErrorResponse({
    code: "VALIDATION_ERROR",
    message,
    status: 400,
    requestId,
  });
}

export function errorResponse(error: unknown, requestId?: string): Response {
  if (error instanceof CarbonMarketError) {
    return apiErrorResponse({
      code: ERROR_CODE[error.code],
      message: error.message,
      status: ERROR_STATUS[error.code],
      requestId,
    });
  }
  return apiErrorResponse({
    code: "INTERNAL_ERROR",
    message: "Carbon credit market request failed",
    status: 500,
    requestId,
  });
}

/** Parses a JSON body against `schema`, returning the data or a 400 response. */
export async function parseBody<T>(
  request: Request,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): Promise<{ data: T } | { response: Response }> {
  const requestId = getRequestId(request);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { response: badRequest("Body must be JSON", requestId) };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      response: validationErrorResponse(parsed.error, {
        message: "Invalid carbon credit payload",
        requestId,
      }),
    };
  }
  return { data: parsed.data };
}
