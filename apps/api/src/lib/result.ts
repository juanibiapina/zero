/**
 * ============================================================================
 * Service Result Handling
 * ============================================================================
 *
 * Shared error type for the service layer.
 *
 * ServiceError is generic over its error codes, so services declare exactly
 * which codes they can return. serviceResult() and serviceError() infer the
 * codes and map them to HTTP status codes, letting Hono verify each status
 * is declared in the route definition — no `as never` needed.
 */

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { Result } from "@praha/byethrow";

const SERVICE_ERRORS = {
  NOT_FOUND: 404,
  NOT_AUTHORIZED: 403,
  INVALID: 400,
} as const;

export type ServiceErrorCode = keyof typeof SERVICE_ERRORS;

export type ServiceError<C extends ServiceErrorCode = ServiceErrorCode> = {
  message: string;
  code: C;
};

export function serviceError<C extends ServiceErrorCode>(
  c: Context,
  error: ServiceError<C>,
) {
  return c.json({ error: error.message }, SERVICE_ERRORS[error.code]);
}

export function serviceResult<T, C extends ServiceErrorCode, S extends ContentfulStatusCode>(
  c: Context,
  result: Result.Result<T, ServiceError<C>>,
  successStatus: S,
) {
  if (Result.isFailure(result)) {
    return c.json({ error: result.error.message }, SERVICE_ERRORS[result.error.code]);
  }
  return c.json(result.value, successStatus);
}
